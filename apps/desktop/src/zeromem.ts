/** Locations of the zeromem `zm` executable and embedding model Desktop carries, and the Host environment variables that name them. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Variable the memory-zeromem plugin reads when its `zmPath` is empty; the plugin package owns its resolve order. */
export const ZEROMEM_EXECUTABLE_ENV = 'DSH_ZEROMEM_ZM'

/** Variable the memory-zeromem plugin reads when its `modelDir` is empty; the plugin package owns its resolve order. */
export const ZEROMEM_MODELS_ENV = 'DSH_ZEROMEM_MODELS'

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
 * Path of the carried model directory, which holds bge-small-en-v1.5 in the Hugging Face cache layout `zm` reads.
 * @param runtimeResources - `resources/runtime` of a packaged application, or the target's prepared runtime directory in development.
 * @returns `<runtimeResources>/zeromem/models`.
 */
export function bundledZeromemModels(runtimeResources: string): string {
  return join(runtimeResources, 'zeromem', 'models')
}

/**
 * Host environment additions that point memory-zeromem at the carried `zm` and model.
 * Each variable is added only when its carried path exists and the inherited environment holds no non-empty value;
 * a build without `zm` adds nothing, so the plugin falls back to `zm` on `PATH` and `<store root>/models`, and
 * otherwise fails its load with a named error.
 * @param runtimeResources - Runtime resource directory passed to {@link bundledZeromemExecutable}.
 * @param inherited - Environment the Host would otherwise receive.
 * @param exists - File existence check.
 * @returns `DSH_ZEROMEM_ZM` and `DSH_ZEROMEM_MODELS` additions.
 */
export function zeromemHostEnvironment(
  runtimeResources: string, inherited: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync,
): NodeJS.ProcessEnv {
  const additions: NodeJS.ProcessEnv = {}
  for (const [name, path] of [
    [ZEROMEM_EXECUTABLE_ENV, bundledZeromemExecutable(runtimeResources)],
    [ZEROMEM_MODELS_ENV, bundledZeromemModels(runtimeResources)],
  ] as const) {
    const current = inherited[name]
    if ((current === undefined || current === '') && exists(path)) additions[name] = path
  }
  return additions
}
