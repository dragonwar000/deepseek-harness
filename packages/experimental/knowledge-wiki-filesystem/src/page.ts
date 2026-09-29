/**
 * Page text of the wiki store: frontmatter parsing, body links, code path
 * candidates, and the rendering of written pages (port of the link
 * extraction in overstack `wiki-graph.py`). Pure functions.
 * @module @deepseek-ai/dsh-experimental-knowledge-wiki-filesystem/page
 */

import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { isDeclaredRelation, knowledgePageId } from '@deepseek-ai/dsh-experimental-knowledge'
import type {
  KnowledgeEntry,
  KnowledgeCitation,
  KnowledgeRelationDeclaration,
  KnowledgeWriter,
} from '@deepseek-ai/dsh-experimental-knowledge'

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
const FENCE = /```[\s\S]*?```/g
const INLINE_CODE = /`[^`\n]*`/g
const WIKILINK = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g
const MDLINK = /\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g
const CODE_PATH = /`([\w./-]+\.[A-Za-z0-9]+)`/g
const ORIGIN = /^##\s+Origin\b/m

const frontmatterSchema = z.looseObject({ type: z.string().trim().min(1) })
const relationSchema = z.object({ rel: z.string(), to: z.string() })
const citationSchema = z.object({
  session: z.string().trim().min(1),
  seqs: z.array(z.number().int().nonnegative()).min(1),
  sources: z.array(z.string()),
  writer: z.enum(['tool', 'distill']),
})

/** Citation a page records in its frontmatter. */
export interface PageCitation {
  /** Session id whose events are cited. */
  session: string
  /** Cited `tool/result` seqs. */
  seqs: number[]
  /** Workspace files the cited events read or changed. */
  sources: string[]
  /** Who wrote the page. */
  writer: KnowledgeWriter
}

/** Frontmatter fields the store reads; other keys stay in the file and are ignored. */
export interface PageFront {
  /** Non-empty page type. */
  type: string
  /** Title, when set and not blank. */
  title?: string
  /** Last provider write, when set. */
  updated?: string
  /** Declared relations with a known relation name and a `to` target. */
  relations: KnowledgeRelationDeclaration[]
  /** Citation, when complete. */
  citation?: PageCitation
}

/** Result of parsing one page file. */
export type PageParse =
  | {
    kind: 'page'
    front: PageFront
    /** Text after the frontmatter block. */
    body: string
    /** Whether the body has a `## Origin` section. */
    origin: boolean
  }
  | {
    kind: 'quarantined'
    /** Sentence naming why the page is unreadable. */
    reason: string
  }

/**
 * First capture group of a match of one of this module's patterns.
 * @param match - a match of a pattern whose first group is mandatory.
 * @returns the group text.
 */
function captured(match: RegExpMatchArray): string {
  const value = match[1]
  /* v8 ignore next -- every pattern in this module has a mandatory first group */
  if (value === undefined) throw new Error('knowledge-wiki-filesystem: a pattern matched without its first group')
  return value
}

/**
 * A non-blank string frontmatter value.
 * @param value - raw YAML value.
 * @returns the trimmed string, or `undefined` for anything else.
 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Parse one page file.
 * @param content - full file text.
 * @returns the page fields and body, or a quarantine reason.
 */
export function parsePage(content: string): PageParse {
  const match = FRONTMATTER.exec(content)
  if (match === null) return { kind: 'quarantined', reason: 'The page has no YAML frontmatter block.' }
  let data: unknown
  try {
    data = parseYaml(captured(match))
  } catch (error: unknown) {
    return { kind: 'quarantined', reason: `The frontmatter is not YAML: ${String(error).split('\n', 1).join('')}` }
  }
  const parsed = frontmatterSchema.safeParse(data)
  if (!parsed.success) return { kind: 'quarantined', reason: 'The frontmatter is not a mapping with a non-empty type.' }
  const relations: KnowledgeRelationDeclaration[] = []
  const declared = parsed.data['relations']
  for (const raw of Array.isArray(declared) ? declared : []) {
    const relation = relationSchema.safeParse(raw)
    if (relation.success && isDeclaredRelation(relation.data.rel)) {
      relations.push({ relation: relation.data.rel, to: knowledgePageId(relation.data.to.trim()) })
    }
  }
  const citation = citationSchema.safeParse(parsed.data['citation'])
  const title = text(parsed.data['title'])
  const updated = text(parsed.data['updated'])
  const body = content.slice(match[0].length)
  return {
    kind: 'page',
    front: {
      type: parsed.data.type.trim(),
      ...title === undefined ? {} : { title },
      ...updated === undefined ? {} : { updated },
      relations,
      ...citation.success ? { citation: citation.data } : {},
    },
    body,
    origin: ORIGIN.test(body),
  }
}

/**
 * Blank out fenced and inline code, whose links are examples, not links.
 * @param markdown - page body.
 * @returns the body with code replaced by spaces.
 */
export function stripCode(markdown: string): string {
  return markdown.replace(FENCE, ' ').replace(INLINE_CODE, ' ')
}

/**
 * Distinct values in first-seen order.
 * @param values - values with repeats.
 * @returns the values without repeats.
 */
function distinct(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/**
 * Targets of `[[wikilink]]`s outside code, without anchors and aliases.
 * @param body - page body.
 * @returns distinct non-blank target names.
 */
export function wikilinkTargets(body: string): string[] {
  return distinct([...stripCode(body).matchAll(WIKILINK)].map(match => captured(match).trim()).filter(name => name !== ''))
}

/**
 * Targets of Markdown links to `.md` files outside code.
 * @param body - page body.
 * @returns distinct link targets relative to the page, without anchors.
 */
export function mdlinkTargets(body: string): string[] {
  return distinct([...stripCode(body).matchAll(MDLINK)].map(match => captured(match)))
}

/**
 * Backticked paths that name a directory and end in a configured extension.
 * Existence is checked by the caller.
 * @param body - page body; code is not stripped because paths live in inline code.
 * @param extensions - accepted file extensions without the dot.
 * @returns distinct candidate paths.
 */
export function codePathCandidates(body: string, extensions: ReadonlySet<string>): string[] {
  return distinct([...body.matchAll(CODE_PATH)]
    .map(match => captured(match))
    .filter(path => path.includes('/') && extensions.has(path.slice(path.lastIndexOf('.') + 1))))
}

/**
 * Collapse whitespace runs into single spaces.
 * @param value - text that may span lines.
 * @returns one trimmed line.
 */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * Render one page: frontmatter with citation, a title heading, the body, and
 * an Origin section. Relations use the flow form overstack tools read.
 * @param entry - page to render.
 * @param citation - the session events the page is based on.
 * @param updated - ISO time of this write.
 * @returns the full file text.
 */
export function renderPage(entry: KnowledgeEntry, citation: KnowledgeCitation, updated: string): string {
  const title = oneLine(entry.title)
  const lines = ['---', `type: ${JSON.stringify(entry.type)}`, `title: ${JSON.stringify(title)}`, `updated: ${JSON.stringify(updated)}`]
  if (entry.relations.length > 0) {
    lines.push('relations:')
    for (const relation of entry.relations) lines.push(`  - {rel: ${relation.relation}, to: ${relation.to}}`)
  }
  lines.push(
    'citation:',
    `  session: ${JSON.stringify(citation.sessionId)}`,
    `  seqs: [${citation.sourceEventSeqs.join(', ')}]`,
    `  sources: ${JSON.stringify(citation.sources)}`,
    `  writer: ${citation.writer}`,
    '---',
    '',
    `# ${title}`,
    '',
  )
  const body = entry.body.trim()
  if (body !== '') lines.push(body, '')
  lines.push(
    '## Origin',
    '',
    `- Session: \`${citation.sessionId}\``,
    `- Source events: ${citation.sourceEventSeqs.join(', ')}`,
    `- Sources: ${citation.sources.map(source => `\`${source}\``).join(', ')}`,
    `- Writer: ${citation.writer}`,
    '',
  )
  return lines.join('\n')
}
