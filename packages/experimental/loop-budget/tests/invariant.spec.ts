import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import * as BudgetInvariant from '../src/invariant.ts'
import type { BudgetKind, LoopBudget } from '../src/types.ts'

async function twoSteps(id: string): Promise<Session> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(BudgetInvariant)
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  session.append('step/end', { turn: 1, step: 2 })
  return session
}

const trip = (kind: BudgetKind, used: number): LoopBudget => ({
  turn: 1, step: 3, mode: 'enforce', scope: 'turn', kind, used, limit: 2, action: 'stopped', applied: true, source: 'root',
})

describe('loop-budget invariant', () => {
  it('accepts a steps record that matches the logged step count', async () => {
    const session = await twoSteps('lb-ok')
    expect(() => session.append('loop/budget', trip('steps', 2))).not.toThrow()
  })

  it('rejects a steps record that disagrees with the log', async () => {
    const session = await twoSteps('lb-bad')
    expect(() => session.append('loop/budget', trip('steps', 1)))
      .toThrow(expect.objectContaining<Partial<InvariantError>>({ code: 'INVARIANT', packageName: '@deepseek-ai/dsh-experimental-loop-budget' }))
  })

  it('ignores other kinds', async () => {
    const session = await twoSteps('lb-tokens')
    expect(() => session.append('loop/budget', trip('tokens', 999))).not.toThrow()
  })
})
