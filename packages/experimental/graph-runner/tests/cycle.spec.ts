import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { graphNodeId, graphPlanId, graphRunId } from '@deepseek-ai/dsh-experimental-graph-contract'
import { taskOf } from '@deepseek-ai/dsh-experimental-graph-projection'
import type { GraphTask } from '@deepseek-ai/dsh-experimental-graph-projection'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import { metricOf, plateaued, plateauOf, sentBack } from '../src/cycle.ts'
import { runGraph } from '../src/runner.ts'
import type { RunShell } from '../src/runner.ts'
import { WriteScopes } from '../src/write-scope.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { audit, edgeRecords, harness, loopPlan, nodeRecords, run, runRecords, structured, turn } from './harness.ts'

function taskIn(ctx: Context, agent: Agent): GraphTask {
  const task = taskOf(ctx.sessionProjections.stateOf(agent.session, 'graph')!, graphPlanId('ship'))
  if (task === undefined) throw new Error('no task graph')
  return task
}

describe('cycle helpers', () => {
  it('reads the last non-empty stdout line as the metric, or the exit code of a failed command', () => {
    expect(metricOf('1\n 3 \n\n', 0)).toBe('3')
    expect(metricOf('', 0)).toBe('')
    expect(metricOf('3', 2)).toBe('exit 2')
    expect(metricOf('3', null)).toBe('exit null')
  })

  it('finds a plateau only after enough unchanged values', () => {
    expect(plateaued([], '3', 1)).toBe(false)
    expect(plateaued(['3'], '3', 1)).toBe(true)
    expect(plateaued(['2', '3'], '3', 2)).toBe(false)
    expect(plateaued(['3', '3', '3'], '3', 2)).toBe(true)
    expect(plateauOf({ maxIterations: 1, until: 'true' })).toBeUndefined()
    expect(plateauOf({ maxIterations: 1, until: 'true', metricCommand: 'count' })).toBeUndefined()
    expect(plateauOf({ maxIterations: 1, until: 'true', plateauAfter: 2, metricCommand: 'count' })).toEqual({ command: 'count', after: 2 })
  })

  it('sends back only the allowed fields of an object output', () => {
    expect(sentBack({ verdict: 'fail', notes: 'x' }, ['verdict'])).toEqual({ verdict: 'fail' })
    expect(sentBack({ verdict: 'fail' }, undefined)).toEqual({ verdict: 'fail' })
    expect(sentBack(undefined, ['verdict'])).toBeUndefined()
    expect(sentBack(null, ['verdict'])).toBeNull()
    expect(sentBack(['x'], ['verdict'])).toEqual(['x'])
  })
})

describe('cycle edges in graph_run', () => {
  it('fires once with feedback, then stops the loop when until passes, before dependents run', async () => {
    const { ctx, agent, shell } = await harness([
      audit('a', loopPlan({ maxIterations: 2, until: 'loop-until' })),
      run('r'),
      structured('b1', { summary: 'first' }),
      structured('c1', { verdict: 'pass' }),
      structured('b2', { summary: 'second' }),
      structured('c2', { verdict: 'pass' }),
      structured('s1', { summary: 'shipped' }),
      textResponse('done'),
    ], { shell: { 'loop-until': [1, 0] } })
    const start = vi.spyOn(ctx.subagents, 'start')
    await turn(agent)
    expect(edgeRecords(agent).map(record => [record.outcome, record.iteration, record.fireCount])).toEqual([['fired', 0, 1], ['until-met', 1, 1]])
    expect(edgeRecords(agent)[0]?.output).toEqual({ verdict: 'pass' })
    expect(shell.commands.filter(command => command === 'loop-until')).toHaveLength(2)
    const build = nodeRecords(agent).filter(record => record.nodeId === 'build').map(record => [record.status, record.iteration ?? 0])
    expect(build).toEqual([
      ['running', 0], ['unverified', 0], ['executed', 0], ['pending', 1], ['running', 1], ['unverified', 1], ['executed', 1],
    ])
    expect(JSON.stringify(start.mock.calls[2]?.[1].prompt)).toContain('Loop feedback from check (fire 1): {\\"verdict\\":\\"pass\\"}')
    const events = agent.session.snapshotEvents()
    const lastEdge = events.findLastIndex(event => event.type === 'graph/edge')
    const reportStart = events.findIndex(event => event.type === 'graph/node' && event.data.nodeId === 'report' && event.data.status === 'running')
    expect(reportStart).toBeGreaterThan(lastEdge)
    expect(runRecords(agent).at(-1)?.stopReason).toBe('GOAL_MET')
  })

  it('exits the loop without failing once maxIterations fires are spent', async () => {
    const { agent } = await harness([
      audit('a', loopPlan({ maxIterations: 1, until: 'loop-until' })),
      run('r'),
      structured('b1', { summary: 'first' }),
      structured('c1', { verdict: 'pass' }),
      structured('b2', { summary: 'second' }),
      structured('c2', { verdict: 'pass' }),
      structured('s1', { summary: 'shipped' }),
      textResponse('done'),
    ], { shell: { 'loop-until': 1 } })
    await turn(agent)
    expect(edgeRecords(agent).map(record => [record.outcome, record.fireCount])).toEqual([['fired', 1], ['exhausted', 1]])
    expect(runRecords(agent).at(-1)?.stopReason).toBe('GOAL_MET')
  })

  it('exits the loop when the metric stops changing', async () => {
    const { agent } = await harness([
      audit('a', loopPlan({ maxIterations: 5, until: 'loop-until', plateauAfter: 1, metricCommand: 'count-todos' })),
      run('r'),
      structured('b1', { summary: 'first' }),
      structured('c1', { verdict: 'pass' }),
      structured('b2', { summary: 'second' }),
      structured('c2', { verdict: 'pass' }),
      structured('s1', { summary: 'shipped' }),
      textResponse('done'),
    ], { shell: { 'loop-until': 1 }, stdout: { 'count-todos': ['3\n', '3\n'] } })
    await turn(agent)
    expect(edgeRecords(agent).map(record => [record.outcome, record.metric])).toEqual([['fired', '3'], ['plateau', '3']])
  })

  it('decides an undecided loop left by a crashed run before its dependents run', async () => {
    const { ctx, agent } = await harness([
      audit('a', loopPlan({ maxIterations: 2, until: 'loop-until' })),
      textResponse('planned'),
      run('r'),
      structured('s1', { summary: 'shipped' }),
      textResponse('done'),
    ], { shell: { 'loop-until': 0 } })
    await turn(agent, 'plan only')
    const task = taskIn(ctx, agent)
    const fingerprint = (id: string): string => task.nodes.find(node => node.id === graphNodeId(id))!.fingerprint
    const base = { runId: graphRunId('crashed'), planId: graphPlanId('ship'), version: 1, recoveryState: 'pristine' as const, attempt: 1 }
    agent.session.append('graph/run', { runId: graphRunId('crashed'), planId: graphPlanId('ship'), version: 1, phase: 'start', mode: 'enforce' })
    const node = (id: string, revision: number, rest: Record<string, unknown>): void => {
      agent.session.append('graph/node', { ...base, nodeId: graphNodeId(id), revision, fingerprint: fingerprint(id), status: 'running', ...rest })
    }
    node('spec', 1, {})
    node('spec', 2, { status: 'executed', basis: 'predicate' })
    node('build', 1, {})
    node('build', 2, { status: 'unverified', basis: 'agentReported', output: { summary: 'x' } })
    node('build', 3, { status: 'executed', basis: 'verifier', output: { summary: 'x' } })
    node('check', 1, {})
    node('check', 2, { status: 'executed', basis: 'verifier', output: { verdict: 'pass' } })
    await turn(agent)
    expect(edgeRecords(agent).map(record => [record.outcome, record.iteration, record.fireCount])).toEqual([['until-met', 0, 0]])
    expect(runRecords(agent).at(-1)?.stopReason).toBe('GOAL_MET')
  })

  it('carries the feedback of a fire into the next run after a budget stop', async () => {
    const { ctx, agent } = await harness([
      audit('a', loopPlan({ maxIterations: 2, until: 'loop-until' })),
      run('r1'),
      structured('b1', { summary: 'first' }),
      structured('c1', { verdict: 'pass' }),
      run('r2'),
      structured('b2', { summary: 'second' }),
      structured('c2', { verdict: 'pass' }),
      run('r3'),
      structured('s1', { summary: 'shipped' }),
      textResponse('done'),
    ], { shell: { 'loop-until': [1, 0] }, runner: { maxDispatches: 2 } })
    const start = vi.spyOn(ctx.subagents, 'start')
    await turn(agent)
    expect(runRecords(agent).filter(record => record.phase === 'stop').map(record => record.stopReason)).toEqual(['BUDGET', 'BUDGET', 'GOAL_MET'])
    expect(JSON.stringify(start.mock.calls[2]?.[1].prompt)).toContain('Loop feedback from check (fire 1)')
    expect(edgeRecords(agent).map(record => record.outcome)).toEqual(['fired', 'until-met'])
  })

  it('records no decision when the run is cancelled during the until command', async () => {
    const { ctx, agent } = await harness([audit('a', loopPlan({ maxIterations: 2, until: 'loop-until' })), textResponse('planned')])
    await turn(agent, 'plan only')
    const controller = new AbortController()
    const shell: RunShell = {
      resolve: request => ({ command: request.command, workdir: '/work', timeoutMs: 1000, onExpiry: 'kill', stdoutMaxBytes: 65536, sandboxPolicy: undefined }),
      async execute(spec) {
        if (spec.command === 'loop-until') controller.abort('stop')
        const result: ShellRunResult = {
          exitCode: spec.command === 'loop-until' ? 1 : 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
          stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
        }
        return { result: async () => result }
      },
    }
    const outputs: Record<string, object> = { build: { summary: 'x' }, check: { verdict: 'pass' }, report: { summary: 'y' } }
    const child = (label: string): SubagentRun => ({
      id: SessionId(`child-${label}`),
      localAgent: undefined,
      result: Promise.resolve({ output: [], structured: outputs[label.split(' ').at(-1)!], stopReason: 'completed' }),
      dispose: () => Promise.resolve(),
    })
    const task = taskIn(ctx, agent)
    const outcome = await runGraph(
      {
        subagents: { start: (_name, request) => Promise.resolve(child(request.label!)) },
        shell,
        approval: undefined,
        scopes: new WriteScopes(),
      },
      { mode: 'enforce', provider: 'spawn', maxConcurrent: 1, maxDispatches: 0, maxWallMs: 0, verifyTimeoutMs: 1000, outputTailChars: 200, humanTimeoutMs: 0 },
      { agent, callId: ToolCallId('direct'), signal: controller.signal, runId: graphRunId('direct'), plan: task.plan, version: task.version, task, inputs: {}, routes: [] },
    )
    expect(outcome.stopReason).toBe('HUMAN_STOPPED')
    expect(edgeRecords(agent)).toEqual([])
    expect(outcome.nodes.find(node => node.id === 'report')?.status).not.toBe('running')
  })
})
