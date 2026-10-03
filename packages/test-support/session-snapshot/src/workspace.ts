/** Capture readable, path-stable workspace state for recorded-session tests. */

import { readFile, readdir, readlink } from 'node:fs/promises'
import { join } from 'node:path'

/** Marker that lets Git retain an expected empty directory without becoming expected workspace state. */
export const EMPTY_WORKSPACE_MARKER = '.empty'

/** One UTF-8 file in a captured workspace. */
export interface WorkspaceTextFileSnapshot {
  /** Cwd-relative POSIX path. */
  readonly path: string
  /** Entry discriminator. */
  readonly kind: 'text'
  /** Exact UTF-8 contents. */
  readonly content: string
}

/** One non-text file in a captured workspace. */
export interface WorkspaceBinaryFileSnapshot {
  /** Cwd-relative POSIX path. */
  readonly path: string
  /** Entry discriminator. */
  readonly kind: 'binary'
  /** Exact bytes encoded for deterministic diffs. */
  readonly base64: string
}

/** One symbolic link in a captured workspace. */
export interface WorkspaceSymlinkSnapshot {
  /** Cwd-relative POSIX path. */
  readonly path: string
  /** Entry discriminator. */
  readonly kind: 'symlink'
  /** Exact link text without resolving the target. */
  readonly target: string
}

/** One empty directory in a captured workspace. */
export interface WorkspaceEmptyDirectorySnapshot {
  /** Cwd-relative POSIX path. */
  readonly path: string
  /** Entry discriminator. */
  readonly kind: 'empty-directory'
}

/** Stable complete file, link, and empty-directory state below one workspace root. */
export type WorkspaceSnapshotEntry =
  | WorkspaceTextFileSnapshot
  | WorkspaceBinaryFileSnapshot
  | WorkspaceSymlinkSnapshot
  | WorkspaceEmptyDirectorySnapshot

/** Options for excluding harness-owned root entries from a runtime workspace. */
export interface CaptureWorkspaceSnapshotOptions {
  /** Exact immediate children of the workspace root to omit. */
  readonly ignoredRootEntries?: readonly string[]
}

function textContent(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined
  const text = bytes.toString('utf8')
  return Buffer.from(text, 'utf8').equals(bytes) ? text : undefined
}

/**
 * Capture one workspace without resolving links or depending on host path separators.
 * @param root - Absolute directory whose user-visible state is captured.
 * @param options - Harness-owned immediate children to omit.
 * @returns Stable entries sorted by relative path.
 */
export async function captureWorkspaceSnapshot(
  root: string,
  options: CaptureWorkspaceSnapshotOptions = {},
): Promise<WorkspaceSnapshotEntry[]> {
  const ignoredRootEntries = new Set(options.ignoredRootEntries ?? [])

  const visit = async (directory: string, segments: readonly string[]): Promise<WorkspaceSnapshotEntry[]> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => segments.length > 0 || !ignoredRootEntries.has(entry.name))
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
    const captured: WorkspaceSnapshotEntry[] = []
    for (const entry of entries) {
      const childSegments = [...segments, entry.name]
      const path = childSegments.join('/')
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        const children = await visit(absolute, childSegments)
        captured.push(...children.length === 0 ? [{ path, kind: 'empty-directory' as const }] : children)
      } else if (entry.isFile()) {
        const bytes = await readFile(absolute)
        const content = textContent(bytes)
        captured.push(content === undefined
          ? { path, kind: 'binary', base64: bytes.toString('base64') }
          : { path, kind: 'text', content })
      } else {
        captured.push({ path, kind: 'symlink', target: await readlink(absolute) })
      }
    }
    return captured
  }

  return visit(root, [])
}

/** Volatile values of one run that a `workspace.tokens` scenario replaces in final text files. */
export interface WorkspaceTokenContext {
  /** Session ids the run issued, in header order; the n-th becomes `{{session:n}}`. */
  readonly sessionIds: readonly string[]
}

const ISO_INSTANT_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g

/**
 * Replace a run's volatile identities and clock readings in captured text
 * files: each session id with the same `{{session:<n>}}` token the committed
 * session log uses, and each ISO-8601 UTC instant with `{{time}}`. Binary
 * files, links, and empty directories are returned unchanged.
 * @param entries - Captured final workspace entries.
 * @param ctx - The run's session ids.
 * @returns Entries with tokenized text content.
 */
export function tokenizeWorkspaceSnapshot(
  entries: readonly WorkspaceSnapshotEntry[],
  ctx: WorkspaceTokenContext,
): WorkspaceSnapshotEntry[] {
  return entries.map((entry) => {
    if (entry.kind !== 'text') return entry
    let content = entry.content
    ctx.sessionIds.forEach((id, index) => { content = content.split(id).join(`{{session:${index + 1}}}`) })
    return { ...entry, content: content.replace(ISO_INSTANT_RE, '{{time}}') }
  })
}

/**
 * Capture a committed `workspace.expected/` tree, excluding its Git-only empty marker.
 * @param root - Absolute expected-workspace directory.
 * @returns Stable expected entries.
 */
export function captureExpectedWorkspaceSnapshot(root: string): Promise<WorkspaceSnapshotEntry[]> {
  return captureWorkspaceSnapshot(root, { ignoredRootEntries: [EMPTY_WORKSPACE_MARKER] })
}
