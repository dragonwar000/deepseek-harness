/**
 * The route stays dormant until a Claude AI Account has a default, withdraws when that default or
 * the provider itself goes, and never displaces a provider the composition declared for itself.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmProviderInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { AiAccountId } from '@deepseek-ai/dsh-ai-account/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Route from '../src/index.ts'
import { FakeAiAccount, FakeCli, FakeSubprocessRuntime, SIGNED_OUT_RUN, streamLines } from './harness.ts'
import type { FakeAccountState, FakeCliScript } from './harness.ts'

const contexts: Context[] = []
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-claude-cli-plugin-'))
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** An adapter a composition might declare for the same provider id. */
class DeclaredAdapter extends LlmAdapter {
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Declared Claude' }
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('the declared adapter is never streamed in these tests')
  }
}

/** Mount the route over a scripted CLI, optionally with an AI Account provider. */
async function mount(
  options: {
    readonly config?: Route.Config
    readonly account?: FakeAccountState
    readonly script?: FakeCliScript
    readonly declare?: true
    readonly sessions?: true
  } = {},
) {
  const cli = new FakeCli(options.script ?? {})
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  if (options.sessions === true) await ctx.plugin(SessionStore)
  await ctx.plugin(FakeSubprocessRuntime, cli)
  const accountFiber = options.account === undefined
    ? undefined
    : await ctx.plugin(FakeAiAccount, options.account)
  if (options.declare === true) {
    ctx.llm.registerAdapter([options.config?.providerName ?? 'claude-cli'], new DeclaredAdapter())
  }
  const fiber = await ctx.plugin(
    Route,
    // `Object.assign` rather than a spread: schemastery's `Config` is a callable schema, and
    // spreading a value of that type is refused by the lint rule against spreading class instances.
    Object.assign({ workingDirectory: join(root, 'cwd') }, options.config),
  )
  return { ctx, cli, fiber, accountFiber }
}

/** Provider ids currently registered on the runtime. */
const routes = (ctx: Context): string[] => ctx.llm.listProviders().map(provider => provider.id)

describe('llm-claude-cli activation', () => {
  it('registers no route when no AI Account provider is mounted', async () => {
    const { ctx } = await mount()
    expect(routes(ctx)).toEqual([])
  })

  it('registers no route while no Claude account has a default', async () => {
    const { ctx } = await mount({ account: { home: undefined } })
    expect(routes(ctx)).toEqual([])
  })

  it('registers the route once a Claude account has a default', async () => {
    const { ctx } = await mount({ account: { home: '/accounts/claude/one' } })
    expect(routes(ctx)).toEqual(['claude-cli'])
    expect(ctx.llm.listProviders()[0]?.name).toBe('Claude (Claude Code CLI)')
  })

  it('withdraws the route when the default goes away', async () => {
    const account: FakeAccountState = { home: '/accounts/claude/one' }
    const { ctx } = await mount({ account })
    expect(routes(ctx)).toEqual(['claude-cli'])
    account.home = undefined
    ctx.emit('ai-account/default-changed', 'claude')
    expect(routes(ctx)).toEqual([])
  })

  it('takes the route back when a default reappears', async () => {
    const account: FakeAccountState = { home: undefined }
    const { ctx } = await mount({ account })
    expect(routes(ctx)).toEqual([])
    account.home = '/accounts/claude/one'
    ctx.emit('ai-account/default-changed', 'claude')
    expect(routes(ctx)).toEqual(['claude-cli'])
  })

  it('ignores a default change for another account kind', async () => {
    const account: FakeAccountState = { home: '/accounts/claude/one' }
    const { ctx } = await mount({ account })
    account.home = undefined
    ctx.emit('ai-account/default-changed', 'chatgpt')
    // Nothing re-read the account, so the live route is untouched.
    expect(routes(ctx)).toEqual(['claude-cli'])
  })

  it('settles repeated default changes without duplicating the registration', async () => {
    const account: FakeAccountState = { home: '/accounts/claude/one' }
    const { ctx } = await mount({ account })
    account.home = '/accounts/claude/two'
    ctx.emit('ai-account/default-changed', 'claude')
    ctx.emit('ai-account/default-changed', 'claude')
    ctx.emit('ai-account/default-changed', 'claude')
    expect(routes(ctx)).toEqual(['claude-cli'])
  })

  it('withdraws the route when the AI Account provider itself goes away', async () => {
    const { ctx, accountFiber } = await mount({ account: { home: '/accounts/claude/one' } })
    expect(routes(ctx)).toEqual(['claude-cli'])
    await accountFiber?.dispose()
    expect(routes(ctx)).toEqual([])
  })

  it('keeps the live route and logs when reading the account state fails', async () => {
    const account: FakeAccountState = { home: '/accounts/claude/one' }
    const { ctx } = await mount({ account })
    expect(routes(ctx)).toEqual(['claude-cli'])
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    account.throws = true
    ctx.emit('ai-account/default-changed', 'claude')
    expect(routes(ctx)).toEqual(['claude-cli'])
    expect(warn).toHaveBeenCalled()
  })

  it('registers nothing when autoActivate is off', async () => {
    const { ctx } = await mount({
      account: { home: '/accounts/claude/one' },
      config: { autoActivate: false },
    })
    expect(routes(ctx)).toEqual([])
  })

  it('serves the configured provider name and display name', async () => {
    const { ctx } = await mount({
      account: { home: '/accounts/claude/one' },
      config: { providerName: 'claude-sub', displayName: 'My Claude' },
    })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'claude-sub', name: 'My Claude' }])
  })
})

describe('llm-claude-cli declared-profile precedence', () => {
  it('leaves a declared provider of the same id alone', async () => {
    const { ctx } = await mount({ account: { home: '/accounts/claude/one' }, declare: true })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'claude-cli', name: 'Declared Claude' }])
  })

  it('keeps its own route across later account changes without mistaking it for a declaration', async () => {
    const account: FakeAccountState = { home: '/accounts/claude/one' }
    const { ctx } = await mount({ account })
    ctx.emit('ai-account/default-changed', 'claude')
    ctx.emit('ai-account/default-changed', 'claude')
    expect(ctx.llm.listProviders()[0]?.name).toBe('Claude (Claude Code CLI)')
  })
})

describe('llm-claude-cli settings surface', () => {
  it('registers a directory entry so Settings can address the route while it is dormant', async () => {
    const { ctx } = await mount()
    expect(ctx.llm.listConfigurableProviders()).toEqual([
      expect.objectContaining({
        provider: 'claude-cli',
        displayName: 'Claude (Claude Code CLI)',
        settingsNs: 'llm-claude-cli',
        settingsPath: [],
      }),
    ])
  })
})

describe('llm-claude-cli configuration', () => {
  it('applies every documented default', () => {
    expect(Route.Config({})).toMatchObject({
      providerName: 'claude-cli',
      displayName: 'Claude (Claude Code CLI)',
      cliPath: 'claude',
      extraArgs: [],
      workingDirectory: '',
      autoActivate: true,
      authTimeoutMs: 15_000,
      catalogTimeoutMs: 30_000,
      requestTimeoutMs: 600_000,
      maxConcurrent: 2,
      graceMs: 2_000,
      toolCalls: 'prompt',
      toolCallMaxCalls: 4,
      toolCallMaxBytes: 32_768,
      toolCallRetries: 1,
      toolCallLenient: true,
    })
  })

  it('fails at load when extraArgs would change how the CLI authenticates', async () => {
    await expect(mount({ config: { extraArgs: ['--bare'] } })).rejects.toThrow(/--bare/)
  })

  it('falls back to a Harness-home working directory when none is configured', async () => {
    const cli = new FakeCli()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FakeSubprocessRuntime, cli)
    await ctx.plugin(FakeAiAccount, { home: '/accounts/claude/one' })
    await ctx.plugin(Route, Route.Config({}))
    await ctx.llm.listModels('claude-cli')
    expect(cli.spawns[0]?.spec.cwd).toMatch(/claude-cli$/)
  })
})

describe('llm-claude-cli model listing through the runtime', () => {
  it('lists the CLI models on the activated route', async () => {
    const { ctx } = await mount({ account: { home: '/accounts/claude/one' } })
    expect((await ctx.llm.listModels('claude-cli')).map(model => model.id)).toEqual(['opus', 'haiku'])
  })

  it('surfaces a CLI failure as a named error the picker can show', async () => {
    const { ctx } = await mount({
      account: { home: '/accounts/claude/one' },
      script: { catalog: () => undefined },
    })
    await expect(ctx.llm.listModels('claude-cli')).rejects.toThrow(/listed no models/)
  })

  it('reports the configured tool refusal through the runtime with its own code', async () => {
    const { ctx } = await mount({
      account: { home: '/accounts/claude/one' },
      config: { toolCalls: 'refuse' },
    })
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'claude-cli',
      model: 'opus',
      tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }],
    })) chunks.push(chunk)
    const finish = chunks.at(-1)
    expect(finish?.type === 'finish' && finish.reason.kind).toBe('error')
    expect(finish?.type === 'finish' && finish.reason.kind === 'error' && finish.reason.failure.code)
      .toBe('TOOL_CALLS_UNSUPPORTED')
  })

  it('reports a signed-out run with a code the route retry policy never repeats', async () => {
    const { ctx, cli } = await mount({
      account: { home: '/accounts/claude/one' },
      script: { inference: () => SIGNED_OUT_RUN },
    })
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'claude-cli',
      model: 'opus',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    })) chunks.push(chunk)
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish' || finish.reason.kind !== 'error') throw new Error('expected an error finish')
    expect(finish.reason.failure.code).toBe(Route.CLI_NOT_AUTHENTICATED)
    expect(finish.reason.failure.message).toMatch(/Open Settings, AI Account, and sign in to Claude again/)
    // `dsh-llm-retry` repeats a failed request only when the route's policy lists its code.
    const policy = ctx.llm.providerRetryPolicy('claude-cli')
    expect(policy.mode).toBe('normal')
    const retried = policy.mode === 'normal' ? policy.retryableCodes : []
    expect(retried).not.toContain(finish.reason.failure.code)
    expect(retried).toEqual(expect.arrayContaining(['RATE_LIMIT', 'SERVER']))
    expect(cli.callsOf('inference')).toHaveLength(1)
  })

  it('shows the signed-out failure while the default Claude account is signed out, then the models again', async () => {
    const { ctx, cli } = await mount({ account: { home: '/accounts/claude/one' } })
    await ctx.llm.listModels('claude-cli')
    const updates = vi.fn()
    ctx.on('llm/adapters-updated', updates)
    const change = (kind: 'claude' | 'chatgpt', isDefault: boolean, status: 'signedIn' | 'signedOut') => {
      ctx.emit('ai-account/status-changed', {
        id: 'c1' as AiAccountId, kind, isDefault, previous: 'unknown',
        current: { status, checkedAt: 1, message: status === 'signedOut' ? 'Not logged in' : null },
      })
    }
    change('claude', false, 'signedOut')
    change('chatgpt', true, 'signedOut')
    expect(updates).not.toHaveBeenCalled()
    change('claude', true, 'signedOut')
    expect(updates).toHaveBeenCalledOnce()
    expect(routes(ctx)).toEqual(['claude-cli'])
    const refused = ctx.llm.listModels('claude-cli')
    await expect(refused).rejects.toMatchObject({ code: Route.CLI_NOT_AUTHENTICATED })
    await expect(refused).rejects.toThrow(/Open Settings, AI Account, and sign in to Claude again/)
    expect(cli.callsOf('catalog')).toHaveLength(1)
    change('claude', true, 'signedIn')
    expect(updates).toHaveBeenCalledTimes(2)
    expect((await ctx.llm.listModels('claude-cli')).map(model => model.id)).toEqual(['opus', 'haiku'])
    expect(cli.callsOf('catalog')).toHaveLength(2)
    // A new default clears the signed-out answer; the catalog probe then asks the CLI itself.
    change('claude', true, 'signedOut')
    ctx.emit('ai-account/default-changed', 'claude')
    expect((await ctx.llm.listModels('claude-cli')).map(model => model.id)).toEqual(['opus', 'haiku'])
  })

  it('records a status change while the route is dormant without publishing a route update', async () => {
    const { ctx } = await mount({ account: { home: undefined } })
    const updates = vi.fn()
    ctx.on('llm/adapters-updated', updates)
    ctx.emit('ai-account/status-changed', {
      id: 'c1' as AiAccountId, kind: 'claude', isDefault: true, previous: 'signedIn',
      current: { status: 'signedOut', checkedAt: 1, message: null },
    })
    expect(updates).not.toHaveBeenCalled()
    expect(routes(ctx)).toEqual([])
  })

  it('re-probes the CLI after a configuration generation change', async () => {
    const { ctx, cli } = await mount({ account: { home: '/accounts/claude/one' } })
    await ctx.llm.listModels('claude-cli')
    expect(cli.callsOf('catalog')).toHaveLength(1)
    ctx.emit('loader/volatile-update', [['cliPath']])
    await ctx.llm.listModels('claude-cli')
    expect(cli.callsOf('catalog')).toHaveLength(2)
  })
})

describe('llm-claude-cli tool-call emulation through the runtime', () => {
  /** A request that declares one tool and belongs to a session. */
  const toolRequest = (sessionId: SessionId): GenerateOptions => ({
    provider: 'claude-cli',
    model: 'opus',
    tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }],
    sessionId,
  })

  it('serves a tool-declaring turn and logs the run that carried the preamble', async () => {
    const { ctx } = await mount({
      account: { home: '/accounts/claude/one' },
      sessions: true,
      script: {
        inference: () => streamLines('```dsh-tool-call\n{"name":"read_file","arguments":{"path":"/a"}}\n```'),
      },
    })
    const session = ctx.sessions.create()
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(toolRequest(session.id))) chunks.push(chunk)
    const call = chunks.find(chunk => chunk.type === 'tool-call-delta')
    expect(call?.type === 'tool-call-delta' && call.name).toBe('read_file')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    const logged = session.snapshotEvents().filter(event => event.type === 'llm/cli-tool-emulation')
    expect(logged).toHaveLength(1)
    expect(logged[0]?.data).toMatchObject({
      provider: 'claude-cli',
      model: 'opus',
      template: Route.PREAMBLE_TEMPLATE,
      tools: ['read_file'],
      attempt: 1,
    })
    expect(logged[0]?.data.preambleChars).toBeGreaterThan(0)
    // The reading of the reply is logged after the run, directly behind the run's own record.
    const types = session.snapshotEvents().map(event => event.type)
    expect(types.slice(types.indexOf('llm/cli-tool-emulation'))).toEqual([
      'llm/cli-tool-emulation',
      'llm/cli-tool-emulation-reply',
    ])
    const read = session.snapshotEvents().filter(event => event.type === 'llm/cli-tool-emulation-reply')
    expect(read[0]?.data).toEqual({
      provider: 'claude-cli',
      model: 'opus',
      attempt: 1,
      calls: 1,
      lenientCalls: 0,
      discardedChars: 0,
    })
  })

  it('fails loud rather than emulating for a session the log cannot reach', async () => {
    const { ctx } = await mount({ account: { home: '/accounts/claude/one' }, sessions: true })
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(toolRequest(SessionId('never-created')))) chunks.push(chunk)
    const finish = chunks.at(-1)
    expect(finish?.type === 'finish' && finish.reason.kind === 'error' && finish.reason.failure.code)
      .toBe(Route.EMULATION_NOT_LOGGABLE)
  })

  it('fails loud rather than emulating when no session store is mounted at all', async () => {
    const { ctx } = await mount({ account: { home: '/accounts/claude/one' } })
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(toolRequest(SessionId('s1')))) chunks.push(chunk)
    const finish = chunks.at(-1)
    expect(finish?.type === 'finish' && finish.reason.kind === 'error' && finish.reason.failure.message)
      .toMatch(/Mount @deepseek-ai\/dsh-session/)
  })
})

describe('llm-claude-cli disposal', () => {
  it('drops the route and the directory entry when its own fiber is disposed', async () => {
    const { ctx, fiber } = await mount({ account: { home: '/accounts/claude/one' } })
    expect(routes(ctx)).toEqual(['claude-cli'])
    await fiber.dispose()
    expect(routes(ctx)).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })
})
