/** Stationarity-guard runtime invariant companion. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-stationarity-guard'

/** Cordis companion plugin name. */
export const name = 'stationarity-guard-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

/**
 * An applied `loop/stationarity` stop rejects the next step, so the session's
 * next `step/start` or `turn/end` is a `turn/end` whose reason is `blocked`;
 * `aborted` and `error` endings may race the rejection.
 * @param ctx - child context owned by the invariant registration.
 * @param fail - reporter bound to this package name.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  const stopped = new WeakSet<Session>()
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type === 'loop/stationarity') {
      if (event.data.action === 'stop' && event.data.applied) stopped.add(session)
      return
    }
    if (!stopped.has(session)) return
    if (event.type === 'step/start') {
      stopped.delete(session)
      fail(`step ${event.data.step} of turn ${event.data.turn} started after an applied stationarity stop`)
    }
    if (event.type === 'turn/end') {
      stopped.delete(session)
      const { kind } = event.data.reason
      if (kind !== 'blocked' && kind !== 'aborted' && kind !== 'error') {
        fail(`turn ${event.data.turn} ended ${kind} after an applied stationarity stop`)
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
