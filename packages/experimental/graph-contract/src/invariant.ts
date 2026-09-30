/** Graph-contract runtime invariant companion. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { applyGraphPlanEvent, historyOf } from './projection.ts'
import type { GraphPlanRecord } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-graph-contract'

/** Cordis companion plugin name. */
export const name = 'graph-contract-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

/**
 * Whether one record's admission fields contradict its own findings.
 * @param record - the `graph/plan` payload.
 * @param frozen - acceptance frozen by the plan's first parsed version, or null.
 * @returns the violated relation, or undefined when the record is consistent.
 */
export function admissionViolation(record: GraphPlanRecord, frozen: readonly string[] | null): string | undefined {
  const blocking = record.rejections.some(entry => entry.severity === 'reject')
  const has = (code: string): boolean => record.rejections.some(entry => entry.code === code)
  if (record.plan === null && record.admitted) return 'an unparsed plan is recorded as admitted'
  if (record.mode === 'shadow' && record.plan !== null && !record.admitted) return 'a parsed shadow-mode version is recorded as not admitted'
  if (record.mode === 'enforce' && record.admitted && blocking) return 'an admitted enforce-mode version carries a reject finding'
  if (record.mode === 'enforce' && !record.admitted && !blocking) return 'an enforce-mode version without a reject finding is recorded as not admitted'
  if (record.plan === null && !has('SCHEMA_INVALID')) return 'an unparsed plan carries no SCHEMA_INVALID finding'
  if (record.plan !== null && frozen !== null && !deepEqualJson(record.plan.acceptance, frozen) && !has('ACCEPTANCE_CHANGED')) {
    return 'acceptance differs from the frozen list without an ACCEPTANCE_CHANGED finding'
  }
  return undefined
}

/**
 * Every `graph/plan` folds cleanly onto the projected prefix (contiguous
 * versions) and its admission agrees with its mode and findings.
 * @param ctx - child context owned by the invariant registration.
 * @param fail - reporter bound to this package name.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'graph/plan') return
    const prefix = ctx.sessionProjections.stateOf(session, 'graphPlans')
    if (prefix === undefined) return
    const next = applyGraphPlanEvent(prefix, event)
    if (next.failure !== undefined && prefix.failure === undefined) {
      fail(next.failure)
      return
    }
    const frozen = historyOf(prefix, event.data.planId)?.acceptance ?? null
    const violation = admissionViolation(event.data, frozen)
    if (violation !== undefined) fail(`graph/plan ${event.data.planId} version ${event.data.version}: ${violation}`)
  }, { global: true })
}, { inject: ['sessionProjections'] })

/**
 * Register the package invariant companion.
 * @param ctx - companion plugin context with the invariant registry.
 * @returns a promise of the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
