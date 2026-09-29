/**
 * Knowledge index context. At the first step of a turn, when the store's index
 * differs from the last one this session received, the plugin appends a
 * `knowledge/inject` record and adds the index — page ids, titles, types,
 * update dates, and stale marks, never page content — as a snapshot-form user
 * message within the configured line and byte caps.
 * @module @deepseek-ai/dsh-experimental-context-knowledge
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-knowledge'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import { renderIndex } from './render.ts'

export { indexHeader, renderIndex } from './render.ts'
export type { IndexLimits, RenderedIndex } from './render.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Knowledge store index added at the first step of a turn when it changed.
     * @persistenceAttribution
     */
    'knowledge-context': { kind: 'knowledge-context' } & ContextFormed
  }
}

const stateSchema = zod.object({
  /** Digest of the last `knowledge/inject` of the session, or null before the first. */
  digest: zod.string().nullable(),
})

/** Folded knowledge context state of one session. */
export type KnowledgeContextState = zod.infer<typeof stateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Digest of the last knowledge index the session received. */
    knowledgeContext: KnowledgeContextState
  }
}

/** Cordis plugin name. */
export const name = 'context-knowledge'
/** Services the plugin needs. */
export const inject = ['knowledge', 'sessionProjections']

/** Caps of the index message. Invalid values fail plugin load. */
export interface Config {
  /** Most lines of the index message, header and footers included; at least 3 (default 200). */
  maxLines?: number
  /** Most UTF-8 bytes of the index message; at least 1024 (default 25600). */
  maxBytes?: number
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  maxLines: z.number().default(200),
  maxBytes: z.number().default(25600),
})

/**
 * Register the digest projection and the pre-step listener.
 * @param ctx - plugin context; both registrations dispose with it.
 * @param config - caps.
 * @throws when a cap is out of range.
 */
export function apply(ctx: Context, config: Config): void {
  const limits = { maxLines: config.maxLines as number, maxBytes: config.maxBytes as number }
  if (!Number.isSafeInteger(limits.maxLines) || limits.maxLines < 3) throw new Error('context-knowledge: maxLines must be an integer of at least 3')
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1024) throw new Error('context-knowledge: maxBytes must be an integer of at least 1024')

  ctx.sessionProjections.register({
    key: 'knowledgeContext',
    stateVersion: 1,
    stateSchema,
    init: () => ({ digest: null }),
    apply: (state, event) => (event.type === 'knowledge/inject' ? { digest: event.data.digest } : state),
  })

  ctx.on('agent/pre-step', async ({ agent, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || step !== 1) return decision
    const rendered = renderIndex(await ctx.knowledge.index({ cwd: agent.session.header.cwd, signal }), limits)
    if (rendered === undefined) return decision
    const state = ctx.sessionProjections.stateOf(agent.session, 'knowledgeContext')
    /* v8 ignore next -- apply() registered the unit before the listener that reads it */
    if (state === undefined) throw new Error('context-knowledge: the knowledgeContext projection is not registered')
    if (state.digest === rendered.record.digest) return decision
    agent.session.append('knowledge/inject', rendered.record)
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text: rendered.text }],
          source: { kind: 'knowledge-context', form: 'snapshot', sections: [{ name: 'knowledge-context', text: rendered.text }] },
        }),
      ],
    }
  }, { prepend: true })
}
