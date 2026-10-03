import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId, type Session, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as GateInvariant from '../src/invariant.ts'
import '../src/index.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(GateInvariant)
  return ctx
}

const verdict = (turn: number, continued: boolean) =>
  ({ turn, mode: 'enforce' as const, verdict: 'not-ok' as const, reason: 'command-failed' as const, checks: [], continuation: 0, continued })

function openContinuedTurn(ctx: Context, id: string): Session {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('loop/verdict', verdict(1, true))
  return session
}

const endTurn = (session: Session, reason: TurnEndReason) => () => session.append('turn/end', { turn: 1, reason })

describe('verifier-gate invariant', () => {
  it('accepts a continued verdict followed by a gate steer before turn/end', async () => {
    const session = openContinuedTurn(await setup(), 'gate-ok')
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'fix' }], source: { kind: 'verifier-gate' } }), { surfaceOp: 'append' })
    expect(endTurn(session, { kind: 'completed' })).not.toThrow()
  })

  it.each([
    [{ kind: 'completed' }],
    [{ kind: 'max-tokens' }],
  ] satisfies [TurnEndReason][])('rejects turn/end %j after a continued verdict with no steer', async (reason) => {
    const session = openContinuedTurn(await setup(), 'gate-bad')
    expect(endTurn(session, reason))
      .toThrow(expect.objectContaining<Partial<InvariantError>>({ code: 'INVARIANT', packageName: '@deepseek-ai/dsh-experimental-verifier-gate' }))
  })

  it('accepts an aborted turn that discarded the pending steer, and forgets it afterwards', async () => {
    const session = openContinuedTurn(await setup(), 'gate-aborted')
    expect(endTurn(session, { kind: 'aborted', reason: { kind: 'user' } })).not.toThrow()
    session.append('turn/start', { turn: 2 })
    expect(() => session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })).not.toThrow()
  })

  it('ignores verdicts that did not continue and user messages from other sources', async () => {
    const session = (await setup()).sessions.create(SessionId('gate-quiet'))
    session.append('turn/start', { turn: 1 })
    session.append('loop/verdict', verdict(1, false))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    expect(endTurn(session, { kind: 'completed' })).not.toThrow()
  })
})
