/**
 * Tool-call path helpers shared by knowledge consumers that derive the files
 * a page cites from the session log: the path argument of a call, and the
 * pending calls that wait for their result.
 * @module @deepseek-ai/dsh-experimental-knowledge/tool-path
 */

import { z } from 'zod'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'

const pathArguments = z.looseObject({ file_path: z.string().optional(), path: z.string().optional() })

/**
 * The path argument of a logged file tool call (`tool/call.arguments`).
 * @param raw - the call's raw JSON arguments.
 * @returns the trimmed `file_path`, else `path`, or `undefined` when neither is a non-blank string.
 */
export function pathArgument(raw: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (_error: unknown) {
    // Arguments the model wrote as invalid JSON name no path, so the call cannot be a source.
    return undefined
  }
  const args = pathArguments.safeParse(parsed)
  if (!args.success) return undefined
  const path = (args.data.file_path ?? args.data.path ?? '').trim()
  return path === '' ? undefined : path
}

/** Path arguments of tool calls still waiting for their result, by call id. */
export type PendingToolPaths = Readonly<Record<string, string>>

/** Pending paths after one `tool/call` or `tool/result`, and the path a successful result completed. */
export interface ToolPathFold {
  /** Pending paths after the event. */
  readonly pending: Record<string, string>
  /** Present when the event is a successful result of a tracked call. */
  readonly completed?: { readonly path: string; readonly seq: SessionSeq }
}

/**
 * Fold one committed event into the pending paths of tracked tool calls. A
 * `tool/call` of one of `tools` that names a path waits for its result; its
 * `tool/result` settles it, and a successful one completes the path.
 * @param tools - tool names whose calls are tracked.
 * @param pending - pending paths before the event.
 * @param event - any committed session event.
 * @returns the pending paths and the completed path, or `undefined` when the event changes neither.
 */
export function foldToolPath(tools: ReadonlySet<string>, pending: PendingToolPaths, event: SessionEvent): ToolPathFold | undefined {
  switch (event.type) {
    case 'tool/call': {
      const path = tools.has(event.data.name) ? pathArgument(event.data.arguments) : undefined
      return path === undefined ? undefined : { pending: { ...pending, [event.data.callId]: path } }
    }
    case 'tool/result': {
      const callId = event.data.message.toolCallId
      const path = pending[callId]
      if (path === undefined) return undefined
      const rest = Object.fromEntries(Object.entries(pending).filter(([key]) => key !== callId))
      return event.data.message.isError === true ? { pending: rest } : { pending: rest, completed: { path, seq: event.seq } }
    }
    default:
      // SessionEventMap is merge-extensible; only tool calls and their results move pending paths.
      return undefined
  }
}
