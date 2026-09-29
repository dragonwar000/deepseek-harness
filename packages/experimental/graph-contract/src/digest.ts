/**
 * Canonical JSON and plan digests: equal plans that differ only in key order
 * share one digest.
 * @module @deepseek-ai/dsh-experimental-graph-contract/digest
 */

import { createHash } from 'node:crypto'

/**
 * Serialize a JSON value with object keys sorted at every depth.
 * @param value - a lossless JSON value.
 * @returns the canonical text.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Digest a plan or a raw plan input.
 * @param value - the normalized plan, or the raw input when it did not parse.
 * @returns lower-case hex SHA-256 of {@link canonicalJson}.
 */
export function planSha(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}
