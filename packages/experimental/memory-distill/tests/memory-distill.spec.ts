import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as KnowledgeInvariant from '@deepseek-ai/dsh-experimental-knowledge/invariant'
import WikiFilesystemKnowledge from '@deepseek-ai/dsh-experimental-knowledge-wiki-filesystem'
import * as VerifierGate from '@deepseek-ai/dsh-experimental-verifier-gate'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ShellExecRequest, ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as MemoryDistill from '../src/index.ts'
import { ORDER_WARNING } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const ASSUMPTION = 'a verified turn is worth remembering as an episode'
const WRITE_THEN_REPLY: StreamChunk[][] = [
  toolCallResponse('w1', 'write', { file_path: 'src/retry.ts', content: 'export const attempts = 3\n' }),
  textResponse('Added retry with three attempts. For now, lint is skipped.'),
]

/** Scripted shell: exit codes in order, then 0. */
function shell(exitCodes: number[]): VerifierGate.VerifyShell {
  return {
    resolve: (request: ShellExecRequest): ShellExecSpec => ({ command: request.command, workdir: '/tmp', timeoutMs: request.timeoutMs ?? 1000, onExpiry: 'kill', stdoutMaxBytes: 65536, sandboxPolicy: undefined }),
    execute: (spec: ShellExecSpec) => {
      const exitCode = exitCodes.shift() ?? 0
      const result: ShellRunResult = {
        exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
        stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
      }
      return Promise.resolve({ result: () => Promise.resolve(result) })
    },
  }
}

interface Options {
  distill?: Config
  gate?: 'first' | 'after' | 'none'
  gateMode?: 'shadow' | 'enforce'
  exitCodes?: number[]
  responses?: StreamChunk[][]
  extra?: (ctx: Context) => void
}

const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Ran {
  ctx: Context
  agent: Agent
  dir: string
  /** Formats passed to ctx.logger.warn. */
  warnings: unknown[]
}

async function run(options: Options = {}): Promise<Ran> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-30T10:00:00.000Z'))
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-distill-'))
  dirs.push(dir)
  mkdirSync(dirname(join(dir, 'knowledge/concepts/x.md')), { recursive: true })
  writeFileSync(join(dir, 'knowledge/concepts/x.md'), '---\ntype: concept\n---\n')
  const ctx = new Context()
  const warnings: unknown[] = []
  vi.spyOn(ctx.logger, 'warn').mockImplementation((format: unknown) => {
    warnings.push(format)
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  // Every applied knowledge/write these tests produce must cite a successful tool/result of its session.
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(KnowledgeInvariant)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)
  await ctx.plugin(WikiFilesystemKnowledge, {})
  ctx.provide('shell', shell(options.exitCodes ?? [0]))
  const gate = options.gate ?? 'first'
  const gateConfig = { mode: options.gateMode ?? 'shadow', assumption: 'the model declares done before tests pass', verify: { commands: ['pnpm test'] } }
  if (gate === 'first') await ctx.plugin(VerifierGate, gateConfig)
  await ctx.plugin(MemoryDistill, options.distill ?? { mode: 'enforce', assumption: ASSUMPTION })
  if (gate === 'after') await ctx.plugin(VerifierGate, gateConfig)
  options.extra?.(ctx)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([...options.responses ?? WRITE_THEN_REPLY]))
  const agent = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Add retry to the client' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return { ctx, agent, dir, warnings }
}

function writes(agent: Agent) {
  return agent.session.snapshotEvents().flatMap(event => (event.type === 'knowledge/write' ? [event.data] : []))
}

function resultSeq(agent: Agent): number {
  const event = agent.session.snapshotEvents().find(entry => entry.type === 'tool/result')
  return event?.seq ?? -1
}

const PAGE = 'knowledge/episodes/2026-09-30-lead-t1.md'

describe('memory-distill', () => {
  it('writes an episode after the verifier gate records ok, citing the changing tool result', async () => {
    const { agent, dir } = await run()
    expect(writes(agent)).toEqual([{
      id: 'episodes/2026-09-30-lead-t1.md', writer: 'distill', mode: 'enforce', applied: true, operation: 'create', stale: [],
      sourceEventSeqs: [resultSeq(agent)], sources: ['src/retry.ts'],
    }])
    const text = readFileSync(join(dir, PAGE), 'utf8')
    expect(text).toContain('type: "episode"')
    expect(text).toContain('title: "Turn 1: Add retry to the client"')
    expect(text).toContain('Added retry with three attempts.')
    expect(text).not.toContain('For now')
    expect(text).toContain('- `src/retry.ts`')
    expect(text).toMatch(/The verifier gate recorded verdict ok at session event \d+\./)
  })

  it('records without writing in shadow mode', async () => {
    const { agent, dir } = await run({ distill: { mode: 'shadow', assumption: ASSUMPTION } })
    expect(writes(agent)).toEqual([expect.objectContaining({ mode: 'shadow', applied: false })])
    expect(existsSync(join(dir, PAGE))).toBe(false)
  })

  it('writes nothing after a failed verify command or without a gate', async () => {
    const failed = await run({ exitCodes: [1] })
    expect(writes(failed.agent)).toEqual([])
    const ungated = await run({ gate: 'none' })
    expect(writes(ungated.agent)).toEqual([])
  })

  it('distills without a verdict when requireVerdict is off, once per turn', async () => {
    let steered = false
    const { agent, dir } = await run({
      gate: 'none',
      distill: { mode: 'enforce', assumption: ASSUMPTION, requireVerdict: false },
      responses: [...WRITE_THEN_REPLY, textResponse('Still done.')],
      extra: (ctx) => {
        ctx.on('agent/turn-stopping', ({ agent: stopping }) => {
          if (steered) return
          steered = true
          stopping.steer(createUserMessage({ content: [{ type: 'text', text: 'confirm' }], source: { kind: 'user' } }))
        })
      },
    })
    expect(writes(agent)).toHaveLength(1)
    expect(readFileSync(join(dir, PAGE), 'utf8')).toContain('No verifier verdict was recorded for this turn.')
  })

  it('writes nothing for a turn that changed no file', async () => {
    const { agent } = await run({ responses: [textResponse('Nothing to change.')] })
    expect(writes(agent)).toEqual([])
  })

  it('warns once per session when the gate judges turns after it', async () => {
    const { agent, warnings } = await run({
      gate: 'after',
      responses: [...WRITE_THEN_REPLY, toolCallResponse('w2', 'write', { file_path: 'src/retry.ts', content: 'export const attempts = 4\n' }), textResponse('Raised attempts.')],
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Raise attempts' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(writes(agent)).toEqual([])
    expect(warnings.filter(format => format === ORDER_WARNING)).toHaveLength(1)
  })

  it('keeps exactly maxEpisodes slot pages and replaces the least recently updated one', async () => {
    const turn = (n: number): StreamChunk[][] => [
      toolCallResponse(`w${n}`, 'write', { file_path: 'src/retry.ts', content: `export const attempts = ${n}\n` }),
      textResponse(`Set attempts to ${n}.`),
    ]
    const { agent, dir } = await run({ distill: { mode: 'enforce', assumption: ASSUMPTION, maxEpisodes: 2 }, responses: [...turn(1), ...turn(2), ...turn(3)] })
    for (const [hour, text] of [[11, 'Second change'], [12, 'Third change']] as const) {
      vi.setSystemTime(new Date(`2026-09-30T${hour}:00:00.000Z`))
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    expect(writes(agent).map(record => [record.id, record.operation])).toEqual([
      ['episodes/slot-1.md', 'create'], ['episodes/slot-2.md', 'create'], ['episodes/slot-1.md', 'update'],
    ])
    expect(readFileSync(join(dir, 'knowledge/episodes/slot-1.md'), 'utf8')).toContain('title: "Turn 3: Third change"')
    expect(readFileSync(join(dir, 'knowledge/episodes/slot-2.md'), 'utf8')).toContain('title: "Turn 2: Second change"')
    expect(existsSync(join(dir, 'knowledge/episodes/slot-3.md'))).toBe(false)
    expect(existsSync(join(dir, PAGE))).toBe(false)
  })

  it('names the slot it would write in shadow mode without writing', async () => {
    const { agent, dir } = await run({ distill: { mode: 'shadow', assumption: ASSUMPTION, maxEpisodes: 1 } })
    expect(writes(agent)).toEqual([expect.objectContaining({ id: 'episodes/slot-1.md', mode: 'shadow', applied: false })])
    expect(existsSync(join(dir, 'knowledge/episodes/slot-1.md'))).toBe(false)
  })

  it('records a write the store refuses', async () => {
    const { agent } = await run({ distill: { mode: 'enforce', assumption: ASSUMPTION, dir: 'notes' } })
    expect(writes(agent)).toEqual([expect.objectContaining({ applied: false })])
    expect(writes(agent)[0]?.refusal?.rule).toBe('layout')
  })

  it('registers nothing in off mode', async () => {
    const { ctx, agent } = await run({ distill: { mode: 'off' } })
    expect(ctx.sessionProjections.stateOf(agent.session, 'memoryDistill')).toBeUndefined()
    expect(writes(agent)).toEqual([])
  })

  it.each([
    [{ mode: 'enforce' as const, assumption: ' ' }, 'assumption must state'],
    [{ mode: 'enforce' as const, assumption: ASSUMPTION, dir: 'a/b' }, 'dir must be one path segment'],
    [{ mode: 'enforce' as const, assumption: ASSUMPTION, changeTools: [] }, 'changeTools must name at least one tool'],
    [{ mode: 'enforce' as const, assumption: ASSUMPTION, maxOutcomeChars: 0 }, 'maxOutcomeChars must be a positive integer'],
    [{ mode: 'enforce' as const, assumption: ASSUMPTION, transientMarkers: [''] }, 'transientMarkers entries must not be blank'],
    [{ mode: 'enforce' as const, assumption: ASSUMPTION, maxEpisodes: -1 }, 'maxEpisodes must be an integer >= 0'],
  ])('fails loud on invalid configuration %#', async (config, message) => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(WikiFilesystemKnowledge, {})
    await expect(ctx.plugin(MemoryDistill, config)).rejects.toThrow(message)
  })
})
