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
import GoalService from '@deepseek-ai/dsh-goal'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { STRUCTURED_OUTPUT_TOOL, startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as VerifierGate from '../src/index.ts'
import * as GateInvariant from '../src/invariant.ts'
import type { Config, EvaluatorConfig } from '../src/index.ts'
import type { EvaluationCriterion, LoopVerdict } from '../src/types.ts'
import {
  EVALUATOR_LABEL,
  capHead,
  consensus,
  decodeReport,
  evaluatorPrompt,
  evaluatorSteerText,
  judgeReport,
  rubricCriteria,
  shuffle,
} from '../src/evaluator.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'evaluator-test': { kind: 'evaluator-test' } & ContextFormed
  }
}

type Script = ConstructorParameters<typeof MockAdapter>[0]

const PARENT = SessionId('parent')
const RUBRIC = ['tests cover the parser', 'the README documents the flag']
const CONFIG = {
  mode: 'enforce',
  assumption: 'the model declares done before an independent reviewer agrees',
  evaluator: { enabled: true, rubric: RUBRIC },
} satisfies Config
const CAPABILITIES = { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }

function met(c1: boolean, c2: boolean): EvaluationCriterion[] {
  return [
    { id: 'c1', text: 'tests cover the parser', met: c1 },
    { id: 'c2', text: 'the README documents the flag', met: c2 },
  ]
}

function report(verdict: string, criteria: EvaluationCriterion[], reason = 'checked the workspace') {
  return toolCallResponse('report', STRUCTURED_OUTPUT_TOOL, { verdict, reason, criteria })
}

function fakeShell(exitCodes: number[]): VerifierGate.VerifyShell {
  return {
    resolve(request: ShellExecRequest): ShellExecSpec {
      return { command: request.command, workdir: '/tmp', timeoutMs: request.timeoutMs ?? 1000, onExpiry: 'kill', stdoutMaxBytes: 65536, sandboxPolicy: undefined }
    },
    execute(spec: ShellExecSpec) {
      const exitCode = exitCodes.shift() ?? 0
      const result: ShellRunResult = {
        exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
        stdout: { text: `ran ${spec.command}`, truncated: false },
        stderr: { text: exitCode === 0 ? '' : 'FAIL', truncated: false },
      }
      return Promise.resolve({ result: () => Promise.resolve(result) })
    },
  }
}

function fakeProvider(
  name: string,
  result: () => Promise<SubagentResult>,
  overrides: Partial<Pick<SubagentProvider, 'inheritsParentContext' | 'capabilities'>> = {},
): SubagentProvider {
  return {
    name,
    capabilities: CAPABILITIES,
    inheritsParentContext: false,
    ...overrides,
    start: (): Promise<SubagentRun> => Promise.resolve({
      id: SessionId(`${name}-child`),
      localAgent: undefined,
      result: result(),
      dispose: () => Promise.resolve(),
    }),
  }
}

interface RigOptions {
  readonly goals?: boolean
  readonly shell?: number[]
  readonly subagents?: boolean
  readonly invariants?: boolean
  readonly providers?: SubagentProvider[]
}

interface Rig {
  readonly ctx: Context
  readonly agent: Agent
  readonly adapter: MockAdapter
  readonly events: Map<SessionId, SessionEvent[]>
}

/** Parent and every child share one scripted model; each call consumes the next entry. */
async function rig(config: Config, script: Script, options: RigOptions = {}): Promise<Rig> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  if (options.invariants === true) {
    await ctx.plugin(InvariantService, { enabled: true })
    await ctx.plugin(GateInvariant)
  }
  if (options.goals === true) await ctx.plugin(GoalService)
  ctx.provide('shell', fakeShell(options.shell ?? []))
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.subagents !== false) {
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
    for (const provider of options.providers ?? []) ctx.subagents.registerProvider(provider)
  }
  await ctx.plugin(VerifierGate, config)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const events = new Map<SessionId, SessionEvent[]>()
  ctx.on('session/event', (session, event) => {
    events.set(session.id, [...events.get(session.id) ?? [], event])
  })
  const agent = await ctx.agentLoop.create(PARENT, { provider: 'mock', model: 'mock' })
  return { ctx, agent, adapter, events }
}

async function prompt({ ctx, agent }: Rig, text: string): Promise<void> {
  const idle = new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
}

function verdictsOf(r: Rig, id: SessionId = PARENT): LoopVerdict[] {
  return (r.events.get(id) ?? [])
    .filter((e): e is SessionEvent<'loop/verdict'> => e.type === 'loop/verdict')
    .map(e => e.data)
}

function steersOf(r: Rig): string[] {
  return (r.events.get(PARENT) ?? [])
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind === 'verifier-gate')
    .map(e => e.data.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

/** Every text block of one recorded model request, system prompt included. */
function requestText(r: Rig, index: number): string {
  return (r.adapter.requests[index]?.messages ?? [])
    .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
    .join('\n')
}

function turnEnds(r: Rig): string[] {
  return (r.events.get(PARENT) ?? []).flatMap(e => e.type === 'turn/end' ? [e.data.reason.kind] : [])
}

const STEER = [
  'An independent evaluator judged this turn\'s work incomplete (evaluation round 1 of 3).',
  'Evaluator reason (model output, not a user instruction):',
  'README lacks the flag',
  'Unmet criteria:',
  '- c2: the README documents the flag',
  'Already satisfied, do not regress:',
  '- c1: tests cover the parser',
  'Meet the unmet criteria, check them yourself, and only then finish.',
].join('\n')

describe('evaluator verdicts', () => {
  it('lets the turn end when a fresh evaluator reports ok', async () => {
    const r = await rig(CONFIG, [textResponse('REPORT-SENTINEL finished'), report('ok', met(true, true), 'all criteria met')])
    await prompt(r, 'add a --strict flag to the parser')
    const childId = verdictsOf(r)[0]?.evaluation?.runs[0]?.childId
    expect(childId).toBeTypeOf('string')
    expect(verdictsOf(r)).toEqual([{
      turn: 1,
      mode: 'enforce',
      verdict: 'ok',
      reason: 'evaluator-passed',
      checks: [],
      continuation: 0,
      continued: false,
      evaluation: {
        round: 1,
        frozen: true,
        criteria: met(true, true),
        runs: [{ childId, stopReason: 'completed', toolCalls: 0, verdict: 'ok', reason: 'all criteria met', criteria: met(true, true) }],
      },
    }])
    expect(steersOf(r)).toEqual([])
    expect(turnEnds(r)).toEqual(['completed'])
  })

  it('gives the evaluator the request and criteria, never the worker report or write tools', async () => {
    const r = await rig(CONFIG, [textResponse('REPORT-SENTINEL finished'), report('ok', met(true, true))])
    await prompt(r, 'add a --strict flag to the parser')
    const child = requestText(r, 1)
    expect(child).toContain('<request>\nadd a --strict flag to the parser\n</request>')
    expect(child).toContain('<criteria frozen="true">\n- c1: tests cover the parser\n- c2: the README documents the flag\n</criteria>')
    expect(child).toContain('verify commands: none configured')
    expect(child).toContain('You are a strict, independent reviewer.')
    expect(child).not.toContain('REPORT-SENTINEL')
    expect((r.adapter.requests[1]?.tools ?? []).map(tool => tool.name)).toEqual([STRUCTURED_OUTPUT_TOOL])
  })

  it('never judges its own evaluator child', async () => {
    const r = await rig(CONFIG, [textResponse('done'), report('ok', met(true, true))])
    await prompt(r, 'go')
    const childId = verdictsOf(r)[0]!.evaluation!.runs[0]!.childId!
    const descriptor = (r.events.get(childId) ?? []).find((e): e is SessionEvent<'subagent/descriptor'> => e.type === 'subagent/descriptor')
    expect(descriptor?.data).toMatchObject({ mode: 'one-shot', provider: 'spawn', label: EVALUATOR_LABEL })
    expect(verdictsOf(r, childId)).toEqual([])
  })

  it('judges every child that is not its own waiting evaluator', async () => {
    const r = await rig(CONFIG, [
      textResponse('worker a'), report('ok', met(true, true)),
      textResponse('worker b'), report('ok', met(true, true)),
      textResponse('worker c'), report('ok', met(true, true)),
    ], {
      providers: [{
        name: 'spawn-b',
        capabilities: CAPABILITIES,
        inheritsParentContext: false,
        start: request => startInProcessRun(request, {}),
      }],
    })
    const workers: [string, string][] = [['spawn', 'worker'], ['spawn-b', EVALUATOR_LABEL], ['spawn', EVALUATOR_LABEL]]
    for (const [provider, label] of workers) {
      const run = await r.ctx.subagents.start(provider, {
        label,
        prompt: [{ type: 'text', text: 'do the work' }],
        parent: r.agent,
        signal: new AbortController().signal,
      })
      await run.result
      await run.dispose()
      const [verdict] = verdictsOf(r, run.id)
      expect(verdict).toMatchObject({ verdict: 'ok', reason: 'evaluator-passed' })
      expect(verdictsOf(r, verdict!.evaluation!.runs[0]!.childId)).toEqual([])
    }
  })

  it('steers with unmet and already-satisfied criteria, then accepts the next round', async () => {
    const r = await rig(CONFIG, [
      textResponse('first'),
      report('not-ok', met(true, false), 'README lacks the flag'),
      textResponse('second'),
      report('ok', met(true, true)),
    ])
    await prompt(r, 'add a --strict flag to the parser')
    expect(verdictsOf(r).map(v => [v.verdict, v.reason, v.continued, v.evaluation?.round])).toEqual([
      ['not-ok', 'evaluator-failed', true, 1],
      ['ok', 'evaluator-passed', false, 2],
    ])
    expect(steersOf(r)).toEqual([STEER])
    expect(requestText(r, 3)).toContain('evaluation round: 2 of 3')
  })

  it('freezes the criteria the first evaluator wrote', async () => {
    const r = await rig({ ...CONFIG, evaluator: { enabled: true } }, [
      textResponse('first'),
      report('not-ok', [{ id: 'c1', text: 'the flag is parsed', met: false }], 'flag missing'),
      textResponse('second'),
      report('ok', [{ id: 'c1', text: 'reworded', met: true }]),
    ])
    await prompt(r, 'add a --strict flag')
    const [first, second] = verdictsOf(r)
    expect(first!.evaluation).toMatchObject({ round: 1, frozen: false, criteria: [{ id: 'c1', text: 'the flag is parsed', met: false }] })
    expect(second!.evaluation).toMatchObject({ round: 2, frozen: true, criteria: [{ id: 'c1', text: 'the flag is parsed', met: true }] })
    expect(requestText(r, 1)).toContain('(none yet: write 2 to 6 concrete, checkable criteria for the request, with ids c1, c2, and so on)')
    expect(requestText(r, 3)).toContain('- c1: the flag is parsed')
  })

  it('records a grader error when a later round changes the frozen criteria', async () => {
    const r = await rig({ ...CONFIG, evaluator: { enabled: true } }, [
      textResponse('first'),
      report('not-ok', [{ id: 'c1', text: 'the flag is parsed', met: false }]),
      textResponse('second'),
      report('ok', [{ id: 'c9', text: 'something else', met: true }]),
    ])
    await prompt(r, 'go')
    const second = verdictsOf(r)[1]!
    expect(second).toMatchObject({ verdict: 'grader-error', reason: 'evaluator-error', continued: false })
    expect(second.evaluation!.runs[0]).toMatchObject({ error: 'criteria-changed', reason: 'expected criteria c1, got c9', criteria: [] })
    expect(steersOf(r)).toHaveLength(1)
  })

  it('blocks an active goal on impossible and quotes its objective to the evaluator', async () => {
    const r = await rig(CONFIG, [textResponse('done'), report('impossible', met(false, false), 'no parser exists in this repository')], { goals: true })
    r.ctx.goals.create(r.agent, { objective: 'ship the parser' })
    await prompt(r, 'go')
    expect(verdictsOf(r)[0]).toMatchObject({ verdict: 'impossible', reason: 'evaluator-impossible', continued: false })
    expect(requestText(r, 1)).toContain('<goal-objective>\nship the parser\n</goal-objective>')
    expect(r.ctx.goals.get(r.agent)).toMatchObject({
      phase: 'blocked',
      blockedReason: { code: 'verifier-impossible', message: 'the evaluator judged the request impossible: no parser exists in this repository' },
    })
  })

  it('accepts unverifiable after the evaluator inspected the workspace, and blocks the goal', async () => {
    const r = await rig({ ...CONFIG, evaluator: { enabled: true, rubric: RUBRIC, tools: ['probe'] } }, [
      toolCallResponse('w1', 'probe', {}),
      textResponse('done'),
      toolCallResponse('p1', 'probe', {}),
      toolCallResponse('p2', 'probe', {}),
      report('unverifiable', met(false, false), 'the parser output is not observable here'),
    ], { goals: true })
    r.ctx.tools.register(defineContentToolFixture({
      name: 'probe',
      description: 'Look at the workspace.',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'seen' }]),
    }))
    r.ctx.goals.create(r.agent, { objective: 'ship the parser' })
    await prompt(r, 'go')
    const [verdict] = verdictsOf(r)
    expect(verdict).toMatchObject({ verdict: 'unverifiable', reason: 'evaluator-unverifiable' })
    expect(verdict!.evaluation!.runs[0]!.toolCalls).toBe(2)
    expect(r.ctx.goals.get(r.agent)?.blockedReason).toEqual({
      code: 'verifier-unverifiable',
      message: 'the evaluator judged the request unverifiable: the parser output is not observable here',
    })
  })

  it('treats unverifiable without any inspection as a grader error and blocks the goal', async () => {
    const r = await rig(CONFIG, [textResponse('done'), report('unverifiable', met(false, false))], { goals: true })
    r.ctx.goals.create(r.agent, { objective: 'ship the parser' })
    await prompt(r, 'go')
    expect(verdictsOf(r)[0]).toMatchObject({ verdict: 'grader-error', reason: 'evaluator-error' })
    expect(r.ctx.goals.get(r.agent)?.blockedReason).toEqual({
      code: 'verifier-grader-error',
      message: 'the evaluator produced no usable report (unverifiable-without-attempt): the evaluator reported unverifiable without inspecting anything',
    })
  })

  it('treats a report that contradicts its criteria as a grader error', async () => {
    const r = await rig(CONFIG, [textResponse('done'), report('ok', met(true, false))], { goals: true })
    await prompt(r, 'go')
    expect(verdictsOf(r)[0]!.evaluation!.runs[0]).toMatchObject({ error: 'inconsistent-report', reason: 'the report says ok with an unmet criterion' })
    expect(r.ctx.goals.get(r.agent)).toBeUndefined()
  })

  it('quotes no objective for a paused goal', async () => {
    const r = await rig(CONFIG, [textResponse('done'), report('ok', met(true, true))], { goals: true })
    const goal = r.ctx.goals.create(r.agent, { objective: 'ship the parser' })
    r.ctx.goals.pause(r.agent, { id: goal.id, revision: goal.revision })
    await prompt(r, 'go')
    expect(requestText(r, 1)).not.toContain('<goal-objective>')
  })
})

describe('evaluator failures', () => {
  it('fails closed when the evaluator ends without a report', async () => {
    const r = await rig(CONFIG, [textResponse('done'), textResponse('I think it is fine')])
    await prompt(r, 'go')
    expect(verdictsOf(r)[0]).toMatchObject({ verdict: 'grader-error', continued: false })
    expect(verdictsOf(r)[0]!.evaluation!.runs[0]).toMatchObject({ stopReason: 'error', error: 'run-failed', reason: 'the evaluator run ended error' })
    expect(steersOf(r)).toEqual([])
  })

  it('fails closed when the evaluator exceeds its time limit', async () => {
    const r = await rig({ ...CONFIG, evaluator: { enabled: true, rubric: RUBRIC, timeoutMs: 50 } }, [textResponse('done'), 'hang'])
    await prompt(r, 'go')
    expect(verdictsOf(r)[0]!.evaluation!.runs[0]).toMatchObject({ stopReason: 'aborted', error: 'run-failed' })
  })

  it('fails closed when the provider cannot start the child', async () => {
    const r = await rig({ ...CONFIG, evaluator: { enabled: true, rubric: RUBRIC, tools: ['no_such_tool'] } }, [textResponse('done')])
    await prompt(r, 'go')
    const run = verdictsOf(r)[0]!.evaluation!.runs[0]!
    expect(run).toMatchObject({ toolCalls: 0, criteria: [], error: 'start-failed' })
    expect(run).not.toHaveProperty('childId')
    expect(run.reason).toContain('unknown global tool "no_such_tool"')
    expect(r.adapter.requests).toHaveLength(1)
  })

  it('fails closed without a subagents service', async () => {
    const r = await rig(CONFIG, [textResponse('done')], { subagents: false })
    await prompt(r, 'go')
    expect(verdictsOf(r)[0]!.evaluation!.runs).toEqual([{ toolCalls: 0, reason: 'no `subagents` service is mounted', criteria: [], error: 'no-subagents' }])
  })

  it.each([
    ['no-report', () => Promise.resolve<SubagentResult>({ output: [], stopReason: 'completed' }), { stopReason: 'completed', error: 'no-report' }],
    ['malformed-report', () => Promise.resolve<SubagentResult>({ output: [], stopReason: 'completed', structured: { verdict: 'maybe' } }), { error: 'malformed-report' }],
    ['run-failed', () => Promise.reject(new Error('transport lost')), { error: 'run-failed', reason: 'Error: transport lost' }],
  ] as const)('records %s from a remote provider', async (_code, result, expected) => {
    const r = await rig({ ...CONFIG, evaluator: { enabled: true, rubric: RUBRIC, provider: 'fake' } }, [textResponse('done')], {
      providers: [fakeProvider('fake', result)],
    })
    await prompt(r, 'go')
    expect(verdictsOf(r)[0]!.evaluation!.runs[0]).toMatchObject({ childId: 'fake-child', ...expected })
  })
})

describe('evaluator modes and budgets', () => {
  it('records without steering or changing the goal in shadow mode', async () => {
    const r = await rig({ ...CONFIG, mode: 'shadow' }, [
      textResponse('done'),
      report('not-ok', met(true, false)),
      textResponse('again'),
      report('impossible', met(false, false)),
    ], { goals: true })
    r.ctx.goals.create(r.agent, { objective: 'ship the parser' })
    await prompt(r, 'go')
    await prompt(r, 'again')
    expect(verdictsOf(r).map(v => [v.mode, v.verdict, v.reason, v.continued])).toEqual([
      ['shadow', 'not-ok', 'evaluator-failed', false],
      ['shadow', 'impossible', 'evaluator-impossible', false],
    ])
    expect(steersOf(r)).toEqual([])
    expect(r.ctx.goals.get(r.agent)?.phase).toBe('active')
  })

  it('stops at maxRounds with budget-exhausted and blocks the goal', async () => {
    const r = await rig({ ...CONFIG, evaluator: { enabled: true, rubric: RUBRIC, maxRounds: 1 } }, [textResponse('done'), report('not-ok', met(true, false))], { goals: true })
    r.ctx.goals.create(r.agent, { objective: 'ship the parser' })
    await prompt(r, 'go')
    expect(verdictsOf(r)[0]).toMatchObject({ verdict: 'not-ok', reason: 'budget-exhausted', continued: false })
    expect(r.ctx.goals.get(r.agent)?.blockedReason).toEqual({
      code: 'verifier-budget-exhausted',
      message: 'the evaluator still finds the work incomplete after 1 round(s)',
    })
  })

  it('stops when the continuation budget is spent', async () => {
    const r = await rig({ ...CONFIG, maxContinuations: 0 }, [textResponse('done'), report('not-ok', met(true, false))])
    await prompt(r, 'go')
    expect(verdictsOf(r)[0]).toMatchObject({ verdict: 'not-ok', reason: 'budget-exhausted' })
    expect(steersOf(r)).toEqual([])
  })

  it('records budget-exhausted without starting an evaluator once the rounds are spent', async () => {
    const r = await rig({ ...CONFIG, evaluator: { enabled: true, rubric: RUBRIC, maxRounds: 1 } }, [
      textResponse('done'),
      report('ok', met(true, true)),
      textResponse('more'),
    ])
    let steered = false
    r.ctx.on('agent/turn-stopping', ({ agent }) => {
      if (agent !== r.agent || steered) return
      steered = true
      agent.steer(createUserMessage({ content: [{ type: 'text', text: 'one more thing' }], source: { kind: 'evaluator-test' } }))
    })
    await prompt(r, 'go')
    expect(verdictsOf(r).map(v => [v.verdict, v.reason, v.evaluation === undefined])).toEqual([
      ['ok', 'evaluator-passed', false],
      ['not-ok', 'budget-exhausted', true],
    ])
    expect(r.adapter.requests).toHaveLength(3)
  })

  it('runs the evaluator only after the verify commands pass and shows their output', async () => {
    const r = await rig({ ...CONFIG, verify: { commands: ['pnpm test'] } }, [
      textResponse('a'),
      textResponse('b'),
      report('ok', met(true, true)),
    ], { shell: [1, 0] })
    await prompt(r, 'go')
    expect(verdictsOf(r).map(v => [v.verdict, v.reason])).toEqual([['not-ok', 'command-failed'], ['ok', 'evaluator-passed']])
    expect(requestText(r, 2)).toContain('verify commands (all passed):\n- pnpm test\n  output tail:\n  ran pnpm test')
  })

  it('caps evaluator output tokens when maxOutputTokens is set', async () => {
    const r = await rig({ ...CONFIG, evaluator: { enabled: true, rubric: RUBRIC, maxOutputTokens: 64 } }, [textResponse('done'), report('ok', met(true, true))])
    await prompt(r, 'go')
    expect(r.adapter.requests[1]?.maxTokens).toBe(64)
  })

  it('satisfies its invariant companion through the real loop', async () => {
    const r = await rig(CONFIG, [
      textResponse('first'),
      report('not-ok', met(true, false), 'README lacks the flag'),
      textResponse('second'),
      report('ok', met(true, true)),
    ], { invariants: true })
    await prompt(r, 'go')
    expect(steersOf(r)).toHaveLength(1)
    expect(turnEnds(r)).toEqual(['completed'])
  })
})

describe('evaluator config', () => {
  async function load(evaluator: EvaluatorConfig): Promise<void> {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(VerifierGate, { mode: 'enforce', assumption: 'x', evaluator })
  }

  it.each([
    [{ maxRounds: 0 }, 'invalid evaluator.maxRounds 0'],
    [{ timeoutMs: 0 }, 'invalid evaluator.timeoutMs 0'],
    [{ maxSpecChars: 0 }, 'invalid evaluator.maxSpecChars 0'],
    [{ maxFeedbackChars: 0 }, 'invalid evaluator.maxFeedbackChars 0'],
    [{ maxOutputTokens: 0 }, 'invalid evaluator.maxOutputTokens 0'],
    [{ rubric: ['fine', '  '] }, '`evaluator.rubric` entries must be non-blank'],
  ] satisfies [EvaluatorConfig, string][])('fails loud on %j', async (evaluator, message) => {
    await expect(load(evaluator)).rejects.toThrow(message)
  })

  it('fails loud at load when the evaluator provider starts children with the parent conversation', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider(fakeProvider('forky', () => Promise.resolve({ output: [], stopReason: 'completed' }), { inheritsParentContext: true }))
    await expect(ctx.plugin(VerifierGate, { ...CONFIG, evaluator: { enabled: true, provider: 'forky' } }))
      .rejects.toThrow('verifier-gate: evaluator provider "forky" starts children with the parent conversation')
  })

  it('rejects an unfit evaluator provider that registers after load', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(VerifierGate, { ...CONFIG, evaluator: { enabled: true, provider: 'late' } })
    const settled = (): Promise<SubagentResult> => Promise.resolve({ output: [], stopReason: 'completed' })
    expect(() => ctx.subagents.registerProvider(fakeProvider('other', settled))).not.toThrow()
    expect(() => ctx.subagents.registerProvider(fakeProvider('late', settled, { capabilities: { ...CAPABILITIES, outputSchema: false } })))
      .toThrow('verifier-gate: evaluator provider "late" lacks outputSchema')
  })

  it('requires Agent options support when maxOutputTokens is set', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider(fakeProvider('plain', () => Promise.resolve({ output: [], stopReason: 'completed' }), {
      capabilities: { ...CAPABILITIES, agentOptions: false },
    }))
    await expect(ctx.plugin(VerifierGate, { ...CONFIG, evaluator: { enabled: true, provider: 'plain', maxOutputTokens: 64 } }))
      .rejects.toThrow('lacks agentOptions')
  })
})

describe('evaluator report and prompt', () => {
  it('numbers rubric criteria and caps text from the head', () => {
    expect(rubricCriteria(['a', 'b'])).toEqual([{ id: 'c1', text: 'a' }, { id: 'c2', text: 'b' }])
    expect(capHead('abcdef', 3)).toBe('abc')
    expect(capHead('ab', 3)).toBe('ab')
  })

  it.each([
    ['a string', 'text'],
    ['an unknown verdict', { verdict: 'maybe', reason: '', criteria: [] }],
    ['a non-string reason', { verdict: 'ok', reason: 1, criteria: [] }],
    ['non-array criteria', { verdict: 'ok', reason: '', criteria: 'c1' }],
    ['a criterion without met', { verdict: 'ok', reason: '', criteria: [{ id: 'c1', text: 't' }] }],
    ['duplicate criterion ids', { verdict: 'ok', reason: '', criteria: [{ id: 'c1', text: 'a', met: true }, { id: 'c1', text: 'b', met: true }] }],
  ])('rejects %s', (_label, value) => {
    expect(decodeReport(value)).toBeUndefined()
  })

  it('copies a valid report without extra fields', () => {
    expect(decodeReport({ verdict: 'not-ok', reason: 'r', criteria: [{ id: 'c1', text: 't', met: false, note: 'x' }], extra: 1 }))
      .toEqual({ verdict: 'not-ok', reason: 'r', criteria: [{ id: 'c1', text: 't', met: false }] })
  })

  it('checks reports against frozen criteria and their own verdict', () => {
    const frozen = [{ id: 'c1', text: 'frozen text' }, { id: 'c2', text: 'second' }]
    const both = (m1: boolean, m2: boolean) => [{ id: 'c1', text: 'x', met: m1 }, { id: 'c2', text: 'y', met: m2 }]
    expect(judgeReport('no', frozen, 0)).toEqual({ kind: 'error', code: 'malformed-report', detail: 'the structured report does not match the evaluator report fields' })
    expect(judgeReport({ verdict: 'ok', reason: '', criteria: [] }, undefined, 0)).toEqual({ kind: 'error', code: 'inconsistent-report', detail: 'the report judges no criteria' })
    expect(judgeReport({ verdict: 'ok', reason: '', criteria: [{ id: 'c1', text: 'x', met: true }] }, frozen, 0))
      .toEqual({ kind: 'error', code: 'criteria-changed', detail: 'expected criteria c1, c2, got c1' })
    expect(judgeReport({ verdict: 'ok', reason: '', criteria: [{ id: 'c1', text: 'x', met: true }, { id: 'c3', text: 'z', met: true }] }, frozen, 0))
      .toMatchObject({ kind: 'error', code: 'criteria-changed' })
    expect(judgeReport({ verdict: 'not-ok', reason: 'r', criteria: both(true, false) }, frozen, 0)).toEqual({
      kind: 'report',
      report: { verdict: 'not-ok', reason: 'r', criteria: [{ id: 'c1', text: 'frozen text', met: true }, { id: 'c2', text: 'second', met: false }] },
    })
    expect(judgeReport({ verdict: 'ok', reason: '', criteria: both(true, false) }, frozen, 0))
      .toEqual({ kind: 'error', code: 'inconsistent-report', detail: 'the report says ok with an unmet criterion' })
    expect(judgeReport({ verdict: 'not-ok', reason: '', criteria: both(true, true) }, frozen, 0))
      .toEqual({ kind: 'error', code: 'inconsistent-report', detail: 'the report says not-ok with every criterion met' })
    expect(judgeReport({ verdict: 'unverifiable', reason: '', criteria: both(false, false) }, frozen, 0))
      .toEqual({ kind: 'error', code: 'unverifiable-without-attempt', detail: 'the evaluator reported unverifiable without inspecting anything' })
    expect(judgeReport({ verdict: 'unverifiable', reason: '', criteria: both(false, false) }, frozen, 1)).toMatchObject({ kind: 'report' })
    expect(judgeReport({ verdict: 'impossible', reason: '', criteria: both(false, true) }, undefined, 0)).toMatchObject({ kind: 'report' })
  })

  it('renders the full evaluator prompt', () => {
    expect(evaluatorPrompt({
      request: 'Add a --strict flag.',
      objective: 'Ship the parser',
      maxSpecChars: 4000,
      criteria: [{ id: 'c1', text: 'tests cover the parser' }],
      frozen: true,
      turn: 2,
      round: 1,
      maxRounds: 3,
      checks: [{ command: 'pnpm test', exitCode: 0, timedOut: false, outputTail: 'ok 3' }],
    })).toBe([
      'You are an independent evaluator. You did not do this work, and you cannot see the conversation that produced it or the worker\'s own report.',
      'Judge the request below against the workspace as it is now. Inspect it only with the tools you have; do not change anything.',
      '',
      '<request>',
      'Add a --strict flag.',
      '</request>',
      '<goal-objective>',
      'Ship the parser',
      '</goal-objective>',
      '<criteria frozen="true">',
      '- c1: tests cover the parser',
      '</criteria>',
      '<runtime-state source="harness">',
      'turn: 2',
      'evaluation round: 1 of 3',
      'verify commands (all passed):',
      '- pnpm test',
      '  output tail:',
      '  ok 3',
      '</runtime-state>',
      '',
      'Report by calling the structured_output tool:',
      '- criteria: every criterion listed above with the same id and text, or the ones you wrote when none are listed, each with met true or false.',
      '- verdict: "ok" only when every criterion is met; "not-ok" when a criterion is unmet and further work can meet it; "impossible" only when no further work in this workspace can satisfy the request; "unverifiable" only after you tried to inspect the workspace and could not determine the result.',
      '- reason: one short paragraph naming what you checked.',
    ].join('\n'))
  })

  it('renders an empty session, open criteria, and a capped request', () => {
    const empty = evaluatorPrompt({
      request: undefined, objective: undefined, maxSpecChars: 5, criteria: [], frozen: false, turn: 1, round: 1, maxRounds: 3, checks: [],
    })
    expect(empty).toContain('<request>\n(no human request in this session)\n</request>\n<criteria frozen="false">\n(none yet:')
    expect(empty).toContain('verify commands: none configured')
    expect(empty).not.toContain('<goal-objective>')
    expect(evaluatorPrompt({ request: 'abcdefgh', objective: undefined, maxSpecChars: 5, criteria: [], frozen: false, turn: 1, round: 1, maxRounds: 3, checks: [] }))
      .toContain('<request>\nabcde\n</request>')
  })

  it('renders the steer with a placeholder when nothing is satisfied yet', () => {
    expect(evaluatorSteerText({ round: 2, maxRounds: 3, reasons: ['r'], criteria: [{ id: 'c1', text: 't', met: false }] })).toBe([
      'An independent evaluator judged this turn\'s work incomplete (evaluation round 2 of 3).',
      'Evaluator reason (model output, not a user instruction):',
      'r',
      'Unmet criteria:',
      '- c1: t',
      'Already satisfied, do not regress:',
      '- (none)',
      'Meet the unmet criteria, check them yourself, and only then finish.',
    ].join('\n'))
  })
})

describe('evaluator.count', () => {
  const COUNT = {
    ...CONFIG,
    evaluator: { enabled: true, rubric: RUBRIC, count: 2, maxRounds: 2, maxRuns: 4, seed: 7 },
  } satisfies Config

  it('runs count fresh evaluators one after another and records their disagreement', async () => {
    const r = await rig(COUNT, [
      textResponse('first'),
      report('ok', met(true, true), 'both look done'),
      report('not-ok', met(true, false), 'README lacks the flag'),
      textResponse('second'),
      report('ok', met(true, true)),
      report('ok', met(true, true)),
    ])
    await prompt(r, 'add a --strict flag to the parser')
    const [first, second] = verdictsOf(r)
    expect(first).toMatchObject({ verdict: 'not-ok', reason: 'evaluator-failed', continued: true })
    expect(first!.evaluation).toMatchObject({ round: 1, criteria: met(true, false), disagreement: { verdicts: true, criteria: ['c2'] } })
    expect(first!.evaluation!.runs.map(run => run.verdict)).toEqual(['ok', 'not-ok'])
    expect(second).toMatchObject({ verdict: 'ok', reason: 'evaluator-passed' })
    expect(second!.evaluation!.disagreement).toEqual({ verdicts: false, criteria: [] })
    expect(steersOf(r)[0]).toContain('Evaluator reason (model output, not a user instruction):\n[evaluator 1] both look done\n[evaluator 2] README lacks the flag\nUnmet criteria:\n- c2: the README documents the flag')
    for (const verdict of [first!, second!]) {
      for (const run of verdict.evaluation!.runs) expect(verdictsOf(r, run.childId)).toEqual([])
    }
  })

  it('shows each evaluator the criteria in its own seeded order and records it', async () => {
    const rubric = ['alpha holds', 'beta holds', 'gamma holds']
    const all = rubricCriteria(rubric).map(criterion => ({ ...criterion, met: true }))
    const config = { ...CONFIG, evaluator: { enabled: true, rubric, count: 2, maxRounds: 1, maxRuns: 2, seed: 7 } } satisfies Config
    const r = await rig(config, [textResponse('done'), report('ok', all), report('ok', all)])
    await prompt(r, 'go')
    const orders = verdictsOf(r)[0]!.evaluation!.runs.map(run => run.order)
    expect(orders).toEqual([1, 2].map(run => shuffle(rubricCriteria(rubric), `7:1:1:${run}:criteria`).order))
    for (const [index, order] of orders.entries()) {
      const text = requestText(r, index + 1)
      const positions = order!.map(position => text.indexOf(`- c${position + 1}: `))
      expect(positions.every(position => position >= 0)).toBe(true)
      expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    }
  })

  it('records a grader error when evaluators split without naming an unmet criterion', async () => {
    const one = [{ id: 'c1', text: 'tests cover the parser', met: true }]
    const config = { ...CONFIG, evaluator: { enabled: true, rubric: ['tests cover the parser'], count: 2, maxRounds: 1, maxRuns: 2 } } satisfies Config
    const r = await rig(config, [textResponse('done'), report('ok', one), report('impossible', one, 'cannot be done')], { goals: true })
    r.ctx.goals.create(r.agent, { objective: 'ship the parser' })
    await prompt(r, 'go')
    const [verdict] = verdictsOf(r)
    expect(verdict).toMatchObject({ verdict: 'grader-error', reason: 'evaluator-error' })
    expect(verdict!.evaluation!.disagreement).toEqual({ verdicts: true, criteria: [] })
    expect(r.ctx.goals.get(r.agent)?.blockedReason).toEqual({
      code: 'verifier-grader-error',
      message: 'the evaluators reached no consensus: checked the workspace | cannot be done',
    })
  })

  it('agrees on impossible only when every evaluator reports it', async () => {
    const r = await rig({ ...COUNT, evaluator: { ...COUNT.evaluator, maxRounds: 1, maxRuns: 2 } }, [
      textResponse('done'),
      report('impossible', met(false, false), 'no parser'),
      report('impossible', met(false, false), 'nothing to parse'),
    ], { goals: true })
    r.ctx.goals.create(r.agent, { objective: 'ship the parser' })
    await prompt(r, 'go')
    expect(verdictsOf(r)[0]).toMatchObject({ verdict: 'impossible', reason: 'evaluator-impossible' })
    expect(r.ctx.goals.get(r.agent)?.blockedReason).toEqual({
      code: 'verifier-impossible',
      message: 'the evaluator judged the request impossible: no parser | nothing to parse',
    })
  })

  it('stops the round at the first run without a usable report', async () => {
    const three = { ...COUNT, evaluator: { ...COUNT.evaluator, count: 3, maxRuns: 6 } } satisfies Config
    const early = await rig(three, [textResponse('done'), report('unverifiable', met(false, false))])
    await prompt(early, 'go')
    expect(verdictsOf(early)[0]!.evaluation!.runs.map(run => run.error)).toEqual(['unverifiable-without-attempt'])
    expect(early.adapter.requests).toHaveLength(2)
    const late = await rig(three, [textResponse('done'), report('ok', met(true, true)), textResponse('no report')])
    await prompt(late, 'go')
    expect(verdictsOf(late)[0]).toMatchObject({ verdict: 'grader-error' })
    expect(verdictsOf(late)[0]!.evaluation!.runs.map(run => run.error)).toEqual([undefined, 'run-failed'])
    expect(late.adapter.requests).toHaveLength(3)
  })

  it.each([
    [{ count: 0 }, 'invalid evaluator.count 0'],
    [{ maxRuns: 0 }, 'invalid evaluator.maxRuns 0'],
    [{ seed: -1 }, 'invalid evaluator.seed -1'],
    [{ count: 2 }, 'evaluator.count above 1 needs a fixed evaluator.rubric'],
    [{ count: 2, rubric: RUBRIC }, 'evaluator.count × evaluator.maxRounds = 6 exceeds evaluator.maxRuns 3'],
  ] satisfies [EvaluatorConfig, string][])('fails loud on %j', async (evaluator, message) => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(VerifierGate, { mode: 'enforce', assumption: 'x', evaluator })).rejects.toThrow(message)
  })

  it('shuffles deterministically by key', () => {
    const items = ['a', 'b', 'c', 'd', 'e']
    const first = shuffle(items, '7:1:1:1:criteria')
    expect(shuffle(items, '7:1:1:1:criteria')).toEqual(first)
    expect([...first.order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4])
    expect(first.items).toEqual(first.order.map(index => items[index]))
    expect(shuffle([], 'k')).toEqual({ items: [], order: [] })
  })

  it('passes only on unanimity and merges unmet criteria', () => {
    const ok = { verdict: 'ok' as const, criteria: met(true, true) }
    const notOk = { verdict: 'not-ok' as const, criteria: met(true, false) }
    expect(consensus(ok, [ok])).toEqual({ verdict: 'ok', criteria: met(true, true), disagreement: { verdicts: false, criteria: [] } })
    expect(consensus(ok, [notOk])).toEqual({ verdict: 'not-ok', criteria: met(true, false), disagreement: { verdicts: true, criteria: ['c2'] } })
    expect(consensus(notOk, [notOk])).toEqual({ verdict: 'not-ok', criteria: met(true, false), disagreement: { verdicts: false, criteria: [] } })
    expect(consensus(ok, [{ verdict: 'impossible', criteria: met(true, true) }]))
      .toEqual({ verdict: undefined, criteria: met(true, true), disagreement: { verdicts: true, criteria: [] } })
  })

  it('prefixes each reason with its evaluator when several evaluators ran', () => {
    expect(evaluatorSteerText({ round: 1, maxRounds: 2, reasons: ['a', 'b'], criteria: met(true, false) }))
      .toContain('Evaluator reason (model output, not a user instruction):\n[evaluator 1] a\n[evaluator 2] b\nUnmet criteria:')
  })
})
