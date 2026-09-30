/** Location of the zeromem `zm` executable Desktop carries, and the Host environment variable that names it. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Variable the memory-zeromem plugin reads when its `zmPath` is empty; the plugin package owns its resolve order. */
export const ZEROMEM_EXECUTABLE_ENV = 'DSH_ZEROMEM_ZM'

/**
 * Path of the carried `zm` inside a runtime resource directory.
 * @param runtimeResources - `resources/runtime` of a packaged application, or the target's prepared runtime directory in development.
 * @param platform - Platform of the prepared runtime.
 * @returns `<runtimeResources>/zeromem/zm`, with `.exe` on Windows.
 */
export function bundledZeromemExecutable(runtimeResources: string, platform: NodeJS.Platform = process.platform): string {
  return join(runtimeResources, 'zeromem', platform === 'win32' ? 'zm.exe' : 'zm')
}

/**
 * Host environment additions that point memory-zeromem at the carried `zm`.
 * An inherited non-empty value wins; a build without `zm` adds nothing, so the plugin falls back to `zm` on `PATH`
 * and otherwise fails its load with a named error.
 * @param executable - Carried `zm` path from {@link bundledZeromemExecutable}.
 * @param inherited - Environment the Host would otherwise receive.
 * @param exists - File existence check.
 * @returns `{ DSH_ZEROMEM_ZM: executable }`, or no additions.
 */
export function zeromemHostEnvironment(
  executable: string, inherited: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync,
): NodeJS.ProcessEnv {
  const current = inherited[ZEROMEM_EXECUTABLE_ENV]
  if (current !== undefined && current !== '') return {}
  return exists(executable) ? { [ZEROMEM_EXECUTABLE_ENV]: executable } : {}
}
