/** Denial-budget runtime invariant companion. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval/types'
import './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-denial-budget'

/** Cordis companion plugin name. */
export const name = 'denial-budget-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

/**
 * Every `loop/denial` with decision `approved` follows an
 * `approval/decided{outcome:'allowed-once'}` recorded after the session's
 * latest `counted` denial.
 * @param ctx - child context owned by the invariant registration.
 * @param fail - reporter bound to this package name.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  const granted = new WeakMap<Session, boolean>()
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type === 'approval/decided') {
      granted.set(session, event.data.outcome === 'allowed-once')
      return
    }
    if (event.type !== 'loop/denial') return
    if (event.data.decision === 'counted') granted.set(session, false)
    if (event.data.decision === 'approved' && granted.get(session) !== true) {
      fail(`loop/denial approved in turn ${event.data.turn} without an allowed-once approval/decided after the latest counted denial`)
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
