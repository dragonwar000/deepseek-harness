import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ShellExecRequest, ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as VerifierGate from '../src/index.ts'
import * as GateInvariant from '../src/invariant.ts'
import type { Config } from '../src/index.ts'
import type { LoopVerdict } from '../src/types.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test': { kind: 'test' } & ContextFormed
  }
}

/** Scripted shell: each execute() pops the next result override; records commands. */
type FakeShell = VerifierGate.VerifyShell & { commands: string[]; requests: ShellExecRequest[] }

function fakeShell(results: (number | Partial<ShellRunResult>)[]): FakeShell {
  const commands: string[] = []
  const requests: ShellExecRequest[] = []
  return {
    commands,
    requests,
    resolve(request: ShellExecRequest): ShellExecSpec {
      requests.push(request)
      return { command: request.command, workdir: '/tmp', timeoutMs: request.timeoutMs ?? 1000, onExpiry: 'kill', stdoutMaxBytes: 65536, sandboxPolicy: undefined }
    },
    async execute(spec: ShellExecSpec) {
      commands.push(spec.command)
      const next = results.shift() ?? 0
      const override = typeof next === 'number' ? { exitCode: next } : next
      const exitCode = override.exitCode === undefined ? 0 : override.exitCode
      const result: ShellRunResult = {
        exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
        stdout: { text: `ran ${spec.command}`, truncated: false },
        stderr: { text: exitCode === 0 ? '' : 'FAIL', truncated: false },
        ...override,
      }
      return { result: async () => result }
    },
  }
}

async function harness(config: Config, shell: VerifierGate.VerifyShell): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  ctx.provide('shell', shell)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(VerifierGate, config)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

async function prompt(ctx: Context, agent: Agent, text: string): Promise<void> {
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
}

function verdicts(agent: Agent): LoopVerdict[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'loop/verdict'> => e.type === 'loop/verdict')
    .map(e => e.data)
}

function steers(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind === 'verifier-gate')
    .map(e => e.data.content.map(b => b.type === 'text' ? b.text : '').join(''))
}

const CONFIG = {
  mode: 'enforce',
  assumption: 'model declares done early',
  verify: { commands: ['pnpm test'] },
  maxContinuations: 8,
} satisfies Config

describe('enforce mode', () => {
  it('steers once on a red verify command, then lets the turn end when green', async () => {
    const shell = fakeShell([1, 0])
    const ctx = await harness(CONFIG, shell)
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done'), textResponse('fixed')]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    await prompt(ctx, agent, 'go')

    expect(shell.commands).toEqual(['pnpm test', 'pnpm test'])
    const found = verdicts(agent)
    expect(found.map(v => [v.verdict, v.reason, v.continued, v.continuation])).toEqual([
      ['not-ok', 'command-failed', true, 0],
      ['ok', 'all-passed', false, 1],
    ])
    expect(found[0]!.checks[0]).toMatchObject({ command: 'pnpm test', exitCode: 1, timedOut: false })
    expect(steers(agent)).toHaveLength(1)
    expect(steers(agent)[0]).toContain('verify command failed')
    expect(steers(agent)[0]).toContain('pnpm test')
  })

  it('satisfies its invariant companion through the real loop', async () => {
    const shell = fakeShell([1, 1, 0])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(InvariantService, { enabled: true })
    await ctx.plugin(GateInvariant)
    ctx.provide('shell', shell)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(VerifierGate, CONFIG)
    const agent = await mockAgent(ctx, ['a', 'b', 'c'])
    await prompt(ctx, agent, 'go')
    expect(steers(agent)).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(e => e.type === 'turn/end').map(e => e.type === 'turn/end' ? e.data.reason.kind : '')).toEqual(['completed'])
  })
})

async function mockAgent(ctx: Context, replies: string[]): Promise<Agent> {
  ctx.llm.registerAdapter(['mock'], new MockAdapter(replies.map(reply => textResponse(reply))))
  return ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
}

describe('verify commands', () => {
  it('passes the configured timeout and the turn signal to the shell seam', async () => {
    const shell = fakeShell([0])
    const ctx = await harness({ ...CONFIG, verify: { commands: ['pnpm test'], timeoutMs: 1234 } }, shell)
    const agent = await mockAgent(ctx, ['done'])
    await prompt(ctx, agent, 'go')
    expect(shell.requests).toHaveLength(1)
    expect(shell.requests[0]).toMatchObject({ command: 'pnpm test', timeoutMs: 1234 })
    expect(shell.requests[0]!.signal).toBeInstanceOf(AbortSignal)
  })

  it('runs every command when all pass and stops at the first failure', async () => {
    const shell = fakeShell([0, 0, 0, 0, 2])
    const ctx = await harness({ ...CONFIG, mode: 'shadow', verify: { commands: ['lint', 'test', 'build'] } }, shell)
    const agent = await mockAgent(ctx, ['one', 'two'])
    await prompt(ctx, agent, 'go')
    await prompt(ctx, agent, 'again')
    expect(shell.commands).toEqual(['lint', 'test', 'build', 'lint', 'test'])
    expect(verdicts(agent).map(v => [v.verdict, v.checks.map(c => c.command)])).toEqual([
      ['ok', ['lint', 'test', 'build']],
      ['not-ok', ['lint', 'test']],
    ])
  })

  it('records skipped when no commands are configured, without a shell', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(VerifierGate, { mode: 'enforce', assumption: 'x' })
    const agent = await mockAgent(ctx, ['done'])
    await prompt(ctx, agent, 'go')
    expect(verdicts(agent)).toEqual([{ turn: 1, mode: 'enforce', verdict: 'skipped', reason: 'no-commands', checks: [], continuation: 0, continued: false }])
  })

  it('names a signal kill and a timeout in the steer and keeps only the output tail', async () => {
    const shell = fakeShell([{ exitCode: null, timedOut: true, stdout: { text: 'x'.repeat(50), truncated: false }, stderr: { text: 'END', truncated: false } }, 0])
    const long = `check ${'y'.repeat(200)}`
    const ctx = await harness({ ...CONFIG, verify: { commands: [long], stdoutTailChars: 10 } }, shell)
    const agent = await mockAgent(ctx, ['done', 'fixed'])
    await prompt(ctx, agent, 'go')
    const [first] = verdicts(agent)
    expect(first!.checks[0]).toMatchObject({ exitCode: null, timedOut: true, outputTail: 'xxxxxx\nEND' })
    expect(steers(agent)[0]).toBe(`verify command failed (exit signal, timed out): ${long}\nOutput tail:\nxxxxxx\nEND\nFix the cause, rerun the failing check yourself, and only then finish.`)
    const steer = agent.session.snapshotEvents().find((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind === 'verifier-gate')
    const source = steer!.data.source
    expect(source.kind === 'verifier-gate' && source.form === 'notice' ? source.summary.length : 0).toBe(120)
  })

  it('errors the turn when the shell service disappears after load', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const dispose = ctx.provide('shell', fakeShell([]))
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(VerifierGate, CONFIG)
    dispose()
    const agent = await mockAgent(ctx, ['done'])
    await prompt(ctx, agent, 'go')
    expect(verdicts(agent)).toEqual([])
    const end = agent.session.snapshotEvents().find(e => e.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.data.reason.kind === 'error' ? end.data.reason.error.message : '').toContain('no longer mounted')
  })
})

describe('shadow mode', () => {
  it('records not-ok but never steers', async () => {
    const shell = fakeShell([1])
    const ctx = await harness({ ...CONFIG, mode: 'shadow' }, shell)
    const agent = await mockAgent(ctx, ['done'])
    await prompt(ctx, agent, 'go')
    expect(verdicts(agent).map(v => [v.mode, v.verdict, v.reason, v.continued])).toEqual([['shadow', 'not-ok', 'command-failed', false]])
    expect(steers(agent)).toHaveLength(0)
  })
})

describe('failed step', () => {
  it('never reaches the gate: an exhausted script errors the turn and runs no verify command', async () => {
    const shell = fakeShell([1])
    const ctx = await harness(CONFIG, shell)
    const agent = await mockAgent(ctx, []) // the first model call throws 'MockAdapter: script exhausted'
    await prompt(ctx, agent, 'go')
    expect(shell.commands).toEqual([])
    expect(verdicts(agent)).toEqual([])
    expect(agent.session.snapshotEvents().some(e => e.type === 'turn/end' && e.data.reason.kind === 'error')).toBe(true)
  })
})

describe('continuation budget', () => {
  it('stops steering after maxContinuations and records budget-exhausted', async () => {
    const shell = fakeShell([1, 1, 1])
    const ctx = await harness({ ...CONFIG, maxContinuations: 2 }, shell)
    const agent = await mockAgent(ctx, ['a', 'b', 'c'])
    await prompt(ctx, agent, 'go')
    expect(steers(agent)).toHaveLength(2)
    expect(verdicts(agent).map(v => [v.reason, v.continuation, v.continued])).toEqual([
      ['command-failed', 0, true],
      ['command-failed', 1, true],
      ['budget-exhausted', 2, false],
    ])
    expect(agent.session.snapshotEvents().filter(e => e.type === 'turn/end').map(e => e.type === 'turn/end' ? e.data.reason.kind : '')).toEqual(['completed'])
  })

  it('resets the budget on a fresh user prompt', async () => {
    const shell = fakeShell([1, 0, 1, 0])
    const ctx = await harness({ ...CONFIG, maxContinuations: 1 }, shell)
    const agent = await mockAgent(ctx, ['a', 'b', 'c', 'd'])
    await prompt(ctx, agent, 'go')
    await prompt(ctx, agent, 'again')
    expect(steers(agent)).toHaveLength(2)
    expect(verdicts(agent).map(v => [v.turn, v.continuation])).toEqual([[1, 0], [1, 1], [2, 0], [2, 1]])
  })

  it('starts a fresh budget on a new turn opened by non-human input', async () => {
    const shell = fakeShell([1, 0, 1, 0])
    const ctx = await harness({ ...CONFIG, maxContinuations: 1 }, shell)
    const agent = await mockAgent(ctx, ['a', 'b', 'c', 'd'])
    await prompt(ctx, agent, 'go')
    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'scheduled' }], source: { kind: 'test' } }))
    await idle
    expect(verdicts(agent).map(v => [v.turn, v.reason, v.continued])).toEqual([
      [1, 'command-failed', true],
      [1, 'all-passed', false],
      [2, 'command-failed', true],
      [2, 'all-passed', false],
    ])
  })
})

describe('config', () => {
  it('fails loud without an assumption', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    ctx.provide('shell', fakeShell([]))
    await expect(ctx.plugin(VerifierGate, { mode: 'enforce', assumption: '  ' })).rejects.toThrow('`assumption` must name')
  })

  it('fails loud when commands are set but no shell is mounted', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(VerifierGate, CONFIG)).rejects.toThrow('no `shell` service is mounted')
  })

  it.each([
    [{ maxContinuations: -1 }, 'invalid maxContinuations -1'],
    [{ maxContinuations: 1.5 }, 'invalid maxContinuations 1.5'],
    [{ verify: { commands: ['pnpm test'], timeoutMs: 0 } }, 'invalid verify.timeoutMs 0'],
    [{ verify: { commands: ['pnpm test'], stdoutTailChars: 0 } }, 'invalid verify.stdoutTailChars 0'],
  ] satisfies [Config, string][])('fails loud on %j', async (patch, message) => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    ctx.provide('shell', fakeShell([]))
    await expect(ctx.plugin(VerifierGate, { ...CONFIG, ...patch })).rejects.toThrow(message)
  })

  it('registers nothing in off mode', async () => {
    const shell = fakeShell([1])
    const ctx = await harness({ mode: 'off', assumption: 'x', verify: { commands: ['pnpm test'] } }, shell)
    const agent = await mockAgent(ctx, ['done'])
    await prompt(ctx, agent, 'go')
    expect(shell.commands).toEqual([])
    expect(verdicts(agent)).toEqual([])
  })

  it('defaults to shadow mode', async () => {
    const shell = fakeShell([1])
    const ctx = await harness({ assumption: 'x', verify: { commands: ['pnpm test'] } }, shell)
    const agent = await mockAgent(ctx, ['done'])
    await prompt(ctx, agent, 'go')
    expect(verdicts(agent).map(v => v.mode)).toEqual(['shadow'])
    expect(steers(agent)).toEqual([])
  })
})
