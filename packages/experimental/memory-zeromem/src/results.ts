/**
 * zeromem tool results, validated at the process boundary and converted to
 * the values the model-facing tools return: stored turns with their session
 * id, time, and speaker; store counters; and a deletion count.
 * @module @deepseek-ai/dsh-experimental-memory-zeromem/results
 */

import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ZeromemProcessError } from './zm.ts'

const evidenceSchema = z.looseObject({
  session_id: z.string(),
  speaker: z.string(),
  text: z.string(),
  ts: z.number().int(),
  role: z.enum(['Main', 'GraphBridge', 'LocalNeighbor']),
})

const recallSchema = z.looseObject({
  evidence: z.array(evidenceSchema),
  warning: z.unknown().optional(),
})

const statsSchema = z.looseObject({
  turns: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  embedder_is_fallback: z.boolean(),
})

const forgetSchema = z.looseObject({
  deleted_turns: z.number().int().nonnegative(),
})

/** One recalled turn as the model reads it. */
export interface RecalledTurn {
  readonly session: SessionId
  /** ISO 8601 UTC time the turn was stored for. */
  readonly time: string
  readonly speaker: string
  readonly text: string
  /** `match` answers the query directly; `context` is linked to a match by a shared name or by adjacency. */
  readonly kind: 'match' | 'context'
  /** Present when `text` was cut to the configured bound. */
  readonly truncated?: true
}

/** A recall result and whether zeromem ran on its lexical fallback embedder. */
export interface Recall {
  readonly turns: RecalledTurn[]
  readonly fallbackEmbedder: boolean
}

/** Store counters the model reads. */
export interface MemoryStats {
  readonly turns: number
  readonly sessions: number
  readonly fallbackEmbedder: boolean
}

/**
 * Fail with a named error for a result that does not match zeromem's documented fields.
 * @param tool - the zeromem tool.
 * @param issues - the validation failure.
 * @returns never.
 */
function unexpected(tool: string, issues: z.ZodError): never {
  throw new ZeromemProcessError(`zm answered ${tool} with unexpected fields: ${issues.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`)
}

/**
 * Convert a `zeromem_recall` result.
 * @param value - the parsed result.
 * @param maxTurnChars - most characters of text per turn.
 * @returns the recalled turns in zeromem's order.
 */
export function recallOf(value: unknown, maxTurnChars: number): Recall {
  const parsed = recallSchema.safeParse(value)
  if (!parsed.success) return unexpected('zeromem_recall', parsed.error)
  const turns = parsed.data.evidence.map((evidence): RecalledTurn => {
    const truncated = evidence.text.length > maxTurnChars
    return {
      session: SessionId(evidence.session_id),
      time: new Date(evidence.ts * 1000).toISOString().replace('.000Z', 'Z'),
      speaker: evidence.speaker,
      text: truncated ? evidence.text.slice(0, maxTurnChars) : evidence.text,
      kind: evidence.role === 'Main' ? 'match' : 'context',
      ...truncated ? { truncated: true as const } : {},
    }
  })
  return { turns, fallbackEmbedder: parsed.data.warning !== undefined }
}

/**
 * Convert a `zeromem_stats` result.
 * @param value - the parsed result.
 * @returns the counters.
 */
export function statsOf(value: unknown): MemoryStats {
  const parsed = statsSchema.safeParse(value)
  if (!parsed.success) return unexpected('zeromem_stats', parsed.error)
  return { turns: parsed.data.turns, sessions: parsed.data.sessions, fallbackEmbedder: parsed.data.embedder_is_fallback }
}

/**
 * Convert a `zeromem_forget_session` result.
 * @param value - the parsed result.
 * @returns the number of deleted turns.
 */
export function deletedTurnsOf(value: unknown): number {
  const parsed = forgetSchema.safeParse(value)
  if (!parsed.success) return unexpected('zeromem_forget_session', parsed.error)
  return parsed.data.deleted_turns
}
