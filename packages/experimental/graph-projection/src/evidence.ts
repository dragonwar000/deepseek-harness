/**
 * Heuristic evidence: the file paths and shell commands that tool calls and
 * tool results mention, and the claims an assistant message makes by naming
 * paths, commands, and knowledge edge ids. Pure, deterministic functions with
 * no model call. A path or command claim is supported when a record of the
 * same turn mentions it.
 * @module @deepseek-ai/dsh-experimental-graph-projection/evidence
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { EvidenceClaimKind, EvidenceLeaf, EvidenceLeafKind, EvidenceMention } from './types.ts'

/** A path, command, or knowledge edge id an answer names or a caller cites. */
export interface ClaimText {
  /** Path, command, or edge id. */
  readonly kind: EvidenceClaimKind
  /** Normalized text. */
  readonly text: string
}

const TOKEN_SPLIT = /[\s"'`()[\]{}<>,;|]+/u
const TRAILING = /[.:!?]+$/u
const LOCATION = /:\d+(?::\d+)?$/u
const FILE_NAME = /^[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{1,7}$/u
const WORD = /\w/u
const ROOTED = /^(?:\/|~\/|\.\.\/)/u
const INLINE_CODE = /`([^`\n]+)`/gu
const FENCE = /```[\s\S]*?```/gu
const EDGE_ID = /^e:[0-9a-f]{8}$/u
const LEAF_ORDER: readonly EvidenceLeafKind[] = ['tool-record', 'observed', 'absence']

/**
 * Normalize one token into a path.
 * @param token - one token split on whitespace, quotes, and brackets.
 * @param loose - accept `name.ext` and any slash path (records, inline code); otherwise only rooted paths
 *   and slash paths ending in a file name (prose).
 * @returns the path without `./`, a trailing slash, trailing punctuation, or a `:line[:col]` suffix;
 *   undefined when the token is not a path.
 */
export function pathOf(token: string, loose: boolean): string | undefined {
  const path = token.replace(TRAILING, '').replace(LOCATION, '').replace(/^\.\//u, '').replace(/\/+$/u, '')
  if (path === '' || path.includes('://') || path.startsWith('-')) return undefined
  if (!path.includes('/')) return loose && FILE_NAME.test(path) ? path : undefined
  if (!path.split('/').some(segment => WORD.test(segment))) return undefined
  return loose || ROOTED.test(path) || FILE_NAME.test(path.slice(path.lastIndexOf('/') + 1)) ? path : undefined
}

/**
 * Distinct paths in a text.
 * @param text - free text.
 * @param loose - see {@link pathOf}.
 * @returns paths in first-seen order.
 */
export function pathsIn(text: string, loose: boolean): string[] {
  const found = new Set<string>()
  for (const token of text.split(TOKEN_SPLIT)) {
    const path = pathOf(token, loose)
    if (path !== undefined) found.add(path)
  }
  return [...found]
}

/**
 * Read a value as a shell command.
 * @param value - a string argument or inline code.
 * @returns the whitespace-collapsed single-line value when it contains a space, otherwise undefined.
 */
export function commandOf(value: string): string | undefined {
  const command = value.trim().replace(/\s+/gu, ' ')
  return value.includes('\n') || !command.includes(' ') ? undefined : command
}

/**
 * Classify one cited or inline-code claim.
 * @param text - the claim text.
 * @returns a command when it contains whitespace, a path when it reads as one, otherwise undefined.
 */
export function claimOf(text: string): ClaimText | undefined {
  const trimmed = text.trim()
  if (/\s/u.test(trimmed)) {
    const command = commandOf(trimmed)
    return command === undefined ? undefined : { kind: 'command', text: command }
  }
  const path = pathOf(trimmed, true)
  return path === undefined ? undefined : { kind: 'path', text: path }
}

/**
 * Read one cited text or token as a knowledge edge id.
 * @param text - the claim text.
 * @returns an edge claim for `e:` and eight lowercase hex digits after trailing punctuation is removed, otherwise undefined.
 */
export function edgeClaimOf(text: string): ClaimText | undefined {
  const id = text.trim().replace(TRAILING, '')
  return EDGE_ID.test(id) ? { kind: 'edge', text: id } : undefined
}

/**
 * The claims of an answer: inline code that reads as a path, command, or
 * knowledge edge id, then prose paths and prose edge ids; fenced code blocks
 * are ignored.
 * @param answer - the assistant message text.
 * @returns distinct claims in answer order.
 */
export function claimsOf(answer: string): ClaimText[] {
  const prose = answer.replace(FENCE, ' ')
  const claims = new Map<string, ClaimText['kind']>()
  for (const match of prose.matchAll(INLINE_CODE)) {
    const claim = claimOf(String(match[1])) ?? edgeClaimOf(String(match[1]))
    if (claim !== undefined) claims.set(claim.text, claim.kind)
  }
  const outside = prose.replace(INLINE_CODE, ' ')
  for (const path of pathsIn(outside, false)) {
    if (!claims.has(path)) claims.set(path, 'path')
  }
  for (const token of outside.split(TOKEN_SPLIT)) {
    const edge = edgeClaimOf(token)
    if (edge !== undefined && !claims.has(edge.text)) claims.set(edge.text, 'edge')
  }
  return [...claims].map(([text, kind]) => ({ kind, text }))
}

/**
 * Every string inside a JSON value.
 * @param value - parsed JSON.
 * @returns strings in document order.
 */
function stringsIn(value: JsonValue): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsIn)
  return []
}

/**
 * Every string in the raw arguments of one tool call.
 * @param raw - the `tool/call` arguments exactly as the model wrote them.
 * @returns strings in document order; none when the arguments do not parse.
 */
export function argumentStrings(raw: string): string[] {
  let parsed: JsonValue
  try {
    parsed = JSON.parse(raw) as JsonValue
  } catch (error) {
    // Model-written arguments may be malformed JSON; such a call mentions nothing, and the SyntaxError itself is no evidence.
    void error
    return []
  }
  return stringsIn(parsed)
}

/**
 * Add one leaf to the mentions of several texts.
 * @param list - current mentions, sorted by text.
 * @param texts - texts the record mentions.
 * @param leaf - the record's leaf; it replaces an older leaf of the same kind.
 * @returns mentions sorted by text, leaves in kind order.
 */
export function withMentions(list: readonly EvidenceMention[], texts: readonly string[], leaf: EvidenceLeaf): EvidenceMention[] {
  const byText = new Map(list.map(mention => [mention.text, mention.leaves]))
  for (const text of texts) {
    const leaves = (byText.get(text) ?? []).filter(entry => entry.kind !== leaf.kind)
    byText.set(text, [...leaves, leaf].sort((left, right) => LEAF_ORDER.indexOf(left.kind) - LEAF_ORDER.indexOf(right.kind)))
  }
  // Map keys are distinct, so the comparator never compares a text with itself.
  return [...byText].sort(([left], [right]) => (left < right ? -1 : 1)).map(([text, leaves]) => ({ text, leaves }))
}

/**
 * Whether a mentioned path names the claimed path.
 * @param claim - claimed path.
 * @param mention - mentioned path.
 * @returns true when equal or one ends with the other on a `/` boundary.
 */
export function pathMatches(claim: string, mention: string): boolean {
  return claim === mention || mention.endsWith(`/${claim}`) || claim.endsWith(`/${mention}`)
}

/**
 * The leaves that support one claim.
 * @param claim - the claim.
 * @param paths - mentioned paths of the turn.
 * @param commands - mentioned commands of the turn.
 * @returns the latest leaf per kind among matching mentions, in kind order; empty for a parametric claim and for
 *   an edge id, which no record leaf supports.
 */
export function leavesFor(claim: ClaimText, paths: readonly EvidenceMention[], commands: readonly EvidenceMention[]): EvidenceLeaf[] {
  if (claim.kind === 'edge') return []
  const matching = claim.kind === 'path'
    ? paths.filter(mention => pathMatches(claim.text, mention.text))
    : commands.filter(mention => mention.text.includes(claim.text))
  const latest = new Map<EvidenceLeafKind, EvidenceLeaf>()
  for (const leaf of matching.flatMap(mention => mention.leaves)) {
    const seen = latest.get(leaf.kind)
    if (seen === undefined || leaf.seq > seen.seq) latest.set(leaf.kind, leaf)
  }
  return LEAF_ORDER.flatMap((kind) => {
    const leaf = latest.get(kind)
    return leaf === undefined ? [] : [leaf]
  })
}
