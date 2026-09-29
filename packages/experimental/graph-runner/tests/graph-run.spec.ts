import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as GraphRunner from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { audit, harness, l2Plan, nodeRecords, run, runRecords, structured, SUMMARY, toolTexts, trail, turn } from './harness.ts'

describe('graph_run', () => {
  it('runs an L2 plan to GOAL_MET with fresh subagents, predicate proof, and a passing verification', async () => {
    const { ctx, agent, shell } = await harness([
      audit('a', l2Plan({ buildVerify: ['check-build'] })),
      run('r'),
      structured('b1', { summary: 'fixed' }),
      structured('c1', { verdict: 'pass' }),
      structured('s1', { summary: 'shipped' }),
      textResponse('done'),
    ])
    const start = vi.spyOn(ctx.subagents, 'start')
    await turn(agent)
    expect(trail(agent)).toEqual([
      'spec:running', 'spec:executed(predicate)',
      'build:running', 'build:executed(predicate)',
      'check:running', 'check:executed(verifier)',
      'report:running', 'report:unverified(agentReported)',
    ])
    expect(runRecords(agent).map(record => [record.phase, record.stopReason])).toEqual([['start', undefined], ['stop', 'GOAL_MET']])
    expect(shell.commands).toEqual(['check-spec', 'check-build'])
    const first = start.mock.calls[0]?.[1]
    expect(first?.parent).toBe(agent)
    expect(first?.toolFilter).toEqual({ allow: ['read'] })
    expect(first?.outputSchema).toEqual(SUMMARY)
    const reportPrompt = JSON.stringify(start.mock.calls[2]?.[1].prompt)
    expect(reportPrompt).toContain('verdict (from check field verdict): \\"pass\\"')
    const text = toolTexts(agent).at(-1)
    expect(text).toContain('graph_run: GOAL_MET')
    expect(text).toContain('result of report: {"summary":"shipped"}')
    expect(nodeRecords(agent).find(record => record.nodeId === 'build' && record.status === 'executed')?.childSession).toBeDefined()
  })

  it('promotes an execution result without verify commands through the verification that passes it', async () => {
    const { agent } = await harness([
      audit('a', l2Plan()),
      run('r'),
      structured('b1', { summary: 'fixed' }),
      structured('c1', { verdict: 'pass' }),
      structured('s1', { summary: 'shipped' }),
      textResponse('done'),
    ])
    await turn(agent)
    expect(trail(agent)).toContain('build:unverified(agentReported)')
    expect(trail(agent)).toContain('build:executed(verifier)')
    expect(runRecords(agent).at(-1)?.stopReason).toBe('GOAL_MET')
  })

  it('retries the nodes a failing verification rejects, without the failure trace', async () => {
    const { ctx, agent } = await harness([
      audit('a', l2Plan({ buildRetry: 1, checkRetry: 1 })),
      run('r'),
      structured('b1', { summary: 'first' }),
      structured('c1', { verdict: 'fail' }),
      structured('b2', { summary: 'second' }),
      structured('c2', { verdict: 'pass' }),
      structured('s1', { summary: 'shipped' }),
      textResponse('done'),
    ])
    const start = vi.spyOn(ctx.subagents, 'start')
    await turn(agent)
    expect(trail(agent)).toEqual([
      'spec:running', 'spec:executed(predicate)',
      'build:running', 'build:unverified(agentReported)',
      'check:running', 'check:failed_retryable', 'build:failed_retryable',
      'build:running', 'build:unverified(agentReported)',
      'check:running', 'check:executed(verifier)', 'build:executed(verifier)',
      'report:running', 'report:unverified(agentReported)',
    ])
    const retried = nodeRecords(agent).filter(record => record.nodeId === 'build' && record.status === 'running')
    expect(retried.map(record => [record.attempt, record.recoveryState])).toEqual([[1, 'pristine'], [2, 'retried']])
    expect(JSON.stringify(start.mock.calls[2]?.[1].prompt)).not.toContain('fail')
    expect(runRecords(agent).at(-1)?.stopReason).toBe('GOAL_MET')
  })

  it('stops with NO_PROGRESS and skips dependents when a node fails past its retry budget', async () => {
    const { agent } = await harness([
      audit('a', l2Plan({ buildVerify: ['check-build'] })),
      run('r'),
      structured('b1', { summary: 'broken' }),
      textResponse('done'),
    ], { shell: { 'check-build': 1 } })
    await turn(agent)
    expect(trail(agent)).toEqual([
      'spec:running', 'spec:executed(predicate)',
      'build:running', 'build:failed_retryable', 'build:failed',
      'check:skipped', 'report:skipped',
    ])
    expect(toolTexts(agent).at(-1)).toContain('graph_run: NO_PROGRESS')
  })

  it('fails an anchor whose predicate fails and runs nothing after it', async () => {
    const { agent } = await harness([audit('a', l2Plan()), run('r'), textResponse('done')], { shell: { 'check-spec': 1 } })
    await turn(agent)
    expect(trail(agent)).toEqual(['spec:running', 'spec:failed', 'build:skipped', 'check:skipped', 'report:skipped'])
  })

  it('treats a node agent that ends without structured output as retryable', async () => {
    const { agent } = await harness([audit('a', l2Plan()), run('r'), textResponse('no structured output'), textResponse('done')])
    await turn(agent)
    const failed = nodeRecords(agent).find(record => record.nodeId === 'build' && record.status === 'failed_retryable')
    expect(failed?.detail).toMatch(/^the node agent stopped with error/)
    expect(runRecords(agent).at(-1)?.stopReason).toBe('NO_PROGRESS')
  })

  it('refuses a plan with no admitted version without starting a run', async () => {
    const { agent } = await harness([run('r', { plan_id: 'ghost' }), textResponse('done')])
    await turn(agent)
    expect(runRecords(agent)).toEqual([])
    expect(toolTexts(agent)[0]).toContain('graph_run: ADMISSION_REFUSED — plan ghost')
  })

  it('stops with BUDGET at maxDispatches and continues from the log on the next call', async () => {
    const { agent } = await harness([
      audit('a', l2Plan()),
      run('r1'),
      structured('b1', { summary: 'fixed' }),
      run('r2'),
      structured('c1', { verdict: 'pass' }),
      run('r3'),
      structured('s1', { summary: 'shipped' }),
      textResponse('done'),
    ], { runner: { maxDispatches: 1 } })
    await turn(agent)
    expect(runRecords(agent).filter(record => record.phase === 'stop').map(record => record.stopReason)).toEqual(['BUDGET', 'BUDGET', 'GOAL_MET'])
  })

  it('names missing run inputs, a missing provider, and missing projections as tool errors', async () => {
    const inputs = l2Plan({ runInputs: ['ticket'], buildInputs: [{ name: 'ticket', from: 'run', field: 'ticket' }] })
    const first = await harness([audit('a', inputs), run('r'), run('r2', { plan_id: 'ship', inputs: 'x' }), textResponse('done')])
    await turn(first.agent)
    expect(toolTexts(first.agent)[1]).toContain('graph_run: missing run inputs ticket')
    expect(toolTexts(first.agent)[2]).toContain('graph_run: inputs must be an object of run inputs')
    const noProvider = await harness([audit('a', l2Plan()), run('r'), textResponse('done')], { runner: { provider: 'nope' } })
    await turn(noProvider.agent)
    expect(toolTexts(noProvider.agent)[1]).toContain('subagent provider nope is not registered')
    const bare = await harness([audit('a', l2Plan()), run('r'), textResponse('done')], { runner: { provider: 'bare' } })
    bare.ctx.subagents.registerProvider({
      name: 'bare',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: () => Promise.reject(new Error('never started')),
    })
    await turn(bare.agent)
    expect(toolTexts(bare.agent)[1]).toContain('cannot restrict tools and enforce an output schema')
    const noProjection = await harness([audit('a', l2Plan()), run('r'), textResponse('done')], { projection: false })
    await turn(noProjection.agent)
    expect(toolTexts(noProjection.agent)[1]).toContain('mount @deepseek-ai/dsh-experimental-graph-projection')
    const noContract = await harness([run('r'), textResponse('done')], { contract: false })
    await turn(noContract.agent)
    expect(toolTexts(noContract.agent)[0]).toContain('mount @deepseek-ai/dsh-experimental-graph-contract')
  })

  it('registers nothing when off and fails the load on bad config', async () => {
    const off = new Context()
    await mountAgentLoopTestDependencies(off)
    await off.plugin(AgentLoop, { agents: [] })
    await off.plugin(SubagentRuntime)
    await off.plugin(GraphRunner, { mode: 'off' })
    expect(off.tools.get('graph_run')).toBeUndefined()
    const base = { mode: 'enforce', assumption: 'node agents need proof' } satisfies Config
    for (const [config, message] of [
      [{ ...base, assumption: ' ' }, /`assumption` must name/],
      [{ ...base, provider: ' ' }, /provider must name a subagent provider/],
      [{ ...base, maxConcurrent: 0 }, /invalid maxConcurrent 0/],
      [{ ...base, maxPlanVersions: 0 }, /invalid maxPlanVersions 0/],
      [{ ...base, maxDispatches: -1 }, /invalid maxDispatches -1/],
      [{ ...base, verifyTimeoutMs: 0 }, /invalid verifyTimeoutMs 0/],
    ] as const) {
      const ctx = new Context()
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentRuntime)
      await expect(ctx.plugin(GraphRunner, config)).rejects.toThrow(message)
    }
  })

  it('fills run inputs, a fallback for a failed mayFail need, and an absent anchor field, and proves a verification by its command', async () => {
    const { ctx, agent } = await harness([
      audit('a', l2Plan({
        specMayFail: true, checkVerify: ['check-verdict'], runInputs: ['ticket'],
        buildInputs: [{ name: 'ticket', from: 'run', field: 'ticket' }, { name: 'path', from: 'spec', field: 'path', fallback: 'none' }],
      })),
      run('r', { plan_id: 'ship', inputs: { ticket: 'BUG-1' } }),
      structured('b1', { summary: 'fixed' }),
      structured('c1', { verdict: 'pass' }),
      structured('s1', { summary: 'shipped' }),
      textResponse('done'),
    ], { shell: { 'check-spec': 1 } })
    const start = vi.spyOn(ctx.subagents, 'start')
    await turn(agent)
    const brief = JSON.stringify(start.mock.calls[0]?.[1].prompt)
    expect(brief).toContain('ticket (from run input ticket): \\"BUG-1\\"')
    expect(brief).toContain('path (from spec field path): \\"none\\"')
    expect(trail(agent)).toContain('spec:failed')
    expect(trail(agent)).toContain('check:executed(predicate)')
    expect(runRecords(agent).at(-1)?.stopReason).toBe('GOAL_MET')
    const absent = await harness([
      audit('a', l2Plan({ buildInputs: [{ name: 'path', from: 'spec', field: 'path' }] })),
      run('r'),
      structured('b1', { summary: 'fixed' }),
      structured('c1', { verdict: 'pass' }),
      structured('s1', { summary: 'shipped' }),
      textResponse('done'),
    ])
    const absentStart = vi.spyOn(absent.ctx.subagents, 'start')
    await turn(absent.agent)
    expect(JSON.stringify(absentStart.mock.calls[0]?.[1].prompt)).toContain('path (from spec field path): not provided')
  })

  it('stops with NO_FURTHER_WORK when a result needs proof nobody gives, and skips only blocked nodes', async () => {
    const loose = (anchor: boolean): Record<string, unknown> => ({
      format: 'dsh-graph/v1', id: 'ship', level: 'L1', goal: 'Loose',
      nodes: [
        { id: 'draft', kind: 'execution', instruction: 'Draft', output: SUMMARY },
        { id: 'final', kind: 'synthesis', instruction: 'Finish', needs: ['draft'], output: SUMMARY },
        ...anchor ? [{ id: 'gone', kind: 'anchor', instruction: 'Gone', verify: ['bad'] }] : [],
      ],
      edges: [{ from: 'draft', to: 'final', relation: 'feeds', artifact: 'draft' }],
      deliverable: 'Done', acceptance: ['done'],
    })
    const idle = await harness([audit('a', loose(false)), run('r'), structured('d1', { summary: 'x' }), textResponse('done')], { contractMode: 'shadow' })
    await turn(idle.agent)
    expect(runRecords(idle.agent).at(-1)?.stopReason).toBe('NO_FURTHER_WORK')
    const failing = await harness([audit('a', loose(true)), run('r'), structured('d1', { summary: 'x' }), textResponse('done')], { contractMode: 'shadow', shell: { bad: 1 } })
    await turn(failing.agent)
    expect(runRecords(failing.agent).at(-1)?.stopReason).toBe('NO_PROGRESS')
    expect(trail(failing.agent)).not.toContain('final:skipped')
  })

  it('refuses a call without an owning agent and presents the plan id', async () => {
    const { ctx } = await harness([textResponse('unused')])
    const direct = await ctx.tools.execute({ callId: ToolCallId('direct-run'), name: 'graph_run', arguments: { plan_id: 'ship' }, signal: new AbortController().signal })
    expect(direct.isError).toBe(true)
    expect(ctx.tools.get('graph_run')?.presentCall?.({ plan_id: 'ship' })).toEqual({ card: 'generic', title: 'Run graph ship', kind: 'execute' })
    expect(await ctx.waterfall('fs/edit-intent', { targetKey: FsTargetKey('a.md'), displayPath: 'a.md' }, undefined, () => undefined)).toBeUndefined()
  })
})

describe('capability routes', () => {
  it('starts a categorized node on its recorded route', async () => {
    const { ctx, agent } = await harness([
      audit('a', l2Plan({ buildCategory: 'coding' })),
      run('r'),
      structured('b1', { summary: 'fixed' }),
      structured('c1', { verdict: 'pass' }),
      structured('s1', { summary: 'shipped' }),
      textResponse('done'),
    ], { routes: [{ category: 'coding', provider: 'mock', model: 'mock-large' }] })
    const start = vi.spyOn(ctx.subagents, 'start')
    await turn(agent)
    expect(start.mock.calls[0]?.[1].agentOptions).toEqual({ provider: 'mock', model: 'mock-large' })
    expect(start.mock.calls[1]?.[1].agentOptions).toBeUndefined()
  })

  it('fails a categorized node whose route was not recorded, and refuses a provider without agent options', async () => {
    const shadow = await harness([audit('a', l2Plan({ buildCategory: 'coding' })), run('r'), textResponse('done')], { contractMode: 'shadow' })
    await turn(shadow.agent)
    expect(nodeRecords(shadow.agent).find(record => record.nodeId === 'build' && record.status === 'failed')?.detail).toBe('no route is recorded for category coding')
    const fixed = await harness([audit('a', l2Plan({ buildCategory: 'coding' })), run('r'), textResponse('done')], {
      routes: [{ category: 'coding', provider: 'mock', model: 'mock-large' }],
      runner: { provider: 'fixed' },
    })
    fixed.ctx.subagents.registerProvider({
      name: 'fixed',
      capabilities: { agentOptions: false, outputSchema: true, depthLimit: true, toolFilter: true, persona: false },
      inheritsParentContext: false,
      start: () => Promise.reject(new Error('never started')),
    })
    await turn(fixed.agent)
    expect(toolTexts(fixed.agent)[1]).toContain('cannot choose a model for routed categories')
  })
})
