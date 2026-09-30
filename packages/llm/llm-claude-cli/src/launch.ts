/**
 * Plans every Claude Code CLI invocation this package makes.
 *
 * Pure by design: no I/O and no environment reads, so the exact argv and the exact environment of
 * every run are reviewable and testable in one place. That matters because the argv is what keeps
 * the CLI a completion engine (`--tools ""`) and the environment is the only credential action this
 * package takes (`CLAUDE_CONFIG_DIR`).
 */

import { createHash } from 'node:crypto'
import type { ClaudeCliLaunch, ClaudeCliModelId, ClaudeCliRequestSpec } from './types.ts'

/** Request id of the one-shot catalog probe; the decoder matches the answer against it. */
export const CATALOG_REQUEST_ID = 'dsh-claude-cli-models'

/**
 * Flags this package must never send, each a recorded refusal.
 *
 * `--bare` makes the CLI read only `ANTHROPIC_API_KEY` or an `apiKeyHelper` and never the
 * subscription login, so it would defeat the point of this route. `--betas` is documented as
 * API-key-only. `--append-system-prompt` would leave the CLI's own system prompt in place instead
 * of replacing it, putting text the Harness did not write in front of the model. The two
 * permission-skipping flags would let a tool run at all.
 */
export const FORBIDDEN_ARGS: readonly string[] = [
  '--bare',
  '--betas',
  '--append-system-prompt',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
]

/**
 * Arguments shared by every invocation that talks the streaming protocol.
 *
 * `--tools ""` is the CLI's documented switch for disabling all built-in tools. MCP tools survive
 * it, so `--disallowedTools mcp__*` and `--strict-mcp-config` deny those separately, and
 * `--setting-sources ""` keeps the host's own settings files out of the run entirely.
 */
const ISOLATION_ARGS: readonly string[] = [
  '--tools', '',
  '--disallowedTools', 'mcp__*',
  '--strict-mcp-config',
  '--setting-sources', '',
  '--disable-slash-commands',
  '--permission-prompts', 'none',
  '--no-session-persistence',
]

/** Arguments that select the machine-readable bidirectional protocol. */
const STREAM_ARGS: readonly string[] = [
  '--print',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--verbose',
  '--include-partial-messages',
]

/**
 * Refuse a configured extra argument that would change how the CLI authenticates or re-enable tools.
 * @param extraArgs - the deployment's configured extra arguments.
 * @throws Error naming the flag and why a run cannot carry it.
 */
export function assertAllowedExtraArgs(extraArgs: readonly string[]): void {
  for (const arg of extraArgs) {
    if (FORBIDDEN_ARGS.includes(arg)) {
      throw new Error(
        `llm-claude-cli: extraArgs may not contain ${arg}; it would change how the CLI authenticates or re-enable tool use`,
      )
    }
  }
}

/** Environment overlay for one run: the account directory, or nothing when no account is registered. */
function environment(launch: ClaudeCliLaunch): Readonly<Record<string, string>> {
  return launch.accountHome === undefined ? {} : { CLAUDE_CONFIG_DIR: launch.accountHome }
}

/**
 * Plan one inference run.
 * @param launch - the resolved CLI installation and account.
 * @param request - model to pin, the system prompt that replaces the CLI's own, and the session id.
 * @returns argv, the environment overlay, and `null` stdin because the caller streams the messages.
 */
export function resolveInferenceSpec(
  launch: ClaudeCliLaunch,
  request: { model: ClaudeCliModelId; system: string | undefined; sessionId: string },
): ClaudeCliRequestSpec {
  return {
    argv: [
      launch.executable,
      ...STREAM_ARGS,
      ...ISOLATION_ARGS,
      '--model', request.model,
      '--session-id', request.sessionId,
      ...(request.system === undefined ? [] : ['--system-prompt', request.system]),
      ...launch.extraArgs,
    ],
    env: environment(launch),
    stdinPayload: null,
  }
}

/**
 * Plan the one-shot model-catalog probe: the catalog comes from the CLI's own answer, never from a
 * vendor model API.
 * @param launch - the resolved CLI installation and account.
 * @returns argv plus the single `list_models` control request written to stdin.
 */
export function resolveCatalogSpec(launch: ClaudeCliLaunch): ClaudeCliRequestSpec {
  return {
    argv: [launch.executable, ...STREAM_ARGS, ...ISOLATION_ARGS, ...launch.extraArgs],
    env: environment(launch),
    stdinPayload: `${JSON.stringify({
      type: 'control_request',
      request_id: CATALOG_REQUEST_ID,
      request: { subtype: 'list_models' },
    })}\n`,
  }
}

/**
 * Plan the login-state probe. This is the only authentication question this package asks, and it
 * asks the CLI rather than reading anything the CLI stores. A catalog probe cannot stand in for it:
 * `list_models` answers successfully even against an unauthenticated configuration directory.
 * @param launch - the resolved CLI installation and account.
 * @returns argv for `claude auth status --json`, with stdin closed.
 */
export function resolveAuthSpec(launch: ClaudeCliLaunch): ClaudeCliRequestSpec {
  return { argv: [launch.executable, 'auth', 'status', '--json'], env: environment(launch), stdinPayload: null }
}

/**
 * Plan the version probe used as half of the catalog cache key.
 * @param launch - the resolved CLI installation.
 * @returns argv for `claude --version`, with stdin closed and no account overlay needed.
 */
export function resolveVersionSpec(launch: ClaudeCliLaunch): ClaudeCliRequestSpec {
  return { argv: [launch.executable, '--version'], env: {}, stdinPayload: null }
}

/**
 * Identify one CLI installation for catalog caching. The account directory is deliberately absent:
 * it is the cache's other key, so one account's catalog can never be served for another.
 * @param launch - the resolved CLI installation.
 * @param version - the version string the CLI reported.
 * @returns a hex sha256 over executable, extra args, and version.
 */
export function launchFingerprint(launch: ClaudeCliLaunch, version: string): string {
  return createHash('sha256')
    .update(JSON.stringify([launch.executable, launch.extraArgs, version]))
    .digest('hex')
}
