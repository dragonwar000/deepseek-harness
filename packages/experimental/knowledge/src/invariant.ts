/** Knowledge runtime invariant companion. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-knowledge'

/** Cordis companion plugin name. */
export const name = 'knowledge-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

/** Successful tool results of one session, from the first event this process observed. */
interface Observed {
  readonly first: number
  readonly results: Set<number>
}

/**
 * Every applied `knowledge/write` cites at least one event, and every cited
 * event at or after the first event this process observed for the session is
 * an earlier successful `tool/result` of that session.
 * @param ctx - child context owned by the invariant registration.
 * @param fail - reporter bound to this package name.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  const sessions = new WeakMap<Session, Observed>()
  const observe = (session: Session, seq: number): Observed => {
    const created: Observed = { first: seq, results: new Set() }
    sessions.set(session, created)
    return created
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const observed = sessions.get(session) ?? observe(session, event.seq)
    if (event.type === 'tool/result') {
      if (event.data.message.isError !== true) observed.results.add(event.seq)
      return
    }
    if (event.type !== 'knowledge/write' || !event.data.applied) return
    if (event.data.sourceEventSeqs.length === 0) {
      fail(`knowledge/write ${event.data.id} was applied without a source event`)
      return
    }
    const unsupported = event.data.sourceEventSeqs.filter(seq => seq >= observed.first && !observed.results.has(seq))
    if (unsupported.length > 0) {
      fail(`knowledge/write ${event.data.id} cites ${unsupported.join(', ')}, which are not successful tool/result events of this session`)
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
