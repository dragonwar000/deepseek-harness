/**
 * Tool-call path helpers shared by knowledge consumers that derive the files
 * a page cites from the session log.
 * @module @deepseek-ai/dsh-experimental-knowledge/tool-path
 */

import { z } from 'zod'

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
