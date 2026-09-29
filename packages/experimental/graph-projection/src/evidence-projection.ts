/**
 * The `graphEvidence` projection: the paths and commands the current turn's
 * tool calls and tool results mention, and the claims of the turn's latest
 * assistant message with their leaves. Records reset at every `turn/start`.
 * Replacement tool results and the graph_cite tool's own calls are skipped.
 * @module @deepseek-ai/dsh-experimental-graph-projection/evidence-projection
 */

import { z } from 'zod'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { argumentStrings, claimsOf, commandOf, leavesFor, pathsIn, withMentions } from './evidence.ts'
import type { EvidenceLeaf, EvidenceState } from './types.ts'

/** The citation tool; its own calls and results are never evidence. */
export const CITE_TOOL = 'graph_cite'

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const leafSchema = z.object({ kind: z.enum(['tool-record', 'observed', 'absence']), seq: count, tool: z.string() }).strict()
const mentionSchema = z.object({ text: z.string(), leaves: z.array(leafSchema) }).strict()

/** `graphEvidence` state schema. */
export const evidenceStateSchema = z.object({
  turn: count,
  calls: z.array(z.object({ callId: z.string(), tool: z.string() }).strict()),
  paths: z.array(mentionSchema),
  commands: z.array(mentionSchema),
  answer: z.object({
    turn: count,
    seq: count,
    claims: z.array(z.object({ kind: z.enum(['path', 'command']), text: z.string(), leaves: z.array(leafSchema) }).strict()),
  }).strict().nullable(),
}).strict() as z.ZodType<EvidenceState>

/**
 * The state before any turn.
 * @returns no records and no answer.
 */
export function emptyEvidence(): EvidenceState {
  return { turn: 0, calls: [], paths: [], commands: [], answer: null }
}

/**
 * Join the text blocks of message content.
 * @param content - message content.
 * @returns the text blocks separated by newlines.
 */
function textOf(content: readonly ContentBlock[]): string {
  return content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function applyCall(state: EvidenceState, event: SessionEvent<'tool/call'>): EvidenceState {
  const calls = [...state.calls, { callId: event.data.callId, tool: event.data.name }]
  if (event.data.name === CITE_TOOL) return { ...state, calls }
  const strings = argumentStrings(event.data.arguments)
  const leaf: EvidenceLeaf = { kind: 'tool-record', seq: event.seq, tool: event.data.name }
  const commands = strings.flatMap((value) => {
    const command = commandOf(value)
    return command === undefined ? [] : [command]
  })
  return {
    ...state,
    calls,
    paths: withMentions(state.paths, strings.flatMap(value => pathsIn(value, true)), leaf),
    commands: withMentions(state.commands, commands, leaf),
  }
}

function applyResult(state: EvidenceState, event: SessionEvent<'tool/result'>): EvidenceState {
  // agent-loop appends every original result with surfaceOp 'append'; a replacement (such as a pruned result) is not new evidence.
  if (event.surfaceOp !== 'append') return state
  const call = state.calls.find(entry => entry.callId === event.data.message.source.callId)
  if (call === undefined || call.tool === CITE_TOOL) return state
  const paths = pathsIn(textOf(event.data.message.content), true)
  if (paths.length === 0) return state
  const leaf: EvidenceLeaf = { kind: event.data.message.isError === true ? 'absence' : 'observed', seq: event.seq, tool: call.tool }
  return { ...state, paths: withMentions(state.paths, paths, leaf) }
}

function applyAnswer(state: EvidenceState, event: SessionEvent<'assistant/message'>): EvidenceState {
  const claims = claimsOf(textOf(event.data.message.content))
    .map(claim => ({ ...claim, leaves: leavesFor(claim, state.paths, state.commands) }))
  return { ...state, answer: { turn: event.data.turn, seq: event.seq, claims } }
}

/**
 * Fold one event.
 * @param state - state before the event.
 * @param event - any committed Session event.
 * @returns the same state for unrelated events, otherwise the next state.
 */
export function applyEvidenceEvent(state: EvidenceState, event: SessionEvent): EvidenceState {
  switch (event.type) {
    case 'turn/start': return { ...emptyEvidence(), turn: event.data.turn }
    case 'tool/call': return applyCall(state, event)
    case 'tool/result': return applyResult(state, event)
    case 'assistant/message': return applyAnswer(state, event)
    // SessionEventMap is merge-extensible; every other event leaves the evidence unchanged.
    default: return state
  }
}

/** Host-only projection unit registered by the graph-projection plugin. */
export const graphEvidenceProjection = {
  key: 'graphEvidence',
  stateVersion: 1,
  stateSchema: evidenceStateSchema,
  init: emptyEvidence,
  apply: applyEvidenceEvent,
} satisfies ProjectionDefinition<'graphEvidence', EvidenceState>
