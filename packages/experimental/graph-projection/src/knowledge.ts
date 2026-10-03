/**
 * Knowledge leaves: a claim that names a page or an edge of the mounted
 * `knowledge` store gets a `graph-edge` leaf. The store is an optional peer:
 * it is read through `ctx.get('knowledge')`, never injected, and without it
 * edge ids are not claims and no claim gets a knowledge leaf.
 * @module @deepseek-ai/dsh-experimental-graph-projection/knowledge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { KnowledgeScope } from '@deepseek-ai/dsh-experimental-knowledge'
import type { CitedClaim, EvidenceClaim, KnowledgeLeaf } from './types.ts'

/**
 * Whether a knowledge store is mounted.
 * @param ctx - any context of the application.
 * @returns true when the `knowledge` service is registered.
 */
export function knowledgeMounted(ctx: Context): boolean {
  return ctx.get('knowledge') !== undefined
}

/**
 * The claims a judgement considers: every claim with a knowledge store, and
 * every path and command claim without one.
 * @param claims - claims of one answer.
 * @param mounted - whether a knowledge store is mounted.
 * @returns the claims in answer order.
 */
export function judgedClaims(claims: readonly EvidenceClaim[], mounted: boolean): EvidenceClaim[] {
  return mounted ? [...claims] : claims.filter(claim => claim.kind !== 'edge')
}

/**
 * Add a `graph-edge` leaf to every claim the mounted knowledge store resolves:
 * a `.md` path claim that equals a readable page id or the store root joined
 * with one, and an edge id for which the store returns exactly one edge.
 * @param ctx - any context of the application.
 * @param scope - session working directory and cancellation for the store.
 * @param claims - claims with their record leaves.
 * @returns the claims with knowledge leaves appended, or the same claims when no store is mounted; store I/O
 *   failures reject.
 */
export async function citeKnowledge(ctx: Context, scope: KnowledgeScope, claims: readonly EvidenceClaim[]): Promise<CitedClaim[]> {
  const knowledge = ctx.get('knowledge')
  const pageClaims = claims.filter(claim => claim.kind === 'path' && claim.text.endsWith('.md'))
  if (knowledge === undefined || (pageClaims.length === 0 && claims.every(claim => claim.kind !== 'edge'))) return [...claims]
  const root = knowledge.storeRoot?.replace(/^\.\//u, '').replace(/\/+$/u, '')
  const pages = pageClaims.length === 0 ? [] : (await knowledge.index(scope)).entries.map(entry => String(entry.id))
  const cited: CitedClaim[] = []
  for (const claim of claims) {
    let leaf: KnowledgeLeaf | undefined
    if (claim.kind === 'edge') {
      const edges = await knowledge.cite(scope, claim.text)
      if (edges.length === 1) leaf = { kind: 'graph-edge', target: 'edge', ref: claim.text }
    } else if (pageClaims.includes(claim)) {
      const page = pages.find(id => claim.text === id || (root !== undefined && claim.text === `${root}/${id}`))
      if (page !== undefined) leaf = { kind: 'graph-edge', target: 'page', ref: page }
    }
    cited.push(leaf === undefined ? claim : { ...claim, leaves: [...claim.leaves, leaf] })
  }
  return cited
}
