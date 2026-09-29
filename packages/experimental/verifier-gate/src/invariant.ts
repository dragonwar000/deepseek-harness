/** Verifier-gate runtime invariant companion. */

import type { Context } from '@deepseek-ai/cordis'
import type { EvidenceState } from '@deepseek-ai/dsh-experimental-graph-projection/types'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type { LoopVerdict } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-verifier-gate'

/** Cordis companion plugin name. */
export const name = 'verifier-gate-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

/**
 * Whether a verdict's evidence contradicts the graphEvidence state it was judged from.
 * @param state - graphEvidence state at the verdict, or undefined when the projection is not registered.
 * @param verdict - the `loop/verdict` payload.
 * @returns the violated relation, or undefined when the evidence matches or is absent.
 */
export function evidenceViolation(state: EvidenceState | undefined, verdict: LoopVerdict): string | undefined {
  const evidence = verdict.evidence
  if (evidence === undefined) return undefined
  if (evidence.status === 'unavailable') return state === undefined ? undefined : 'evidence recorded unavailable while graphEvidence is registered'
  if (state === undefined) return 'evidence recorded without a graphEvidence projection'
  const answer = state.answer !== null && state.answer.turn === verdict.turn ? state.answer.claims : []
  if (!deepEqualJson(evidence.claims, answer.slice(0, evidence.claims.length))) return 'recorded claims differ from the graphEvidence answer of the turn'
  const truncated = evidence.truncated === true
  if (truncated !== answer.length > evidence.claims.length) {
    return `${evidence.claims.length} recorded of ${answer.length} claims ${truncated ? 'marked' : 'not marked'} truncated`
  }
  const unsupported = evidence.claims.filter(claim => claim.leaves.length === 0).map(claim => claim.text)
  if (!deepEqualJson(unsupported, evidence.unsupported)) return 'unsupported claims differ from the claims without leaves'
  if ((evidence.status === 'no-claims') !== (evidence.claims.length === 0)) return `status ${evidence.status} with ${evidence.claims.length} claims`
  if (verdict.reason === 'evidence-unsupported' && evidence.status !== 'unsupported') return `reason evidence-unsupported with status ${evidence.status}`
  return undefined
}

/**
 * A `loop/verdict` with `continued: true` is followed by a `verifier-gate`
 * steer before its turn ends `completed` or `max-tokens`; aborted, errored,
 * and blocked turns may discard pending steering. A verdict's evidence equals
 * the graphEvidence claims of its turn; without the `sessionProjections`
 * service only an `unavailable` evidence record is consistent.
 * @param ctx - child context owned by the invariant registration.
 * @param fail - reporter bound to this package name.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  const pending = new WeakMap<Session, number>()
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type === 'loop/verdict') {
      // Without the sessionProjections service no graphEvidence state exists; the gate refuses to load an evidence check then.
      const violation = evidenceViolation(ctx.get('sessionProjections')?.stateOf(session, 'graphEvidence'), event.data)
      if (violation !== undefined) fail(`loop/verdict turn ${event.data.turn}: ${violation}`)
      if (event.data.continued) pending.set(session, event.data.turn)
    } else if (event.type === 'user/message' && event.data.source.kind === 'verifier-gate') {
      pending.delete(session)
    } else if (event.type === 'turn/end' && pending.get(session) === event.data.turn) {
      pending.delete(session)
      const { kind } = event.data.reason
      if (kind === 'completed' || kind === 'max-tokens') {
        fail(`turn ${event.data.turn} ended ${kind} after a continued loop/verdict without a verifier-gate steer`)
      }
    }
  }, { global: true })
}

/**
 * Register the package invariant companion.
 * @param ctx - companion plugin context with the invariant registry.
 * @returns a promise of the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
