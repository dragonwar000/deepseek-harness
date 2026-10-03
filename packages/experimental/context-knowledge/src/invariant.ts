/** Context-knowledge runtime invariant companion. */

import type { Context } from '@deepseek-ai/cordis'
import type { KnowledgeInjectRecord } from '@deepseek-ai/dsh-experimental-knowledge'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-context-knowledge'

/** Cordis companion plugin name. */
export const name = 'context-knowledge-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

/**
 * Every `user/message` with source kind `knowledge-context` follows a
 * `knowledge/inject` of the same turn whose `bytes` equals the message's UTF-8
 * text length, and a turn records at most one undelivered inject at a time.
 * @param ctx - child context owned by the invariant registration.
 * @param fail - reporter bound to this package name.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  const pending = new WeakMap<Session, KnowledgeInjectRecord>()
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    switch (event.type) {
      case 'turn/start':
        pending.delete(session)
        return
      case 'knowledge/inject':
        if (pending.has(session)) fail('knowledge/inject recorded while the previous index of this turn was not delivered')
        pending.set(session, event.data)
        return
      case 'user/message': {
        if (event.data.source.kind !== 'knowledge-context') return
        const record = pending.get(session)
        pending.delete(session)
        if (record === undefined) {
          fail('knowledge-context message without a knowledge/inject record in the same turn')
          return
        }
        /* v8 ignore next -- the plugin writes text-only index messages; other block kinds exist only in the ContentBlock type */
        const bytes = Buffer.byteLength(event.data.content.map(block => (block.type === 'text' ? block.text : '')).join(''), 'utf8')
        if (bytes !== record.bytes) fail(`knowledge-context message has ${bytes} bytes; knowledge/inject recorded ${record.bytes}`)
        return
      }
      default:
        // SessionEventMap is merge-extensible; other events do not affect index delivery.
        return
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
