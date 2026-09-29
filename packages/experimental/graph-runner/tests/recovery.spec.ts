import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { graphNodeId, graphPlanId, graphRunId } from '@deepseek-ai/dsh-experimental-graph-contract'
import { taskOf } from '@deepseek-ai/dsh-experimental-graph-projection'
import type { GraphTask } from '@deepseek-ai/dsh-experimental-graph-projection'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { Context } from '@deepseek-ai/cordis'
import { INTERRUPTED_NOTE } from '../src/prompt.ts'
import { runGraph } from '../src/runner.ts'
import type { RunApproval, RunServices, RunSettings, RunShell } from '../src/runner.ts'
import { WriteScopes } from '../src/write-scope.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { audit, harness, l2Plan, nodeRecords, run, runRecords, scriptedShell, structured, toolTexts, trail, turn } from './harness.ts'

function taskIn(ctx: Context, agent: Agent): GraphTask {
  const task = taskOf(ctx.sessionProjections.stateOf(agent.session, 'graph')!, graphPlanId('ship'))
  if (task === undefined) throw new Error('no task graph')
  return task
}

describe('resume and carry-over', () => {
  it('retries a node the previous run left running, with the interrupted note', async () => {
    const { ctx, agent } = await harness([
      audit('a', l2Plan({ buildRetry: 1 })),
      textResponse('planned'),
      run('r'),
      structured('b1', { summary: 'fixed' }),
      structured('c1', { verdict: 'pass' }),
      structured('s1', { summary: 'shipped' }),
      textResponse('done'),
    ])
    await turn(agent, 'plan only')
    const task = taskIn(ctx, agent)
    const fingerprint = (id: string): string => task.nodes.find(node => node.id === graphNodeId(id))!.fingerprint
    const base = { runId: graphRunId('crashed'), planId: graphPlanId('ship'), version: 1, recoveryState: 'pristine' as const }
    agent.session.append('graph/run', { runId: graphRunId('crashed'), planId: graphPlanId('ship'), version: 1, phase: 'start', mode: 'enforce' })
    agent.session.append('graph/node', { ...base, nodeId: graphNodeId('spec'), status: 'running', attempt: 1, revision: 1, fingerprint: fingerprint('spec') })
    agent.session.append('graph/node', { ...base, nodeId: graphNodeId('spec'), status: 'executed', basis: 'predicate', attempt: 1, revision: 2, fingerprint: fingerprint('spec') })
    agent.session.append('graph/node', { ...base, nodeId: graphNodeId('build'), status: 'running', attempt: 1, revision: 1, fingerprint: fingerprint('build') })
    const start = vi.spyOn(ctx.subagents, 'start')
    await turn(agent)
    const build = nodeRecords(agent).filter(record => record.nodeId === 'build')
    expect(build.map(record => [record.status, record.basis, record.attempt])).toEqual([
      ['running', undefined, 1],
      ['failed_retryable', 'sessionExited', 1],
      ['running', undefined, 2],
      ['unverified', 'agentReported', 2],
      ['executed', 'verifier', 2],
    ])
    expect(JSON.stringify(start.mock.calls[0]?.[1].prompt)).toContain(INTERRUPTED_NOTE)
    expect(JSON.stringify(start.mock.calls[1]?.[1].prompt)).not.toContain(INTERRUPTED_NOTE)
    expect(runRecords(agent).at(-1)?.stopReason).toBe('GOAL_MET')
  })

  it('carries unchanged executed nodes into a patched version and marks changed ones patched', async () => {
    const { agent } = await harness([
      audit('a1', l2Plan({ buildVerify: ['check-build'] })),
      run('r1'),
      structured('b1', { summary: 'first' }),
      structured('c1', { verdict: 'fail' }),
      audit('a2', l2Plan({ buildVerify: ['check-build'], buildInstruction: 'Fix the parser and its error path' })),
      run('r2'),
      structured('b2', { summary: 'second' }),
      structured('c2', { verdict: 'pass' }),
      structured('s2', { summary: 'shipped' }),
      textResponse('done'),
    ])
    await turn(agent)
    const second = nodeRecords(agent).filter(record => record.version === 2)
    expect(second.find(record => record.nodeId === 'spec')).toMatchObject({ status: 'executed', basis: 'predicate', carriedFrom: 1 })
    expect(second.find(record => record.nodeId === 'build' && record.status === 'running')?.recoveryState).toBe('patched')
    expect(runRecords(agent).filter(record => record.phase === 'stop').map(record => record.stopReason)).toEqual(['NO_PROGRESS', 'GOAL_MET'])
  })

  it('refuses a version beyond maxPlanVersions and a shadow-admitted plan that cannot be ordered', async () => {
    const capped = await harness([
      audit('a1', l2Plan()),
      audit('a2', l2Plan({ buildInstruction: 'Another approach' })),
      run('r'),
      textResponse('done'),
    ], { runner: { maxPlanVersions: 1 } })
    await turn(capped.agent)
    expect(toolTexts(capped.agent)[2]).toContain('graph_run: MAX_ROUNDS')
    const cyclic = l2Plan()
    ;(cyclic['nodes'] as Record<string, unknown>[])[0]!['needs'] = ['report']
    ;(cyclic['edges'] as Record<string, unknown>[]).push({ from: 'report', to: 'spec', relation: 'feeds', artifact: 'loop' })
    const shadow = await harness([audit('a', cyclic), run('r'), textResponse('done')], { contractMode: 'shadow' })
    await turn(shadow.agent)
    expect(toolTexts(shadow.agent)[1]).toContain('The admitted version cannot be ordered')
    expect(runRecords(shadow.agent)).toEqual([])
  })
})

describe('human gates', () => {
  it.each<[ApprovalOutcome | 'none' | undefined, string, string]>([
    ['allowed-once', 'approve:executed(human)', 'GOAL_MET'],
    ['rejected', 'approve:failed', 'HUMAN_STOPPED'],
    ['none', 'approve:failed', 'HUMAN_STOPPED'],
    [undefined, 'approve:failed', 'HUMAN_STOPPED'],
  ])('answers %s with %s and stops %s', async (approval, gate, stop) => {
    const granted = approval === 'allowed-once'
    const { agent } = await harness([
      audit('a', l2Plan({ gate: true })),
      run('r'),
      structured('b1', { summary: 'fixed' }),
      structured('c1', { verdict: 'pass' }),
      ...granted ? [structured('s1', { summary: 'shipped' })] : [],
      textResponse('done'),
    ], approval === undefined ? {} : { approval })
    await turn(agent)
    expect(trail(agent)).toContain(gate)
    expect(runRecords(agent).at(-1)?.stopReason).toBe(stop)
    if (!granted) expect(trail(agent)).not.toContain('report:running')
  })
})

describe('write scopes', () => {
  it.each<['enforce' | 'shadow', boolean]>([['enforce', true], ['shadow', false]])('in %s mode records a write outside the scope (denied: %s)', async (mode, denied) => {
    const { agent, probes } = await harness([
      audit('a', l2Plan({ buildTools: ['probe'] })),
      run('r'),
      toolCallResponse('p1', 'probe', {}),
      structured('b1', { summary: 'fixed' }),
      structured('c1', { verdict: 'pass' }),
      structured('s1', { summary: 'shipped' }),
      textResponse('done'),
    ], { runner: { mode } })
    await turn(agent)
    const build = nodeRecords(agent).find(record => record.nodeId === 'build' && record.status === 'unverified')
    expect(build?.violations).toEqual(['site/out.txt is outside the write scopes src'])
    expect(probes).toEqual([denied ? 'denied' : 'allowed'])
  })
})

describe('runGraph edge paths', () => {
  const SETTINGS: RunSettings = { mode: 'enforce', provider: 'spawn', maxConcurrent: 1, maxDispatches: 0, maxWallMs: 0, verifyTimeoutMs: 1000, outputTailChars: 200, humanTimeoutMs: 0 }

  async function planned(options: Parameters<typeof l2Plan>[0] = {}): Promise<{ ctx: Context; agent: Agent; task: GraphTask }> {
    const { ctx, agent } = await harness([audit('a', l2Plan(options)), textResponse('planned')])
    await turn(agent, 'plan only')
    return { ctx, agent, task: taskIn(ctx, agent) }
  }

  function child(result: Promise<SubagentResult>): SubagentRun {
    return { id: SessionId('fake-child'), localAgent: undefined, result, dispose: () => Promise.resolve() }
  }

  async function runWith(
    agent: Agent,
    task: GraphTask,
    services: Partial<RunServices>,
    settings: Partial<RunSettings> = {},
    signal = new AbortController().signal,
  ) {
    return runGraph(
      { subagents: { start: () => Promise.reject(new Error('unused')) }, shell: scriptedShell({}), approval: undefined, scopes: new WriteScopes(), ...services },
      { ...SETTINGS, ...settings },
      { agent, callId: ToolCallId('direct'), signal, runId: graphRunId(`direct-${Math.random()}`), plan: task.plan, version: task.version, task, inputs: {}, routes: [] },
    )
  }

  it('treats a completed child whose output misses the schema as retryable', async () => {
    const { agent, task } = await planned()
    const outcome = await runWith(agent, task, { subagents: { start: () => Promise.resolve(child(Promise.resolve({ output: [], structured: { wrong: 1 }, stopReason: 'completed' }))) } })
    expect(outcome.nodes.find(node => node.id === 'build')?.detail).toMatch(/^the output does not match the declared schema/)
  })

  it('treats a child that cannot start as retryable and reports a diagnostic of a failed child', async () => {
    const { agent, task } = await planned({ buildRetry: 1 })
    let calls = 0
    const outcome = await runWith(agent, task, {
      subagents: {
        start: () => {
          calls += 1
          return calls === 1 ? Promise.reject(new Error('depth exceeded')) : Promise.resolve(child(Promise.resolve({ output: [], stopReason: 'error', diagnostic: 'model refused' })))
        },
      },
    })
    const build = nodeRecords(agent).filter(record => record.nodeId === 'build' && record.status === 'failed_retryable').map(record => record.detail)
    expect(build).toEqual(['the node agent could not start: Error: depth exceeded', 'the node agent stopped with error: model refused'])
    expect(outcome.stopReason).toBe('NO_PROGRESS')
  })

  it('fails anchors closed without a shell or when the shell throws', async () => {
    const { agent, task } = await planned()
    expect((await runWith(agent, task, { shell: undefined })).nodes[0]).toMatchObject({ status: 'failed', detail: 'verify command failed: check-spec' })
    const throwing: RunShell = { resolve: () => { throw new Error('no runner') }, execute: () => Promise.reject(new Error('unreachable')) }
    const { agent: second, task: secondTask } = await planned()
    const checks = nodeRecords(second).length
    await runWith(second, secondTask, { shell: throwing })
    expect(nodeRecords(second).slice(checks).find(record => record.nodeId === 'spec' && record.status === 'failed')?.checks?.[0]?.outputTail).toBe('Error: no runner')
  })

  it('cancels the running node and stops HUMAN_STOPPED when the call is aborted', async () => {
    const { agent, task } = await planned()
    const controller = new AbortController()
    const outcome = await runWith(agent, task, {
      subagents: {
        start: () => {
          controller.abort()
          return Promise.resolve(child(Promise.resolve({ output: [], stopReason: 'aborted' })))
        },
      },
    }, {}, controller.signal)
    expect(outcome.stopReason).toBe('HUMAN_STOPPED')
    expect(outcome.nodes.find(node => node.id === 'build')?.status).toBe('cancelled')
  })

  it('pauses the running node back to ready when the wall-time budget ends the run', async () => {
    const { agent, task } = await planned()
    const outcome = await runWith(agent, task, {
      subagents: {
        start: (_name: string, request: SubagentStartRequest) => Promise.resolve(child(new Promise((resolve) => {
          request.signal.addEventListener('abort', () => {
            resolve({ output: [], stopReason: 'aborted' })
          })
        }))),
      },
    }, { maxWallMs: 20 })
    expect(outcome.stopReason).toBe('BUDGET')
    expect(outcome.nodes.find(node => node.id === 'build')?.status).toBe('ready')
  })

  it('times out a waiting gate, cancels it on abort, and fails a gate whose approval throws', async () => {
    const { agent, task } = await planned({ gate: true })
    const pass = (value: object) => Promise.resolve(child(Promise.resolve({ output: [], structured: value, stopReason: 'completed' })))
    const answers = [{ summary: 'fixed' }, { verdict: 'pass' }]
    const subagents = { start: () => pass(answers.shift() ?? { summary: 'unused' }) }
    const slow: RunApproval = {
      request: ({ signal }) => new Promise<ApprovalOutcome>((resolve) => {
        signal?.addEventListener('abort', () => {
          resolve('cancelled')
        })
      }),
    }
    const timed = await runWith(agent, task, { subagents, approval: slow }, { humanTimeoutMs: 20 })
    expect(timed.stopReason).toBe('HUMAN_STOPPED')
    expect(timed.nodes.find(node => node.id === 'approve')).toMatchObject({ status: 'failed', detail: 'the human gate was not granted: cancelled' })

    const second = await planned({ gate: true })
    const controller = new AbortController()
    const again = [{ summary: 'fixed' }, { verdict: 'pass' }]
    const aborting: RunApproval = { request: () => { controller.abort(); return Promise.resolve('cancelled') } }
    const againStart = { start: () => pass(again.shift() ?? {}) }
    const cancelled = await runWith(second.agent, second.task, { subagents: againStart, approval: aborting }, {}, controller.signal)
    expect(cancelled.nodes.find(node => node.id === 'approve')?.status).toBe('cancelled')

    const third = await planned({ gate: true })
    const more = [{ summary: 'fixed' }, { verdict: 'pass' }]
    const broken: RunApproval = { request: () => Promise.reject(new Error('no open turn')) }
    const failed = await runWith(third.agent, third.task, { subagents: { start: () => pass(more.shift() ?? {}) }, approval: broken })
    expect(failed.nodes.find(node => node.id === 'approve')).toMatchObject({ status: 'failed', detail: 'runner error: Error: no open turn' })
  })

  it('cancels a gate the previous run left waiting and asks again', async () => {
    const { ctx, agent, task } = await planned({ gate: true })
    const answers = [{ summary: 'fixed' }, { verdict: 'pass' }]
    const approveNode = task.nodes.find(node => node.id === graphNodeId('approve'))!
    agent.session.append('graph/node', {
      runId: graphRunId('crashed'), planId: graphPlanId('ship'), version: 1, nodeId: approveNode.id, status: 'waiting_human',
      recoveryState: 'pristine', attempt: 1, revision: 1, fingerprint: approveNode.fingerprint,
    })
    const waiting = taskIn(ctx, agent)
    const outcome = await runWith(agent, waiting, { subagents: { start: () => Promise.resolve(child(Promise.resolve({ output: [], structured: answers.shift() ?? {}, stopReason: 'completed' }))) } })
    const approve = nodeRecords(agent).filter(record => record.nodeId === 'approve').map(record => [record.status, record.detail])
    expect(approve[1]).toEqual(['cancelled', 'interrupted: the previous run ended while this gate was waiting'])
    expect(outcome.nodes.find(node => node.id === 'approve')?.status).toBe('failed')
  })

  it('records a runner error when a started child fails outside its result', async () => {
    const { agent, task } = await planned()
    const outcome = await runWith(agent, task, { subagents: { start: () => Promise.resolve(child(Promise.reject(new Error('infra')))) } })
    expect(nodeRecords(agent).find(record => record.nodeId === 'build' && record.status === 'failed_retryable')?.detail).toBe('runner error: Error: infra')
    expect(outcome.stopReason).toBe('NO_PROGRESS')
  })
})
