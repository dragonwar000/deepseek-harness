/**
 * One fresh, structured, time-bounded child run over the `ctx.subagents`
 * seam. The provider must start the child without the parent conversation
 * and support structured output, tool scoping, and a per-child persona. The
 * run is always disposed; a start or result failure settles as data so the
 * caller can fail closed. Nothing here depends on the verifier gate.
 * @module @deepseek-ai/dsh-experimental-verifier-gate/fresh-run
 */

import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SubagentCapabilities,
  SubagentProvider,
  SubagentRun,
  SubagentStartRequest,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema, ToolRestriction } from '@deepseek-ai/dsh-tools'

/** The `ctx.subagents` operation a fresh run needs; `SubagentRuntime` satisfies it structurally. */
export interface FreshRunStarter {
  /**
   * Start one one-shot child on a named provider.
   * @param name - the registered provider name.
   * @param request - the start request.
   * @returns the published run.
   */
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>
}

/**
 * Explain why a provider cannot host a fresh structured run.
 * @param provider - the registered provider.
 * @param needsAgentOptions - whether the run overrides child Agent options.
 * @returns the problem, or undefined when the provider fits.
 */
export function freshProviderProblem(provider: SubagentProvider, needsAgentOptions: boolean): string | undefined {
  if (provider.inheritsParentContext) {
    return `provider "${provider.name}" starts children with the parent conversation`
  }
  const needed: (keyof SubagentCapabilities)[] = ['outputSchema', 'toolFilter', 'persona']
  if (needsAgentOptions) needed.push('agentOptions')
  const missing = needed.filter(capability => !provider.capabilities[capability])
  return missing.length === 0 ? undefined : `provider "${provider.name}" lacks ${missing.join(', ')}`
}

/** Inputs of one fresh run. */
export interface FreshRunRequest {
  /** Registered `ctx.subagents` provider name. */
  readonly provider: string
  /** Durable child label, recorded in the child's `subagent/descriptor`. */
  readonly label: string
  /** The delegating Agent. */
  readonly parent: Agent
  /** The child's only user message. */
  readonly prompt: ContentBlock[]
  /** Persona that shadows the deployment persona in the child. */
  readonly persona: string
  /** Global-tool mask for the child. */
  readonly toolFilter: ToolRestriction
  /** Object-rooted schema of the child's structured result. */
  readonly outputSchema: ObjectJsonSchema
  /** Optional child Agent option overrides. */
  readonly agentOptions?: AgentOptions
  /** Wall-clock limit in milliseconds; expiry cancels the child. */
  readonly timeoutMs: number
  /** Caller cancellation, combined with the time limit. */
  readonly signal: AbortSignal
}

/** How one fresh run ended: settled with a stop reason, or failed before a result existed. */
export type FreshRunOutcome =
  | {
    readonly kind: 'settled'
    readonly childId: SessionId
    readonly stopReason: SubagentStopReason
    /** The structured result; undefined when the child produced none. */
    readonly structured: unknown
  }
  | {
    readonly kind: 'failed'
    readonly stage: 'start' | 'result'
    readonly message: string
    /** The published child, when the failure came after publication. */
    readonly childId?: SessionId
  }

/**
 * Start, await, and dispose one fresh child run.
 * @param subagents - the subagent service.
 * @param request - provider, prompt, composition, schema, and bounds.
 * @returns the settled result, or the failing stage and message.
 * @throws when disposing the published run fails.
 */
export async function runFresh(subagents: FreshRunStarter, request: FreshRunRequest): Promise<FreshRunOutcome> {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
  let run: SubagentRun
  try {
    run = await subagents.start(request.provider, {
      label: request.label,
      prompt: request.prompt,
      parent: request.parent,
      signal,
      persona: request.persona,
      toolFilter: request.toolFilter,
      outputSchema: request.outputSchema,
      ...request.agentOptions === undefined ? {} : { agentOptions: request.agentOptions },
    })
  } catch (error: unknown) {
    return { kind: 'failed', stage: 'start', message: String(error) }
  }
  try {
    const result = await run.result
    return { kind: 'settled', childId: run.id, stopReason: result.stopReason, structured: result.structured }
  } catch (error: unknown) {
    return { kind: 'failed', stage: 'result', message: String(error), childId: run.id }
  } finally {
    await run.dispose()
  }
}
