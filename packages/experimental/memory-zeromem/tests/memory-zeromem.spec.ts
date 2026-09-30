import { mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import * as MemoryZeromem from '../src/index.ts'
import { FALLBACK_EMBEDDER_WARNING, MEMORY_FORGET_SESSION_DESCRIPTION, MEMORY_STATS_DESCRIPTION, memoryRecallDescription, resolveStore, resolveZm, ZeromemExecutableError, ZM_PATH_ENV } from '../src/index.ts'
import { boot, cleanup, FAKE_ZM, flush, results, spooled, tempRoot, turn, workspaceHome, zmCalls } from './harness.ts'
import type { Booted } from './harness.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'

afterEach(cleanup)

const RECALL_WORKSPACE = 'Search what the user and you said in earlier sessions in this workspace. Returns the most relevant stored turns, each with its session id, time, speaker (user or assistant), text, and kind: match answers the query, context is linked to a match. Only user messages and final assistant replies are stored, never tool calls or tool output; the current session is left out. Recalled text records what was said then: verify it against the current files before relying on it.'
const RECALL_GLOBAL_INCLUDED = 'Search what the user and you said in earlier sessions in any workspace. Returns the most relevant stored turns, each with its session id, time, speaker (user or assistant), text, and kind: match answers the query, context is linked to a match. Only user messages and final assistant replies are stored, never tool calls or tool output; the current session is included. Recalled text records what was said then: verify it against the current files before relying on it.'
const STATS = 'Count the stored turns and sessions that memory_recall searches.'
const FORGET = 'Permanently delete every stored turn of one earlier session, named by the session id memory_recall returned. Use only when the user asks to forget that session; the user approves every deletion. The current session cannot be deleted, and later turns of a deleted session are not stored.'

/** One text-only turn in which the model answers with `reply`. */
async function chat(booted: Booted, sessionId: string, text: string, reply: string, meta?: { cwd?: string }): Promise<void> {
  await turn(booted, sessionId, text, [textResponse(reply)], meta)
}

/** A session in which the model calls one tool and then replies `done`. */
async function callTool(booted: Booted, sessionId: string, name: string, args: object, meta?: { cwd?: string }) {
  return turn(booted, sessionId, `please run ${name}`, [toolCallResponse('c1', name, args), textResponse('done')], meta)
}

/** The value of the first tool result, parsed. */
function firstValue(agent: Awaited<ReturnType<typeof callTool>>): unknown {
  const [result] = results(agent)
  expect(result?.isError).toBe(false)
  return JSON.parse(result!.text)
}

/** The first tool result of a session is an error whose text matches. */
function expectToolError(agent: Awaited<ReturnType<typeof callTool>>, text: string | RegExp): void {
  const [result] = results(agent)
  expect(result?.isError).toBe(true)
  expect(result?.text).toMatch(text)
}

/** Append one complete turn to a session without an agent. */
function appendTurn(session: Session, turnNumber: number, text: string, reply: string): void {
  session.append('turn/start', { turn: turnNumber })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: turnNumber,
    step: 1,
    message: { id: MessageId(`m${turnNumber}`), role: 'assistant', content: [{ type: 'text', text: reply }], source: { kind: 'model', provider: 'mock', model: 'mock' } },
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: turnNumber, reason: { kind: 'completed' } })
}

describe('memory-zeromem tools', () => {
  it('offers memory_recall and memory_stats with the pinned descriptions, and no forget tool by default', async () => {
    const booted = await boot()
    const adapter = new MockAdapter([textResponse('hi')])
    booted.ctx.llm.registerAdapter(['probe'], adapter)
    const agent = await booted.ctx.agentLoop.create(SessionId('probe'), { provider: 'probe', model: 'mock' }, { cwd: booted.workspace })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const tools = adapter.requests[0]!.tools!.filter(tool => tool.name.startsWith('memory_'))
    expect(tools.map(tool => [tool.name, tool.description])).toEqual([
      ['memory_recall', RECALL_WORKSPACE],
      ['memory_stats', STATS],
    ])
    expect(tools[0]!.parameters).toMatchObject({
      properties: {
        query: { type: 'string', description: 'Words or a question about the earlier conversation.' },
        limit: { type: 'integer', description: 'Most turns to return, 1 to 10 (default 5).' },
      },
      required: ['query'],
    })
  })

  it('presents each call as a generic card', async () => {
    const booted = await boot({ config: { allowForget: true } })
    const view = (name: string, args: object) => booted.ctx.tools.get(name)?.presentCall?.(args)
    expect(view('memory_recall', { query: 'retry policy' })).toEqual({ card: 'generic', title: 'Recall earlier sessions: retry policy', kind: 'search' })
    expect(view('memory_stats', {})).toEqual({ card: 'generic', title: 'Count stored sessions', kind: 'read' })
    expect(view('memory_forget_session', { session: 'old' })).toEqual({ card: 'generic', title: 'Forget stored session old', kind: 'delete' })
  })

  it('runs at most maxConcurrent zm processes and queues the rest', async () => {
    const booted = await boot({ config: { maxConcurrent: 1 } })
    const both = [...toolCallResponse('c1', 'memory_stats', {}), ...toolCallResponse('c2', 'memory_stats', {})]
      .filter(chunk => chunk.type !== 'finish' && chunk.type !== 'usage')
      .map((chunk, position) => ('index' in chunk ? { ...chunk, index: position < 4 ? 0 : 1 } : chunk))
    const agent = await turn(booted, 'pair', 'count twice', [[...both, { type: 'finish', reason: { kind: 'tool-calls' } }], textResponse('done')])
    expect(results(agent)).toEqual([
      { isError: false, text: '{"turns":0,"sessions":0}' },
      { isError: false, text: '{"turns":0,"sessions":0}' },
    ])
    expect(zmCalls(workspaceHome(booted))).toHaveLength(2)
  })

  it('pins the description variants and the forget text', () => {
    expect(memoryRecallDescription('workspace', true)).toBe(RECALL_WORKSPACE)
    expect(memoryRecallDescription('global', false)).toBe(RECALL_GLOBAL_INCLUDED)
    expect(MEMORY_STATS_DESCRIPTION).toBe(STATS)
    expect(MEMORY_FORGET_SESSION_DESCRIPTION).toBe(FORGET)
  })

  it('recalls earlier sessions of the workspace with session id and time, leaving the current session out', async () => {
    const booted = await boot()
    await chat(booted, 'billing-1', 'We chose Postgres 16 for the billing service.', 'Noted: billing runs on Postgres 16 with pgbouncer.')
    const agent = await callTool(booted, 'billing-2', 'memory_recall', { query: 'which postgres does billing use' })
    const value = firstValue(agent) as { turns: { session: string; time: string; speaker: string; text: string; kind: string }[] }
    expect(value.turns.map(entry => [entry.session, entry.speaker, entry.text, entry.kind])).toEqual([
      ['billing-1', 'user', 'We chose Postgres 16 for the billing service.', 'match'],
      ['billing-1', 'assistant', 'Noted: billing runs on Postgres 16 with pgbouncer.', 'context'],
    ])
    for (const entry of value.turns) expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    const home = workspaceHome(booted)
    const calls = zmCalls(home)
    expect(calls.at(-1)).toEqual({ argv: ['--no-model', 'mcp', '--home', home], cwd: realpathSync(home) })
  })

  it('includes the current session when excludeCurrentSession is false', async () => {
    const booted = await boot({ config: { excludeCurrentSession: false } })
    await chat(booted, 'self', 'The deploy window is Friday.', 'Friday it is.')
    const agent = await callTool(booted, 'self', 'memory_recall', { query: 'deploy window friday' })
    expect((firstValue(agent) as { turns: { session: string }[] }).turns.map(entry => entry.session)).toContain('self')
  })

  it('cuts recalled text to maxTurnChars and marks it truncated', async () => {
    const booted = await boot({ config: { maxTurnChars: 12 } })
    await chat(booted, 'long-1', 'Retry budget is seven attempts for uploads.', 'ok')
    const agent = await callTool(booted, 'long-2', 'memory_recall', { query: 'retry budget uploads', limit: 1 })
    expect(firstValue(agent)).toEqual({ turns: [expect.objectContaining({ text: 'Retry budget', truncated: true })] })
  })

  it('refuses a limit outside the configured range and a blank query', async () => {
    const booted = await boot()
    const high = await callTool(booted, 'limits', 'memory_recall', { query: 'x', limit: 11 })
    expectToolError(high, 'memory_recall: limit must be between 1 and 10')
    const blank = await callTool(booted, 'blank', 'memory_recall', { query: '   ' })
    expectToolError(blank, 'memory_recall: query must name what to look for')
  })

  it('counts stored turns and sessions with memory_stats', async () => {
    const booted = await boot()
    await chat(booted, 'count-1', 'first message', 'first reply')
    const agent = await callTool(booted, 'count-2', 'memory_stats', {})
    // count-2's own request is spooled only when its turn ends, after the call.
    expect(firstValue(agent)).toEqual({ turns: 2, sessions: 1 })
  })

  it('keeps workspaces apart in the workspace scope and shares one store in the global scope', async () => {
    const separate = await boot()
    const other = join(separate.root, 'other')
    mkdirSync(other)
    await chat(separate, 'ws-a', 'Kafka topic is orders-v2.', 'ok')
    const isolated = await callTool(separate, 'ws-b', 'memory_recall', { query: 'kafka topic orders' }, { cwd: other })
    expect(firstValue(isolated)).toEqual({ turns: [] })

    const shared = await boot({ config: { scope: 'global' } })
    const elsewhere = join(shared.root, 'elsewhere')
    mkdirSync(elsewhere)
    await chat(shared, 'g-a', 'Kafka topic is orders-v2.', 'ok')
    const global = await callTool(shared, 'g-b', 'memory_recall', { query: 'kafka topic orders' }, { cwd: elsewhere })
    expect((firstValue(global) as { turns: { session: string }[] }).turns.map(entry => entry.session)).toEqual(['g-a'])
    expect(resolveStore({ scope: 'global', storeRoot: shared.storeRoot, cwd: undefined }).home).toBe(join(shared.storeRoot, 'global'))
  })

  it('logs the fallback embedder warning once, and not when the hash embedder was configured', async () => {
    const booted = await boot({ mode: 'fallback', config: { embedder: 'default' } })
    await callTool(booted, 'fb-1', 'memory_stats', {})
    await callTool(booted, 'fb-2', 'memory_recall', { query: 'anything at all' })
    expect(booted.warnings.filter(warning => warning === FALLBACK_EMBEDDER_WARNING)).toHaveLength(1)
    expect(zmCalls(workspaceHome(booted)).every(call => !call.argv.includes('--no-model'))).toBe(true)

    const hashed = await boot()
    await callTool(hashed, 'h-1', 'memory_stats', {})
    await callTool(hashed, 'h-2', 'memory_recall', { query: 'anything' })
    expect(hashed.warnings).not.toContain(FALLBACK_EMBEDDER_WARNING)
  })

  it('reports a failing zm as a named tool error with its stderr', async () => {
    const booted = await boot({ mode: 'exit' })
    const agent = await callTool(booted, 'broken', 'memory_recall', { query: 'anything' })
    expectToolError(agent, /exited with code 3; zm stderr: zm: database is locked/)
  })

  it('reports a store that needs a working directory the session does not have', async () => {
    const booted = await boot()
    const agent = await callTool(booted, 'no-cwd', 'memory_recall', { query: 'anything' }, {})
    expectToolError(agent, 'this conversation has no workspace directory')
  })
})

describe('memory-zeromem ingestion', () => {
  it('spools the user message and the final reply of a completed turn, never tool calls or output', async () => {
    const booted = await boot()
    await turn(booted, 'ingest', 'Remember that staging uses port 8443.', [
      toolCallResponse('c1', 'memory_stats', {}, 'Let me check memory first.'),
      textResponse('Staging uses port 8443.'),
    ])
    await flush(booted)
    const home = workspaceHome(booted)
    const turns = spooled(home)
    expect(turns.map(entry => [entry.session_id, entry.speaker, entry.text])).toEqual([
      ['ingest', 'user', 'Remember that staging uses port 8443.'],
      ['ingest', 'assistant', 'Staging uses port 8443.'],
    ])
    for (const entry of turns) {
      expect(entry.uuid).toMatch(/^dsh:ingest:\d+$/)
      expect(Number.isSafeInteger(entry.ts) && entry.ts < 1e11).toBe(true)
    }
    expect(JSON.stringify(turns)).not.toContain('"turns"')
    if (process.platform !== 'win32') expect(statSync(join(home, 'spool')).mode & 0o777).toBe(0o700)
  })

  it('stores a resumed session once: the next turn re-spools the last turn and zm drops the duplicate', async () => {
    const booted = await boot()
    await chat(booted, 'resume', 'The cache TTL is 90 seconds.', 'Noted.')
    // A new plugin instance has no memory of what the previous one spooled, like a restarted process.
    await booted.fiber.dispose()
    const again = await booted.ctx.plugin(MemoryZeromem, {
      zmPath: process.execPath,
      zmArgs: [FAKE_ZM],
      embedder: 'hash',
      storeRoot: booted.storeRoot,
    })
    await chat(booted, 'resume', 'And the queue depth limit is 500.', 'Noted too.')
    await again.dispose()
    const home = workspaceHome(booted)
    expect(spooled(home).map(entry => entry.text)).toEqual([
      'The cache TTL is 90 seconds.', 'Noted.',
      'The cache TTL is 90 seconds.', 'Noted.',
      'And the queue depth limit is 500.', 'Noted too.',
    ])
    const third = await booted.ctx.plugin(MemoryZeromem, { zmPath: process.execPath, zmArgs: [FAKE_ZM], embedder: 'hash', storeRoot: booted.storeRoot })
    const stats = await callTool(booted, 'resume-stats', 'memory_stats', {})
    expect(firstValue(stats)).toEqual({ turns: 4, sessions: 1 })
    await third.dispose()
  })

  it('retries a turn whose spool write failed at the next turn boundary', async () => {
    const booted = await boot()
    const home = workspaceHome(booted)
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'spool'), 'not a directory')
    await chat(booted, 'retry', 'First fact: region is eu-west-1.', 'ok')
    await vi.waitFor(() => { expect(booted.warnings).toContain('memory-zeromem: could not store turn 1 of session retry') })
    rmSync(join(home, 'spool'))
    await chat(booted, 'retry', 'Second fact: zone is b.', 'ok too')
    await flush(booted)
    expect(spooled(home).map(entry => entry.text)).toEqual(['First fact: region is eu-west-1.', 'ok', 'Second fact: zone is b.', 'ok too'])
  })

  it('stores nothing for subagent sessions unless configured, and warns once for a session without a working directory', async () => {
    const booted = await boot()
    const child = booted.ctx.sessions.create(SessionId('child'), { meta: { origin: 'subagent', cwd: booted.workspace } })
    appendTurn(child, 1, 'child task text', 'child reply')
    const loose = booted.ctx.sessions.create(SessionId('loose'))
    appendTurn(loose, 1, 'no cwd one', 'reply one')
    appendTurn(loose, 2, 'no cwd two', 'reply two')
    await flush(booted)
    expect(spooled(workspaceHome(booted))).toEqual([])
    expect(booted.warnings.filter(warning => String(warning).includes('session loose has no working directory'))).toHaveLength(1)

    const withChildren = await boot({ config: { ingestSubagentSessions: true } })
    const stored = withChildren.ctx.sessions.create(SessionId('child-2'), { meta: { origin: 'subagent', cwd: withChildren.workspace } })
    appendTurn(stored, 1, 'child task text', 'child reply')
    await flush(withChildren)
    expect(spooled(workspaceHome(withChildren)).map(entry => entry.session_id)).toEqual(['child-2', 'child-2'])
  })

  it('skips a turn with no stored text and one it already spooled', async () => {
    const booted = await boot()
    const session = booted.ctx.sessions.create(SessionId('quiet'), { meta: { cwd: booted.workspace } })
    appendTurn(session, 1, '   ', '')
    session.append('turn/start', { turn: 2 })
    await flush(booted)
    expect(spooled(workspaceHome(booted))).toEqual([])
  })

  it('stops ingesting once unloaded', async () => {
    const booted = await boot()
    await booted.fiber.dispose()
    expect(booted.ctx.tools.get('memory_recall')).toBeUndefined()
    await chat(booted, 'after', 'unseen text', 'unseen reply')
    expect(spooled(workspaceHome(booted))).toEqual([])
  })
})

describe('memory_forget_session', () => {
  it('asks the user, deletes an earlier session, and never stores it again', async () => {
    const booted = await boot({ config: { allowForget: true }, approval: 'allowed-once' })
    await chat(booted, 'old', 'My API token lives in vault path secret/app.', 'ok')
    const agent = await callTool(booted, 'now', 'memory_forget_session', { session: 'old' })
    expect(firstValue(agent)).toEqual({ session: 'old', deletedTurns: 2 })
    const asked = agent.session.snapshotEvents().find(event => event.type === 'approval/asked')
    expect(asked).toBeDefined()
    await chat(booted, 'old', 'one more thing about the vault', 'ok')
    const stats = await callTool(booted, 'later', 'memory_stats', {})
    // Only the forget turn of `now` remains; `old` was deleted and its later turn was not stored.
    expect(firstValue(stats)).toEqual({ turns: 2, sessions: 1 })
  })

  it('refuses the current session and a rejected approval', async () => {
    const booted = await boot({ config: { allowForget: true }, approval: 'allowed-once' })
    const self = await callTool(booted, 'self', 'memory_forget_session', { session: 'self' })
    expectToolError(self, 'memory_forget_session: the current session cannot be deleted')
    const unnamed = await callTool(booted, 'unnamed', 'memory_forget_session', {})
    expect(results(unnamed)[0]?.isError).toBe(true)
    const blank = await callTool(booted, 'blank', 'memory_forget_session', { session: ' ' })
    expectToolError(blank, 'session must be a session id')

    const rejecting = await boot({ config: { allowForget: true }, approval: 'rejected' })
    await chat(rejecting, 'keep', 'keep this', 'kept')
    const refused = await callTool(rejecting, 'try', 'memory_forget_session', { session: 'keep' })
    expect(results(refused)[0]?.isError).toBe(true)
    expect(zmCalls(workspaceHome(rejecting))).toEqual([])
  })

  it('passes other tools through the approval listener unchanged', async () => {
    const booted = await boot({ config: { allowForget: true } })
    const agent = await callTool(booted, 'plain', 'memory_stats', {})
    expect(results(agent)[0]?.isError).toBe(false)
  })
})

describe('memory-zeromem load', () => {
  async function load(config: MemoryZeromem.Config): Promise<unknown> {
    const { root } = tempRoot()
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalSubprocessRuntime)
    try {
      await ctx.plugin(MemoryZeromem, Object.assign({ storeRoot: join(root, 'stores') }, config))
      return undefined
    } catch (error) {
      return error
    } finally {
      await ctx.fiber.dispose()
    }
  }

  it('fails with a named error naming zmPath when the configured zm cannot be found', async () => {
    const error = await load({ zmPath: 'zm-that-does-not-exist-anywhere' })
    expect(error).toBeInstanceOf(ZeromemExecutableError)
    expect(String(error)).toContain('the zm executable zm-that-does-not-exist-anywhere set by zmPath was not found; build zeromem')
  })

  it('fails with a named error naming DSH_ZEROMEM_ZM when its zm is missing', async () => {
    const { root } = tempRoot()
    vi.stubEnv(ZM_PATH_ENV, join(root, 'missing', 'zm'))
    const error = await load({})
    expect(error).toBeInstanceOf(ZeromemExecutableError)
    expect(String(error)).toContain(`the zm executable ${join(root, 'missing', 'zm')} named by DSH_ZEROMEM_ZM is not an absolute path to an existing file`)
  })

  it('fails with a named error when neither setting is present and PATH has no zm', async () => {
    vi.stubEnv(ZM_PATH_ENV, '')
    vi.stubEnv('PATH', tempRoot().root)
    const error = await load({})
    expect(error).toBeInstanceOf(ZeromemExecutableError)
    expect(String(error)).toContain('no zm executable is on PATH, and neither zmPath nor DSH_ZEROMEM_ZM is set')
  })

  it('runs the zm that DSH_ZEROMEM_ZM names when zmPath is empty', async () => {
    vi.stubEnv(ZM_PATH_ENV, process.execPath)
    const booted = await boot({ config: { zmPath: '' } })
    const agent = await callTool(booted, 'env', 'memory_stats', {})
    expect(firstValue(agent)).toEqual({ turns: 0, sessions: 0 })
    expect(zmCalls(workspaceHome(booted))).toHaveLength(1)
  })

  it('fails on a relative store root and a default above the largest limit', async () => {
    expect(String(await load({ zmPath: process.execPath, storeRoot: 'relative/stores' }))).toContain('storeRoot must be an absolute path')
    expect(String(await load({ zmPath: process.execPath, defaultResults: 11 }))).toContain('defaultResults must not exceed maxResults')
  })
})

describe('resolveZm', () => {
  it('prefers a configured zmPath over DSH_ZEROMEM_ZM and PATH', () => {
    expect(resolveZm({ zmPath: '/opt/zm', environment: '/bundle/zm' })).toEqual({ zmPath: '/opt/zm', source: 'config' })
    expect(resolveZm({ zmPath: 'zm-custom', environment: undefined })).toEqual({ zmPath: 'zm-custom', source: 'config' })
  })

  it('selects DSH_ZEROMEM_ZM when zmPath is empty', () => {
    expect(resolveZm({ zmPath: '', environment: '/bundle/zm' })).toEqual({ zmPath: '/bundle/zm', source: 'environment' })
  })

  it('falls back to zm on PATH when neither is set', () => {
    expect(resolveZm({ zmPath: '', environment: undefined })).toEqual({ zmPath: 'zm', source: 'path' })
    expect(resolveZm({ zmPath: '', environment: '' })).toEqual({ zmPath: 'zm', source: 'path' })
  })

  it('refuses a relative DSH_ZEROMEM_ZM', () => {
    expect(() => resolveZm({ zmPath: '', environment: 'bin/zm' })).toThrow(ZeromemExecutableError)
  })
})
