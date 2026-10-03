import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import * as StationarityInvariant from '../src/invariant.ts'
import type { LoopStationarity } from '../src/types.ts'

async function openTurn(id: string): Promise<Session> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(StationarityInvariant)
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  return session
}

const decision = (action: 'remind' | 'stop', applied: boolean): LoopStationarity => ({
  turn: 1, step: 2, mode: applied ? 'enforce' : 'shadow', signature: 'a'.repeat(64),
  tier: 'sideEffect', repeats: 3, noopRun: 0, action, reason: 'repeat', applied,
})

describe('stationarity-guard invariant', () => {
  it('accepts an applied stop followed by a blocked turn end', async () => {
    const session = await openTurn('st-ok')
    session.append('loop/stationarity', decision('stop', true))
    expect(() => session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })).not.toThrow()
  })

  it('rejects a step that starts after an applied stop', async () => {
    const session = await openTurn('st-step')
    session.append('loop/stationarity', decision('stop', true))
    expect(() => session.append('step/start', { turn: 1, step: 3 })).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT', packageName: '@deepseek-ai/dsh-experimental-stationarity-guard',
    }))
  })

  it('rejects a completed turn end after an applied stop', async () => {
    const session = await openTurn('st-completed')
    session.append('loop/stationarity', decision('stop', true))
    expect(() => session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT', packageName: '@deepseek-ai/dsh-experimental-stationarity-guard',
    }))
  })

  it('ignores reminders and shadow stops', async () => {
    const session = await openTurn('st-quiet')
    session.append('loop/stationarity', decision('remind', true))
    session.append('loop/stationarity', decision('stop', false))
    session.append('step/start', { turn: 1, step: 3 })
    expect(() => session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })).not.toThrow()
  })
})
