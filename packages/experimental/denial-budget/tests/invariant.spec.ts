import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as DenialInvariant from '../src/invariant.ts'
import type { DenialDecision, LoopDenial } from '../src/types.ts'

async function openTurn(id: string): Promise<Session> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(DenialInvariant)
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  return session
}

const denial = (decision: DenialDecision): LoopDenial => ({
  turn: 1, mode: 'enforce', toolName: 'danger', callId: ToolCallId('d1'), consecutive: 3, total: 3, decision, applied: true,
})

const decided = (session: Session, outcome: ApprovalOutcome): void => {
  session.append('approval/decided', { id: ApprovalRequestId('r1'), outcome })
}

const VIOLATION: Partial<InvariantError> = { code: 'INVARIANT', packageName: '@deepseek-ai/dsh-experimental-denial-budget' }

describe('denial-budget invariant', () => {
  it('accepts an approval after an allowed-once decision', async () => {
    const session = await openTurn('dn-ok')
    session.append('loop/denial', denial('counted'))
    decided(session, 'allowed-once')
    expect(() => session.append('loop/denial', denial('approved'))).not.toThrow()
  })

  it('rejects an approval with no decision after the latest count', async () => {
    const session = await openTurn('dn-missing')
    decided(session, 'allowed-once')
    session.append('loop/denial', denial('counted'))
    expect(() => session.append('loop/denial', denial('approved'))).toThrow(expect.objectContaining(VIOLATION))
  })

  it('rejects an approval after a rejected decision', async () => {
    const session = await openTurn('dn-rejected')
    session.append('loop/denial', denial('counted'))
    decided(session, 'rejected')
    expect(() => session.append('loop/denial', denial('approved'))).toThrow(expect.objectContaining(VIOLATION))
  })

  it('ignores stopped decisions', async () => {
    const session = await openTurn('dn-stopped')
    session.append('loop/denial', denial('counted'))
    expect(() => session.append('loop/denial', denial('stopped'))).not.toThrow()
  })
})
