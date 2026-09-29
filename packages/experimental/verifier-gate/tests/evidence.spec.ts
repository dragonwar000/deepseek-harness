import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as GraphProjection from '@deepseek-ai/dsh-experimental-graph-projection'
import type { EvidenceState } from '@deepseek-ai/dsh-experimental-graph-projection'
import * as VerifierGate from '../src/index.ts'
import { evidenceViolation } from '../src/invariant.ts'
import * as GateInvariant from '../src/invariant.ts'
import type { Config } from '../src/index.ts'
import type { LoopEvidence, LoopVerdict } from '../src/types.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const BASE = { mode: 'enforce', assumption: 'the model names files it never looked at' } satisfies Config

async function run(config: Config, script: StreamChunk[][], options: { projection?: boolean } = {}): Promise<Agent> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(GateInvariant)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.projection !== false) await ctx.plugin(GraphProjection)
  await ctx.plugin(VerifierGate, config)
  ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'read', parameters: {}, async execute() { return [{ type: 'text', text: 'contents of src/app.ts' }] } }))
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const agent = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'fix the app' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return agent
}

function verdicts(agent: Agent): LoopVerdict[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'loop/verdict'> => event.type === 'loop/verdict')
    .map(event => event.data)
}

function steers(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'verifier-gate')
    .map(event => event.data.content.map(block => (block.type === 'text' ? block.text : '')).join(''))
}

describe('evidence step', () => {
  it('steers once when the answer names a path no record shows, then accepts the supported answer', async () => {
    const agent = await run({ ...BASE, evidence: { mode: 'enforce' } }, [
      textResponse('Updated `src/app.ts`.'),
      toolCallResponse('r', 'read', { path: 'src/app.ts' }),
      textResponse('Checked `src/app.ts`.'),
    ])
    const [first, second] = verdicts(agent)
    expect(first).toMatchObject({
      verdict: 'not-ok', reason: 'evidence-unsupported', continued: true,
      evidence: { mode: 'enforce', status: 'unsupported', claims: [{ kind: 'path', text: 'src/app.ts', leaves: [] }], unsupported: ['src/app.ts'] },
    })
    expect(second).toMatchObject({ verdict: 'skipped', reason: 'no-commands', continued: false, evidence: { status: 'supported', unsupported: [] } })
    expect(second?.evidence?.claims[0]?.leaves.map(leaf => leaf.kind)).toEqual(['tool-record', 'observed'])
    expect(steers(agent)).toEqual([
      'Your answer names files or commands that no tool call or tool result in this turn shows:\n- src/app.ts\nCheck each one with a tool now, or remove it from the answer, then finish.',
    ])
  })

  it('records evidence in shadow mode without steering', async () => {
    const agent = await run({ ...BASE, evidence: { mode: 'shadow' } }, [textResponse('Updated `src/app.ts` and notes/a.md.')])
    expect(verdicts(agent)).toHaveLength(1)
    expect(verdicts(agent)[0]).toMatchObject({
      verdict: 'skipped', reason: 'no-commands', evidence: { mode: 'shadow', status: 'unsupported', unsupported: ['src/app.ts', 'notes/a.md'] },
    })
    expect(steers(agent)).toEqual([])
  })

  it('accepts an answer with one supported claim when require is any', async () => {
    const agent = await run({ ...BASE, evidence: { mode: 'enforce', require: 'any' } }, [
      toolCallResponse('r', 'read', { path: 'src/app.ts' }),
      textResponse('Read `src/app.ts`; see notes/a.md.'),
    ])
    expect(verdicts(agent)[0]?.evidence).toMatchObject({ status: 'supported', unsupported: ['notes/a.md'] })
    expect(steers(agent)).toEqual([])
  })

  it('records no-claims, truncation, and an unavailable projection', async () => {
    const none = await run({ ...BASE, evidence: { mode: 'enforce' } }, [textResponse('All done.')])
    expect(verdicts(none)[0]?.evidence).toEqual({ mode: 'enforce', status: 'no-claims', claims: [], unsupported: [] })
    const capped = await run({ ...BASE, evidence: { mode: 'shadow', maxClaims: 1 } }, [textResponse('Changed `src/a.ts` and `src/b.ts`.')])
    expect(verdicts(capped)[0]?.evidence).toMatchObject({ claims: [{ text: 'src/a.ts' }], unsupported: ['src/a.ts'], truncated: true })
    const missing = await run({ ...BASE, evidence: { mode: 'enforce' } }, [textResponse('Updated `src/app.ts`.')], { projection: false })
    expect(verdicts(missing)).toHaveLength(1)
    expect(verdicts(missing)[0]).toMatchObject({
      verdict: 'not-ok', reason: 'evidence-unavailable', continued: false,
      evidence: { mode: 'enforce', status: 'unavailable', claims: [], unsupported: [] },
    })
    expect(steers(missing)).toEqual([])
  })

  it('stops steering when the continuation budget is spent', async () => {
    const agent = await run({ ...BASE, maxContinuations: 0, evidence: { mode: 'enforce' } }, [textResponse('Updated `src/app.ts`.')])
    expect(verdicts(agent)).toHaveLength(1)
    expect(verdicts(agent)[0]).toMatchObject({ verdict: 'not-ok', reason: 'budget-exhausted', continued: false, evidence: { status: 'unsupported' } })
  })

  it.each<[Config, RegExp]>([
    [{ ...BASE, mode: 'shadow', evidence: { mode: 'enforce' } }, /evidence\.mode enforce needs mode enforce/],
    [{ ...BASE, evidence: { mode: 'shadow', maxClaims: 0 } }, /invalid evidence\.maxClaims 0/],
  ])('fails the load on %o', async (config, message) => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(VerifierGate, config)).rejects.toThrow(message)
  })

  it('fails the load without the sessionProjections service', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(VerifierGate, { ...BASE, evidence: { mode: 'shadow' } })).rejects.toThrow(/evidence\.mode needs the sessionProjections service/)
  })

  it('reports a fabricated evidence record through the invariant', async () => {
    const agent = await run({ ...BASE, evidence: { mode: 'enforce' } }, [textResponse('All done.')])
    expect(() => agent.session.append('loop/verdict', {
      turn: 1, mode: 'enforce', verdict: 'ok', reason: 'all-passed', checks: [], continuation: 0, continued: false,
      evidence: { mode: 'enforce', status: 'supported', claims: [{ kind: 'path', text: 'src/other.ts', leaves: [] }], unsupported: [] },
    })).toThrow(InvariantError)
  })
})

describe('evidenceViolation', () => {
  const claim = (text: string, supported: boolean) => ({ kind: 'path' as const, text, leaves: supported ? [{ kind: 'observed' as const, seq: 4, tool: 'read' }] : [] })
  const state = (claims: ReturnType<typeof claim>[], turn = 1): EvidenceState => ({
    turn, calls: [], paths: [], commands: [], answer: { turn, seq: 5, claims },
  })
  const verdict = (evidence: LoopEvidence, reason: LoopVerdict['reason'] = 'no-commands'): LoopVerdict => ({
    turn: 1, mode: 'enforce', verdict: 'skipped', reason, checks: [], continuation: 0, continued: false, evidence,
  })
  const record = (claims: ReturnType<typeof claim>[], rest: Partial<LoopEvidence> = {}): LoopEvidence => ({
    mode: 'enforce', status: claims.length === 0 ? 'no-claims' : 'supported', claims, unsupported: claims.filter(entry => entry.leaves.length === 0).map(entry => entry.text), ...rest,
  })
  const bare = (): LoopVerdict => {
    const { evidence: _dropped, ...rest } = verdict(record([]))
    return rest
  }

  it.each<[string, EvidenceState | undefined, LoopVerdict, string | undefined]>([
    ['a verdict without evidence', undefined, bare(), undefined],
    ['unavailable without a projection', undefined, verdict(record([], { status: 'unavailable' })), undefined],
    ['unavailable with a projection', state([]), verdict(record([], { status: 'unavailable' })), 'evidence recorded unavailable while graphEvidence is registered'],
    ['evidence without a projection', undefined, verdict(record([])), 'evidence recorded without a graphEvidence projection'],
    ['matching claims', state([claim('src/a.ts', true)]), verdict(record([claim('src/a.ts', true)])), undefined],
    ['an answer of another turn', state([claim('src/a.ts', true)], 2), verdict(record([])), undefined],
    ['different claims', state([claim('src/a.ts', true)]), verdict(record([claim('src/b.ts', true)])), 'recorded claims differ from the graphEvidence answer of the turn'],
    ['a missing truncation mark', state([claim('src/a.ts', true), claim('src/b.ts', true)]), verdict(record([claim('src/a.ts', true)])), '1 recorded of 2 claims not marked truncated'],
    ['a false truncation mark', state([claim('src/a.ts', true)]), verdict(record([claim('src/a.ts', true)], { truncated: true })), '1 recorded of 1 claims marked truncated'],
    ['a wrong unsupported list', state([claim('src/a.ts', false)]), verdict(record([claim('src/a.ts', false)], { unsupported: [], status: 'unsupported' })), 'unsupported claims differ from the claims without leaves'],
    ['no-claims with claims', state([claim('src/a.ts', true)]), verdict(record([claim('src/a.ts', true)], { status: 'no-claims' })), 'status no-claims with 1 claims'],
    ['a steer without unsupported status', state([claim('src/a.ts', true)]), verdict(record([claim('src/a.ts', true)]), 'evidence-unsupported'), 'reason evidence-unsupported with status supported'],
  ])('%s', (_label, projected, recorded, expected) => {
    expect(evidenceViolation(projected, recorded)).toBe(expected)
  })
})
