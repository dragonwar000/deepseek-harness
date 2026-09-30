/**
 * Claude model route whose transport is the Claude Code CLI as a child process.
 *
 * The route is dormant until an AI Account of kind `claude` has a default, and it is withdrawn when
 * that default goes away, following the sign-in-activates-a-route pattern. A composition that
 * declares the same provider itself always wins: activation only ever adds a route the composition
 * is silent about.
 */

import type {} from '@deepseek-ai/cordis-plugin-loader'
import { FiberState } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-ai-account'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ClaudeCliAdapter, EMULATION_NOT_LOGGABLE } from './adapter.ts'
import type { EmulationRecorder } from './adapter.ts'
import { ClaudeCliCatalog } from './catalog.ts'
import type { CliToolEmulation } from './types.ts'

export {
  ClaudeCliAdapter,
  EMULATION_NOT_LOGGABLE,
  TOOL_CALLS_UNSUPPORTED,
  UNKNOWN_MODEL,
} from './adapter.ts'
export { CLI_CATALOG_UNAVAILABLE, CLI_MISSING, CLI_NOT_AUTHENTICATED, ClaudeCliCatalog } from './catalog.ts'
export {
  buildToolPreamble,
  PREAMBLE_TEMPLATE,
  TOOL_CALL_FENCE,
  TOOL_CALL_LIMIT,
  TOOL_CALL_MALFORMED,
  TOOL_CALL_TOO_LARGE,
  TOOL_CALL_TRUNCATED,
  TOOL_CALL_UNFENCED,
  TOOL_CALL_UNKNOWN_TOOL,
} from './emulate.ts'
export type {
  ClaudeCliLaunch,
  ClaudeCliModelId,
  ClaudeCliModelRow,
  CliToolEmulation,
  CliToolEmulationCorrection,
} from './types.ts'

/** Plugin name, and the settings namespace fallback when the row declares no id. */
export const name = 'llm-claude-cli'

/**
 * `aiAccount` is deliberately absent: the route mounts dormant without it and activates through
 * `ctx.inject`, so a composition that has not mounted the AI Account provider still loads.
 */
export const inject = ['llm', 'subprocess']

/** Deployment choices for the route. */
export interface Config {
  /** Provider route registered on `ctx.llm`. */
  providerName?: string
  /** Route name shown wherever the picker does not localize it. */
  displayName?: string
  /** Executable name on `PATH`, or an absolute path. */
  cliPath?: string
  /** Arguments appended after the fixed ones; a flag that would break subscription auth is refused. */
  extraArgs?: string[]
  /** Working directory for every CLI child; a fixed empty directory keeps the run reproducible. */
  workingDirectory?: string
  /** Register the route when an AI Account of kind `claude` has a default. */
  autoActivate?: boolean
  /** Deadline for `claude auth status --json` and `claude --version`. */
  authTimeoutMs?: number
  /** Deadline for the one-shot `list_models` probe. */
  catalogTimeoutMs?: number
  /** Deadline for one inference run. */
  requestTimeoutMs?: number
  /** Concurrent CLI children this route may hold. */
  maxConcurrent?: number
  /** Grace before a terminated child is killed. */
  graceMs?: number
  /**
   * How a request that declares tools is served. `prompt` declares the tools as system-prompt text
   * and reads the model's fenced call back as a real tool call; `refuse` fails the request with
   * `TOOL_CALLS_UNSUPPORTED`, which is what the route did before emulation existed.
   */
  toolCalls?: 'refuse' | 'prompt'
  /** Tool-call blocks accepted from one emulated reply; the preamble states this number. */
  toolCallMaxCalls?: number
  /** Bytes accepted inside one tool-call block; the preamble states this number. */
  toolCallMaxBytes?: number
  /** Correction runs allowed after a rejected reply that produced no output yet. */
  toolCallRetries?: number
}

/** Config with every default applied. */
type ValidConfig = Required<Config>

export const Config: z<Config, ValidConfig> = z.object({
  providerName: z.string().min(1).default('claude-cli'),
  displayName: z.string().min(1).default('Claude (Claude Code CLI)'),
  cliPath: z.string().min(1).default('claude'),
  extraArgs: z.array(z.string()).default([]),
  workingDirectory: z.string().default(''),
  autoActivate: z.boolean().default(true),
  authTimeoutMs: z.natural().min(1).default(15_000),
  catalogTimeoutMs: z.natural().min(1).default(30_000),
  requestTimeoutMs: z.natural().min(1).default(600_000),
  maxConcurrent: z.natural().min(1).default(2),
  graceMs: z.natural().min(1).default(2_000),
  toolCalls: z.union(['refuse', 'prompt'] as const).default('prompt'),
  toolCallMaxCalls: z.natural().min(1).default(4),
  toolCallMaxBytes: z.natural().min(1).default(32_768),
  toolCallRetries: z.natural().default(1),
})

/**
 * Provider routes the composition declared for itself, which activation must never replace.
 * @param ctx - the plugin context.
 * @returns every provider id already registered on `ctx.llm`.
 */
function declaredRoutes(ctx: Context): ReadonlySet<string> {
  return new Set(ctx.llm.listProviders().map(provider => provider.id))
}

/**
 * Build the session recorder for emulated runs.
 *
 * The session store is resolved per record rather than injected: the route mounts and serves
 * tool-free requests in a composition with no session store at all, and only an emulated request
 * needs a log. A request that names a session the store cannot reach fails loud, because the
 * emulation preamble is model-visible input and the Harness requires it to be in the log.
 * @param ctx - the plugin context.
 * @returns a recorder that appends one `llm/cli-tool-emulation` event.
 */
function recorder(ctx: Context): EmulationRecorder {
  return (sessionId: SessionId, record: CliToolEmulation): void => {
    const session = ctx.get('sessions')?.get(sessionId)
    if (session === undefined) {
      throw new LlmError(
        `The claude-cli route declares this request's tools in the prompt, which is model-visible input that must be logged, but session ${sessionId} could not be reached to log it. Mount @deepseek-ai/dsh-session, or set this route's toolCalls to "refuse".`,
        EMULATION_NOT_LOGGABLE,
      )
    }
    session.append('llm/cli-tool-emulation', record)
  }
}

/**
 * Mount the route.
 * @param ctx - the plugin context, with `llm` and `subprocess` injected.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: ValidConfig): void {
  const workingDirectory = config.workingDirectory.length === 0
    ? dshHomePath('claude-cli')
    : config.workingDirectory
  // Resolved eagerly so an account that appears later cannot see a different account's directory.
  const accountHome = (): string | undefined => ctx.get('aiAccount')?.defaultHome('claude')
  const spawn = (spec: Parameters<Context['subprocess']['spawn']>[0]) => ctx.subprocess.spawn(spec)
  // Constructing the catalog validates `extraArgs`, so a forbidden flag fails at load.
  const catalog = new ClaudeCliCatalog({
    spawn,
    resolveExecutable: (command, env, signal) => ctx.subprocess.resolveExecutable(command, env, signal),
    cliPath: config.cliPath,
    extraArgs: config.extraArgs,
    workingDirectory,
    authTimeoutMs: config.authTimeoutMs,
    catalogTimeoutMs: config.catalogTimeoutMs,
    graceMs: config.graceMs,
    accountHome,
  })
  const adapter = new ClaudeCliAdapter({
    catalog,
    displayName: config.displayName,
    workingDirectory,
    requestTimeoutMs: config.requestTimeoutMs,
    maxConcurrent: config.maxConcurrent,
    graceMs: config.graceMs,
    spawn,
    toolCalls: config.toolCalls,
    toolCallMaxCalls: config.toolCallMaxCalls,
    toolCallMaxBytes: config.toolCallMaxBytes,
    toolCallRetries: config.toolCallRetries,
    recordEmulation: recorder(ctx),
  })

  let registration: AdapterRegistrationHandle | undefined
  let owned: readonly string[] = []

  /**
   * The routes activation should own right now.
   *
   * The declared-wins rule compares against routes owned by someone else: this route's own
   * registration is on `ctx.llm` too, and counting it would make the second pass mistake activation
   * for a declaration and withdraw the route it had just added.
   */
  const wanted = (): readonly string[] => {
    if (!config.autoActivate || accountHome() === undefined) return []
    const declaredElsewhere = declaredRoutes(ctx).has(config.providerName)
      && !owned.includes(config.providerName)
    return declaredElsewhere ? [] : [config.providerName]
  }

  /** Bring the registration in line with `wanted()`, replacing routes atomically. */
  const ensureRegistration = (): void => {
    const next = wanted()
    if (next.length === owned.length && next.every((route, index) => route === owned[index])) return
    owned = next
    if (registration === undefined) {
      // `next` differs from an empty `owned`, so it names the route; the first pass never registers
      // an empty set.
      registration = ctx.llm.registerAdapter([...next], adapter)
      ctx.effect(() => () => {
        registration?.()
        registration = undefined
      }, 'llm-claude-cli: adapter registration')
      return
    }
    // `replace` rather than dispose-then-register: a route must never be briefly absent while a
    // request is choosing one.
    registration.replace([...next])
  }

  /** Directory entry so Settings can address the route even while it is dormant. */
  ctx.effect(
    () => ctx.llm.registerConfigurableProviders([{
      provider: config.providerName,
      displayName: config.displayName,
      settingsNs: ctx.fiber.entry?.options.id ?? name,
      settingsPath: [],
      declared: true,
    }]),
    'llm-claude-cli: settings directory entry',
  )

  /**
   * Bring the route in line with the account state.
   *
   * No coalescing window exists to close here, unlike the pi-ai sign-in route: `defaultHome` is
   * synchronous, so a pass reads the account state and rewrites the registration in one step with no
   * await between them. A failure is logged and leaves the live route alone rather than dropping the
   * user's model mid-session.
   */
  const refresh = (): void => {
    try {
      ensureRegistration()
    }
    catch (error) {
      ctx.logger.warn('llm-claude-cli: could not bring the Claude CLI model route in line with the signed-in account')
      ctx.logger.warn(error)
    }
  }

  ctx.inject(['aiAccount'], (accounts) => {
    accounts.on('ai-account/default-changed', (kind) => {
      if (kind === 'claude') {
        catalog.invalidate()
        refresh()
      }
    })
    accounts.effect(() => () => {
      // The AI Account provider went away: the route has no account to run under.
      if (ctx.fiber.state !== FiberState.ACTIVE || owned.length === 0) return
      owned = []
      registration?.replace([])
    })
    refresh()
  })

  ctx.on('loader/volatile-update', () => {
    catalog.invalidate()
    refresh()
  })
}

/** The plugin object the Loader mounts for the `llm-claude-cli` row. */
export default { name, inject, Config, apply }
