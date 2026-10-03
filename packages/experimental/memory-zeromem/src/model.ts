/**
 * The embedding model a `zm` built with zeromem's default `fastembed`
 * feature loads, and the directory it loads it from. zeromem 0.3.0 runs
 * fastembed 4.9 with bge-small-en-v1.5 from the Hugging Face repository
 * `Xenova/bge-small-en-v1.5`. `zm mcp --home <home>` looks the files up in the
 * Hugging Face cache under `<home>/models`: `refs/main` names a revision, and
 * `snapshots/<revision>/` holds the files. A missing file is downloaded from
 * huggingface.co at its latest revision, and a model that fails to load makes
 * `zm` fall back to its hash embedder. This package links `<home>/models` to
 * one model directory and runs `zm` with the default embedder only while that
 * directory holds every file, so `zm` never downloads.
 * @module @deepseek-ai/dsh-experimental-memory-zeromem/model
 */

import { access, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { resolveStoreRoot } from './store.ts'

/** Environment variable naming an absolute model directory; Desktop sets it to the model it carries. */
export const ZM_MODELS_ENV = 'DSH_ZEROMEM_MODELS'

/** Hugging Face cache folder of the model inside a model directory. */
export const ZEROMEM_MODEL_FOLDER = 'models--Xenova--bge-small-en-v1.5'

/** Files fastembed 4.9 reads from the model's snapshot, relative to it. */
export const ZEROMEM_MODEL_FILES: readonly string[] = ['onnx/model.onnx', 'tokenizer.json', 'config.json', 'special_tokens_map.json', 'tokenizer_config.json']

/** The default embedder's model is missing or incomplete. */
export class ZeromemModelError extends Error {
  /**
   * @param directory - the model directory.
   * @param missing - what the directory lacks.
   * @param options - the read failure.
   */
  constructor(directory: string, missing: string, options?: ErrorOptions) {
    super(`memory-zeromem: embedder default needs the bge-small-en-v1.5 model in ${directory}, which lacks ${missing}; CTD Core Desktop carries the model and names it with ${ZM_MODELS_ENV}, elsewhere set modelDir to a directory prepared as the memory-zeromem README describes, or set embedder: hash for lexical recall without a model`, options)
    this.name = 'ZeromemModelError'
  }
}

/** A `zm` asked for the default embedder answered on its hash embedder. */
export class ZeromemEmbedderError extends Error {
  /**
   * @param executable - the `zm` that answered.
   * @param directory - the model directory it was given.
   * @param stderr - the `zm` stderr text, which names the load failure.
   */
  constructor(executable: string, directory: string, stderr: string) {
    const detail = stderr === '' ? '' : `; zm stderr: ${stderr}`
    super(`memory-zeromem: ${executable} answered on its hash embedder although embedder is default, so it was built without zeromem's fastembed feature or could not load onnxruntime or the model in ${directory}; use a zm built with default features, or set embedder: hash for lexical recall${detail}`)
    this.name = 'ZeromemEmbedderError'
  }
}

/**
 * Select the model directory: a non-empty `modelDir`, then a non-empty {@link ZM_MODELS_ENV}, then `<store root>/models`.
 * @param request - the configured `modelDir` and store root (empty when unset) and the value of {@link ZM_MODELS_ENV}.
 * @returns the absolute model directory.
 * @throws when `modelDir` is not absolute after `~` expansion or {@link ZM_MODELS_ENV} is relative.
 */
export function resolveModelDir(
  request: { readonly modelDir: string; readonly storeRoot: string; readonly environment: string | undefined },
): string {
  if (request.modelDir !== '') {
    const expanded = expandHomePath(request.modelDir)
    if (!isAbsolute(expanded)) throw new Error(`memory-zeromem: modelDir must be an absolute path or start with ~, got ${request.modelDir}`)
    return resolve(expanded)
  }
  const environment = request.environment ?? ''
  if (environment === '') return join(resolveStoreRoot(request.storeRoot), 'models')
  if (!isAbsolute(environment)) throw new Error(`memory-zeromem: ${ZM_MODELS_ENV} must be an absolute path, got ${environment}`)
  return resolve(environment)
}

/**
 * Check that a model directory holds every file `zm` reads, so `zm` loads the model without a download.
 * @param directory - the model directory.
 * @throws ZeromemModelError naming the first file that cannot be read.
 */
export async function checkZeromemModel(directory: string): Promise<void> {
  const refs = `${ZEROMEM_MODEL_FOLDER}/refs/main`
  const revision = await readFile(join(directory, refs), 'utf8').catch((error: unknown) => {
    throw new ZeromemModelError(directory, refs, { cause: error })
  })
  // zm reads the revision without trimming it, so a line terminator would name another snapshot.
  if (!/^[0-9a-f]{40}$/u.test(revision)) throw new ZeromemModelError(directory, `a commit id in ${refs}`)
  for (const file of ZEROMEM_MODEL_FILES) {
    const path = `${ZEROMEM_MODEL_FOLDER}/snapshots/${revision}/${file}`
    await access(join(directory, path)).catch((error: unknown) => {
      throw new ZeromemModelError(directory, path, { cause: error })
    })
  }
}
