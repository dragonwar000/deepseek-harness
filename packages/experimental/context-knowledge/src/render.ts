/**
 * Rendering of the knowledge index message: a header line, one line per page
 * newest first, and footers for pages left out, within a line and a byte cap.
 * Pure functions.
 * @module @deepseek-ai/dsh-experimental-context-knowledge/render
 */

import { createHash } from 'node:crypto'
import type { KnowledgeIndex, KnowledgeIndexEntry, KnowledgeInjectRecord, KnowledgePageId } from '@deepseek-ai/dsh-experimental-knowledge'

/** Line and byte caps of one index message. */
export interface IndexLimits {
  /** Most lines, header and footers included. */
  readonly maxLines: number
  /** Most UTF-8 bytes of the whole text. */
  readonly maxBytes: number
}

/** One rendered index and the record describing it. */
export interface RenderedIndex {
  /** Model-facing text. */
  readonly text: string
  /** The `knowledge/inject` payload for this text. */
  readonly record: KnowledgeInjectRecord
}

/** Most characters of a title in one index line. */
const TITLE_CHARS = 120

/**
 * The first line of the index message.
 * @param count - readable pages in the store.
 * @returns the header.
 */
export function indexHeader(count: number): string {
  return `Knowledge index of the workspace knowledge store, newest first (readable pages: ${count}). It lists pages, not their content: read a page with knowledge_read before relying on it, and verify statements about code against the current files before asserting them. A page marked stale depends on a page that changed after it or was superseded.`
}

/**
 * UTF-8 byte length.
 * @param text - any text.
 * @returns the byte count.
 */
function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * The index line of one page.
 * @param entry - index entry.
 * @returns id, title, type, update date, and stale mark.
 */
function entryLine(entry: KnowledgeIndexEntry): string {
  const title = entry.title.replace(/\s+/g, ' ').trim().slice(0, TITLE_CHARS)
  const updated = entry.updated === undefined ? '' : ` updated ${entry.updated.slice(0, 10)}`
  return `- ${entry.id} — ${title} [${entry.type}]${updated}${entry.stale ? ', stale' : ''}`
}

/**
 * The footer naming pages the caps left out.
 * @param count - pages left out.
 * @returns the footer line.
 */
function omittedLine(count: number): string {
  return `Pages not listed here: ${count}; search them with knowledge_query.`
}

/**
 * Render the index within the caps; the newest pages are kept.
 * @param index - store listing.
 * @param limits - line and byte caps; `maxLines` at least 3, `maxBytes` large enough for the header and footers.
 * @returns the text and its record, or `undefined` for a store with no pages at all.
 */
export function renderIndex(index: KnowledgeIndex, limits: IndexLimits): RenderedIndex | undefined {
  if (index.entries.length === 0 && index.quarantined.length === 0) return undefined
  const quarantine = index.quarantined.length === 0 ? [] : [`Pages left out for unreadable frontmatter: ${index.quarantined.length}.`]
  const reserveLines = 1 + quarantine.length
  const reserveBytes = bytesOf(omittedLine(index.entries.length)) + 1 + quarantine.reduce((sum, line) => sum + bytesOf(line) + 1, 0)
  const header = indexHeader(index.entries.length)
  const lines = [header]
  let bytes = bytesOf(header)
  const ids: KnowledgePageId[] = []
  for (const entry of index.entries) {
    const line = entryLine(entry)
    const size = bytesOf(line) + 1
    if (lines.length + 1 + reserveLines > limits.maxLines || bytes + size + reserveBytes > limits.maxBytes) break
    lines.push(line)
    bytes += size
    ids.push(entry.id)
  }
  const omitted = index.entries.length - ids.length
  if (omitted > 0) lines.push(omittedLine(omitted))
  lines.push(...quarantine)
  const text = lines.join('\n')
  return {
    text,
    record: {
      ids,
      bytes: bytesOf(text),
      lines: lines.length,
      omitted,
      quarantined: index.quarantined.length,
      digest: createHash('sha256').update(text, 'utf8').digest('hex'),
    },
  }
}
