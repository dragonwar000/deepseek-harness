/**
 * Pure types of the infra snapshot: the ONE home of the `infra/snapshot`
 * session-event declaration.
 * @module @deepseek-ai/dsh-experimental-infra-snapshot/types
 */

/** Host facts captured once per agent so runs can be compared only when they match. */
export interface InfraSnapshot {
  /** `process.version`, e.g. `v22.19.0`. */
  node: string
  /** `process.platform`. */
  platform: string
  /** `process.arch`. */
  arch: string
  /** Logical CPU count. */
  cpus: number
  /** Total memory in MiB. */
  totalMemMb: number
  /** The mounted shell's default sandbox mode, or `none` when no shell or no sandboxing. */
  sandboxMode: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Host facts at agent creation. Log-only; never derived history. */
    'infra/snapshot': InfraSnapshot
  }
}
