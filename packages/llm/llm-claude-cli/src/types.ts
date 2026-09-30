/**
 * Vocabulary shared by the launch planner, the wire decoder, the catalog probe, and the adapter.
 *
 * The one fact that shapes every type here: the Claude Code CLI owns authentication. This package
 * points the CLI at an account's configuration directory through the CLI's own documented
 * `CLAUDE_CONFIG_DIR` variable and never opens a file inside it.
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import { brandString } from '@deepseek-ai/dsh-brand'

/**
 * A model id as the Claude Code CLI reports it in `list_models` and accepts it on `--model`.
 * Opaque: the CLI owns the vocabulary and the value crosses the process boundary verbatim.
 */
export type ClaudeCliModelId = Branded<'ClaudeCliModelId'>

/**
 * Brand a CLI-reported model id.
 * @param value - the `value` field of one `list_models` row, or a model id from a request.
 * @returns the same string, branded.
 */
export function claudeCliModelId(value: string): ClaudeCliModelId {
  return brandString<ClaudeCliModelId>(value)
}

/** Everything about one CLI installation and one account that a single run needs. */
export interface ClaudeCliLaunch {
  /** Absolute executable, already resolved through `ctx.subprocess.resolveExecutable`. */
  readonly executable: string
  /** Deployment-configured arguments appended after the fixed ones. */
  readonly extraArgs: readonly string[]
  /**
   * The registered account's configuration directory, or `undefined` when no account of kind
   * `claude` has a default. Used only as the value of `CLAUDE_CONFIG_DIR` and as a catalog cache
   * key; this package never reads a file inside it.
   */
  readonly accountHome: string | undefined
}

/** One planned CLI invocation: argv, the environment overlay, and the single stdin line if any. */
export interface ClaudeCliRequestSpec {
  /** Full argv; `argv[0]` is the executable. Never shell-interpreted. */
  readonly argv: readonly string[]
  /**
   * Overlay merged on top of `scrubbedParentEnv()` by the subprocess seam, which already drops
   * `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` through
   * `SENSITIVE_ENV_PATTERN`. This overlay adds `CLAUDE_CONFIG_DIR` and nothing else.
   */
  readonly env: Readonly<Record<string, string>>
  /** The one line written to stdin before it is closed, or `null` to leave stdin closed. */
  readonly stdinPayload: string | null
}

/** One reasoning effort the CLI reported for a model. */
export interface ClaudeCliEffort {
  readonly id: string
  readonly name: string
}

/** One model row as decoded from the CLI's own `list_models` answer. */
export interface ClaudeCliModelRow {
  /** The id `--model` takes (`value` in the CLI's answer). */
  readonly id: ClaudeCliModelId
  /** The concrete model the CLI says this id resolves to; kept for the catalog description. */
  readonly resolvedModel: string
  readonly displayName: string
  readonly description?: string
  /** Effort levels the CLI reported, empty when it reported none. */
  readonly efforts: readonly ClaudeCliEffort[]
  readonly isDefault: boolean
}

/** What the CLI answers when asked about its own login state. */
export interface ClaudeCliAuthStatus {
  readonly loggedIn: boolean
  readonly authMethod: string | undefined
  readonly subscriptionType: string | undefined
}

/** Why one correction run was needed, and the text it added to the request. */
export interface CliToolEmulationCorrection {
  /** The `TOOL_CALL_*` code that rejected the previous reply. */
  readonly code: string
  /** Verbatim notice appended to the request, which the model reads. */
  readonly text: string
}

/**
 * One CLI run whose tool declarations reached the model as prompt text rather than as an API
 * `tools` field.
 *
 * Recorded before the run, so the preamble and any correction notice are in the log before the
 * model reads them. The preamble itself is not stored: it is a pure function of {@link template}
 * and the request header's tool schemas, both of which the log already holds.
 */
export interface CliToolEmulation {
  /** Provider route that served the request. */
  readonly provider: string
  /** Model id pinned on the CLI run. */
  readonly model: string
  /** Identity of the pinned preamble wording the model read. */
  readonly template: string
  /** Characters the preamble added after the request's system prompt. */
  readonly preambleChars: number
  /** Declared tool names the preamble carried, in preamble order. */
  readonly tools: readonly string[]
  /** 1 for a request's first run; 2 and up for a correction run. */
  readonly attempt: number
  /** Why the previous run was rejected and what this one tells the model; absent on the first run. */
  readonly correction?: CliToolEmulationCorrection
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One Claude Code CLI run whose tool declarations travelled in the prompt. Log-only; never
     * derived history.
     */
    'llm/cli-tool-emulation': CliToolEmulation
  }
}
