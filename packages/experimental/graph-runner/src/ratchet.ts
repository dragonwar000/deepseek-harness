/**
 * Keep-best ratchet for node retries. After a failed attempt the runner measures
 * a metric command, keeps the write scopes of the best attempt, and restores them
 * before the next attempt when a later attempt measured worse. Pure helpers and
 * the snapshot and restore operations over the file service; the runner decides
 * when they run.
 * @module @deepseek-ai/dsh-experimental-graph-runner/ratchet
 */

import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'

/** `max`: a higher metric is better; `min`: a lower one is. */
export type RatchetDirection = 'max' | 'min'

/** The ratchet settings the runner reads. */
export interface RatchetSettings {
  /** Shell command whose last stdout line is the metric. */
  readonly metric: string
  /** Which direction counts as better. */
  readonly direction: RatchetDirection
  /** Most bytes of write-scope text one snapshot may hold. */
  readonly maxBytes: number
}

/** The file operations a snapshot and a restore use. */
export type RatchetFiles = Pick<FileSystem, 'resolve' | 'stat' | 'listDir' | 'readText' | 'writeText'>

/** Workspace-relative path to the exact text of that file. */
export type RatchetSnapshot = ReadonlyMap<string, string>

/** What one restore did. */
export interface RatchetRestore {
  /** Files written or removed. */
  readonly restored: number
  /** Paths that could not be removed. */
  readonly leftovers: string[]
}

/**
 * The metric a command printed: its last non-blank stdout line as a finite number.
 * @param stdout - the command's stdout.
 * @returns the number, or null when there is no such line.
 */
export function parseMetric(stdout: string): number | null {
  const lines = stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  const last = lines.at(-1)
  if (last === undefined) return null
  const value = Number(last)
  return Number.isFinite(value) ? value : null
}

/**
 * Whether a candidate metric beats the kept one. Equal is not better, so a tie keeps the earlier attempt.
 * @param candidate - the new metric.
 * @param kept - the metric of the kept attempt.
 * @param direction - which direction is better.
 * @returns true when the candidate is strictly better.
 */
export function isBetter(candidate: number, kept: number, direction: RatchetDirection): boolean {
  return direction === 'max' ? candidate > kept : candidate < kept
}

const SAFE_PATH = /^[A-Za-z0-9._/-]+$/

/**
 * The shell command that removes one file the restore created. Only paths made of letters, digits, `.`, `_`, `-`, and
 * `/` qualify, so the command needs no quoting; anything else is left in place and reported.
 * @param path - workspace-relative path.
 * @returns the command, or undefined when the path is not safe to hand to the shell.
 */
export function removalCommand(path: string): string | undefined {
  if (!SAFE_PATH.test(path) || path.startsWith('/') || path.split('/').includes('..')) return undefined
  return `rm -f -- ${path}`
}

/**
 * Options for resolving one path against the session working directory.
 * @param cwd - the working directory, when the session has one.
 * @param signal - cancellation.
 * @returns the resolve options.
 */
function resolveOptions(cwd: string | undefined, signal: AbortSignal): { cwd?: string; signal: AbortSignal } {
  return cwd === undefined ? { signal } : { cwd, signal }
}

/**
 * Read every file under the write-scope prefixes as text.
 * @param files - the file operations.
 * @param cwd - the working directory the prefixes resolve against.
 * @param writes - the node's normalized write-scope prefixes.
 * @param maxBytes - the most text the snapshot may hold.
 * @param signal - cancellation.
 * @returns the snapshot, or undefined when a file is not text or the snapshot would exceed `maxBytes`.
 */
export async function captureScope(
  files: RatchetFiles,
  cwd: string | undefined,
  writes: readonly string[],
  maxBytes: number,
  signal: AbortSignal,
): Promise<RatchetSnapshot | undefined> {
  const snapshot = new Map<string, string>()
  let bytes = 0
  /**
   * Add one path, descending into directories.
   * @param path - workspace-relative path.
   * @returns false when the snapshot cannot hold the scope.
   */
  async function add(path: string): Promise<boolean> {
    const target = await files.resolve(path, resolveOptions(cwd, signal))
    const info = await files.stat(target, signal)
    if (info === undefined) return true
    if (info.type === 'directory') {
      for (const entry of await files.listDir(target, signal)) {
        if (!await add(`${path}/${entry.name}`)) return false
      }
      return true
    }
    if (info.type !== 'file') return false
    const text = await readTextOrUndefined(files, target, signal)
    if (text === undefined) return false
    bytes += new TextEncoder().encode(text).byteLength
    if (bytes > maxBytes) return false
    snapshot.set(path, text)
    return true
  }
  for (const prefix of writes) {
    if (!await add(prefix)) return undefined
  }
  return snapshot
}

/**
 * The text of one file, or undefined when the backend cannot read it as text.
 * @param files - the file operations.
 * @param target - the resolved file.
 * @param signal - cancellation.
 * @returns the text or undefined.
 */
async function readTextOrUndefined(files: RatchetFiles, target: FsTarget, signal: AbortSignal): Promise<string | undefined> {
  try {
    return await files.readText(target, signal)
  } catch {
    // Binary or invalid UTF-8 cannot be restored as text; the caller treats the scope as unsnapshottable.
    return undefined
  }
}

/**
 * Return the write scopes to the kept snapshot: rewrite every kept file whose text differs, and remove each file
 * that the kept snapshot does not hold. A removal the shell cannot do is reported as a leftover.
 * @param files - the file operations.
 * @param cwd - the working directory the prefixes resolve against.
 * @param kept - the snapshot to return to.
 * @param current - the scope as it is now, or undefined when it cannot be read; then only kept files are written.
 * @param remove - removes one workspace-relative file, returning false when it could not.
 * @param signal - cancellation.
 * @returns how many files changed and which could not be removed.
 */
export async function restoreScope(
  files: RatchetFiles,
  cwd: string | undefined,
  kept: RatchetSnapshot,
  current: RatchetSnapshot | undefined,
  remove: (path: string) => Promise<boolean>,
  signal: AbortSignal,
): Promise<RatchetRestore> {
  let restored = 0
  const leftovers: string[] = []
  for (const [path, text] of kept) {
    if (current?.get(path) === text) continue
    const target = await files.resolve(path, resolveOptions(cwd, signal))
    await files.writeText(target, text, undefined, signal)
    restored += 1
  }
  if (current === undefined) return { restored, leftovers: ['(the write scope could not be read)'] }
  for (const path of current.keys()) {
    if (kept.has(path)) continue
    if (await remove(path)) restored += 1
    else leftovers.push(path)
  }
  return { restored, leftovers }
}
