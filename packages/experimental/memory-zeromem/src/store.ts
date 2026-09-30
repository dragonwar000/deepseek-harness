/**
 * The zeromem store directory of a session and the files this package writes
 * into it. A store directory is a zeromem home: `zeromem.db` (owned by `zm`),
 * `spool/` (turn files `zm` ingests before every operation), `models/` (the
 * embedding model cache, linked to one directory shared by every store under
 * the same root), and `dsh-forgotten/` (sessions this package no longer
 * stores). Spool files follow zeromem's spool protocol: a complete JSONL file
 * appears under a name ending in `.jsonl`, one `{session_id, speaker, text,
 * ts, uuid}` object per line, and `zm` skips a line whose `uuid` it already
 * stored.
 * @module @deepseek-ai/dsh-experimental-memory-zeromem/store
 */

import { createHash } from 'node:crypto'
import { access, mkdir, symlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** zeromem's dedup key of one stored turn: `dsh:<session id>:<event seq>`. */
export type ZeromemSourceUuid = Branded<'ZeromemSourceUuid'>

/** Which conversations share one store. */
export type StoreScope = 'workspace' | 'global'

/**
 * Where a session's store lives.
 * `storeRoot` is the configured root; empty means `<harness home>/zeromem`.
 */
export interface StoreRequest {
  readonly scope: StoreScope
  readonly storeRoot: string
  /** The session's working directory; required for the `workspace` scope. */
  readonly cwd: string | undefined
}

/** A resolved store: the zeromem home and the model cache shared by every store under the same root. */
export interface StoreSpec {
  readonly home: string
  readonly models: string
}

/** One line of a spool file, in zeromem's field names; `ts` is epoch seconds. */
export interface SpoolTurn {
  readonly session_id: SessionId
  readonly speaker: 'user' | 'assistant'
  readonly text: string
  readonly ts: number
  readonly uuid: ZeromemSourceUuid
}

/** A store could not be resolved for a session. */
export class ZeromemStoreError extends Error {
  /** @param message - what is missing and how to fix it. */
  constructor(message: string) {
    super(message)
    this.name = 'ZeromemStoreError'
  }
}

/**
 * Validate a configured store root.
 * @param storeRoot - configured value; empty selects the default.
 * @returns the absolute root.
 * @throws ZeromemStoreError when a non-empty value is not an absolute path after `~` expansion.
 */
export function resolveStoreRoot(storeRoot: string): string {
  if (storeRoot === '') return join(resolveDshHome(), 'zeromem')
  const expanded = expandHomePath(storeRoot)
  if (!isAbsolute(expanded)) throw new ZeromemStoreError(`memory-zeromem: storeRoot must be an absolute path or start with ~, got ${storeRoot}`)
  return resolve(expanded)
}

/**
 * Resolve the store of one session.
 * @param request - scope, configured root, and the session's working directory.
 * @returns the zeromem home and the shared model cache.
 * @throws ZeromemStoreError for the `workspace` scope when the session has no working directory.
 */
export function resolveStore(request: StoreRequest): StoreSpec {
  const root = resolveStoreRoot(request.storeRoot)
  const models = join(root, 'models')
  if (request.scope === 'global') return { home: join(root, 'global'), models }
  if (request.cwd === undefined) {
    throw new ZeromemStoreError('memory-zeromem: this conversation has no workspace directory, so it has no workspace memory store; set scope: global to use one store for every conversation')
  }
  const key = createHash('sha256').update(resolve(request.cwd)).digest('hex').slice(0, 16)
  return { home: join(root, 'workspaces', key), models }
}

/**
 * Create a store's directories, owner-only, and link its model cache to the shared one.
 * @param spec - the resolved store.
 */
export async function prepareStore(spec: StoreSpec): Promise<void> {
  await mkdir(spec.home, { recursive: true, mode: 0o700 })
  await mkdir(spec.models, { recursive: true, mode: 0o700 })
  try {
    // `zm mcp` caches the embedding model under <home>/models; one shared copy per root.
    await symlink(spec.models, join(spec.home, 'models'), 'junction')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * The dedup key of one stored text.
 * @param sessionId - the session the text belongs to.
 * @param seq - the event sequence number of the text.
 * @returns the key zeromem stores with the turn.
 */
export function sourceUuid(sessionId: SessionId, seq: number): ZeromemSourceUuid {
  return brandString<ZeromemSourceUuid>(`dsh:${sessionId}:${seq}`)
}

let spoolSequence = 0

/**
 * Add turns to a store's spool as one file; `zm` ingests it before its next operation on the store.
 * @param home - the store directory.
 * @param turns - turns in conversation order; must not be empty.
 * @returns the path of the spool file.
 */
export async function spoolTurns(home: string, turns: readonly SpoolTurn[]): Promise<string> {
  spoolSequence += 1
  // zeromem drains spool files in name order; the zero-padded clock keeps that the order they were written.
  const name = `${String(Date.now()).padStart(13, '0')}-${process.pid}-dsh-${spoolSequence}.jsonl`
  const path = join(home, 'spool', name)
  await writeFileAtomic(path, turns.map(turn => `${JSON.stringify(turn)}\n`).join(''), { mode: 0o600, dirMode: 0o700 })
  return path
}

/**
 * Path of a session's forgotten marker.
 * @param home - the store directory.
 * @param sessionId - the session.
 * @returns the marker path.
 */
function forgottenMarker(home: string, sessionId: SessionId): string {
  return join(home, 'dsh-forgotten', createHash('sha256').update(sessionId).digest('hex').slice(0, 32))
}

/**
 * Record that a session was deleted from a store, so later turns of it are not stored again.
 * @param home - the store directory.
 * @param sessionId - the deleted session.
 */
export async function markForgotten(home: string, sessionId: SessionId): Promise<void> {
  const marker = forgottenMarker(home, sessionId)
  await mkdir(join(home, 'dsh-forgotten'), { recursive: true, mode: 0o700 })
  await writeFile(marker, `${sessionId}\n`, { mode: 0o600 })
}

/**
 * Whether a session was deleted from a store.
 * @param home - the store directory.
 * @param sessionId - the session.
 * @returns true when the forgotten marker exists.
 */
export async function isForgotten(home: string, sessionId: SessionId): Promise<boolean> {
  try {
    await access(forgottenMarker(home, sessionId))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
