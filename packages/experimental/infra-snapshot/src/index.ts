/**
 * Appends one `infra/snapshot` session event when an agent is created, so a
 * run's host facts are reconstructable from its log (infrastructure is an
 * experimental variable: runs compare only when snapshots match).
 * @module @deepseek-ai/dsh-experimental-infra-snapshot
 */

import os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, SessionStartSource } from '@deepseek-ai/dsh-agent'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { InfraSnapshot } from './types.ts'

export type { InfraSnapshot } from './types.ts'

export const name = 'infra-snapshot'

/** Plugin config: the event is appended only for agents matching `sources` (default: every source). */
export interface Config {
  /** Session start sources to snapshot (`startup` | `resume` | `clear` | `compact`); empty means all. */
  sources?: string[]
}

export const Config: z<Config> = z.object({
  sources: z.array(z.string()).default([]),
})

/** Capture the host facts once. */
function capture(shell: ShellExecutor | undefined): InfraSnapshot {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    totalMemMb: Math.round(os.totalmem() / 1_048_576),
    sandboxMode: shell?.sandboxMode ?? 'none',
  }
}

/**
 * Install the listener.
 * @param ctx - plugin context; the listener disposes with it.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const sources = new Set(config.sources as string[])
  ctx.on('agent/created', ({ agent, source }: { agent: Agent; source: SessionStartSource }) => {
    if (sources.size > 0 && !sources.has(source)) return
    agent.session.append('infra/snapshot', capture(ctx.get('shell')))
  })
}
