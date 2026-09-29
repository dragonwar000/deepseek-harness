/** Loop-budget runtime invariant companion. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-loop-budget'

/** Cordis companion plugin name. */
export const name = 'loop-budget-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

/**
 * A turn-scoped `loop/budget` of kind `steps` reports exactly the number of
 * `step/start` events its turn has logged so far.
 * @param ctx - child context owned by the invariant registration.
 * @param fail - reporter bound to this package name.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  const started = new WeakMap<Session, { turn: number; steps: number }>()
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type === 'turn/start') {
      started.set(session, { turn: event.data.turn, steps: 0 })
      return
    }
    const count = started.get(session)
    if (count === undefined) return
    if (event.type === 'step/start' && event.data.turn === count.turn) count.steps += 1
    if (event.type === 'loop/budget' && event.data.scope === 'turn' && event.data.kind === 'steps'
      && event.data.turn === count.turn && event.data.used !== count.steps) {
      fail(`loop/budget reports ${event.data.used} steps for turn ${count.turn}, but the log started ${count.steps}`)
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
