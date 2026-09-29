/** Verifier-gate runtime invariant companion. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-verifier-gate'

/** Cordis companion plugin name. */
export const name = 'verifier-gate-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

/**
 * A `loop/verdict` with `continued: true` is followed by a `verifier-gate`
 * steer before its turn ends `completed` or `max-tokens`. Aborted, errored,
 * and blocked turns may legitimately discard pending steering.
 * @param ctx - child context owned by the invariant registration.
 * @param fail - reporter bound to this package name.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  const pending = new WeakMap<Session, number>()
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type === 'loop/verdict' && event.data.continued) {
      pending.set(session, event.data.turn)
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
