/**
 * Fail-closed guard of the knowledge store. File tool writes and edits whose
 * target lies inside the store are refused in `fs/write-intent` and
 * `fs/edit-intent`, registered ahead of the observation policy; shell tool
 * calls whose command names the store after a writing verb are refused by a
 * tool guard. Pages then change only through `ctx.knowledge.write`, which
 * checks the store rules and cites the session events a page is based on.
 * @module @deepseek-ai/dsh-experimental-knowledge-rules
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-knowledge'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-tools'
import { shellWriteReason, STORE_WRITE_REASON } from './shell.ts'

export { normalizeStoreRoot, shellWriteReason, STORE_WRITE_REASON } from './shell.ts'

/** Cordis plugin name. */
export const name = 'knowledge-rules'
/** Services the guard needs. */
export const inject = ['knowledge', 'fs', 'tools']

/** Guard settings. */
export interface Config {
  /** Tool names whose `command` argument is a shell command line (default `bash`, `pwsh`). */
  shellTools?: string[]
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  shellTools: z.array(z.string()).default(['bash', 'pwsh']),
})

/**
 * Session working directory of the tool call behind a filesystem intent.
 * @param actor - the fs seam's opaque actor, the executing ToolRunContext.
 * @returns the calling session's working directory, when there is one.
 */
function actorCwd(actor: object | undefined): string | undefined {
  // The fs seam passes the executing ToolRunContext; graph-runner's write scopes read it the same way.
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- The analyzers disagree on this weak type.
  return (actor as { agent?: Pick<Agent, 'session'> } | undefined)?.agent?.session.header.cwd
}

const shellArguments = zod.looseObject({ command: zod.string() })

/**
 * The `command` argument of a shell tool call.
 * @param args - parsed tool arguments.
 * @returns the command line, when the tool has a string `command` argument.
 */
function commandOf(args: unknown): string | undefined {
  const parsed = shellArguments.safeParse(args)
  return parsed.success ? parsed.data.command : undefined
}

/**
 * Register the intent listeners and the shell guard.
 * @param ctx - plugin context; every registration disposes with it.
 * @param config - guard settings.
 * @throws when a shell tool name is blank.
 */
export function apply(ctx: Context, config: Config): void {
  const shellTools = new Set(config.shellTools as string[])
  if ([...shellTools].some(tool => tool.trim() === '')) throw new Error('knowledge-rules: shellTools entries must be tool names')

  async function refuseStoreWrite(target: FsTarget, actor: object | undefined): Promise<void> {
    if (await ctx.knowledge.includes({ cwd: actorCwd(actor) }, ctx.fs.processPath(target))) {
      throw new Error(`knowledge-rules: ${STORE_WRITE_REASON} Target: ${target.displayPath}`)
    }
  }
  ctx.on('fs/write-intent', async (target, actor, next) => {
    await refuseStoreWrite(target, actor)
    return await next()
  }, { prepend: true })
  ctx.on('fs/edit-intent', async (target, actor, next) => {
    await refuseStoreWrite(target, actor)
    return await next()
  }, { prepend: true })

  const storeRoot = ctx.knowledge.storeRoot
  if (storeRoot === undefined) return
  ctx.tools.guard((execution) => {
    if (!shellTools.has(execution.name)) return undefined
    const command = commandOf(execution.arguments)
    return command === undefined ? undefined : shellWriteReason(command, storeRoot)
  })
}
