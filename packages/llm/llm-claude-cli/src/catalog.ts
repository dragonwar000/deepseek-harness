/**
 * Resolves the CLI installation and the model catalog, and is the package's fail-loud boundary.
 *
 * Order matters and is fixed: the login state is asked first, because `list_models` answers
 * successfully even against an unauthenticated configuration directory and would otherwise present
 * a list-priced catalog as if it were the subscription's.
 *
 * Nothing here ever returns an empty catalog. `LlmRuntime.listModels` failures become a
 * `ModelCatalogFailure` that the picker shows with its message, while an empty list would make the
 * provider group vanish without a word.
 */

import { mkdir } from 'node:fs/promises'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import {
  assertAllowedExtraArgs,
  launchFingerprint,
  resolveAuthSpec,
  resolveCatalogSpec,
  resolveVersionSpec,
} from './launch.ts'
import { collectCliRun, firstCliAnswer } from './run.ts'
import type { CliRunDeps, ResolveExecutable, SpawnChild } from './run.ts'
import { decodeAuthStatus, decodeModelRows } from './wire.ts'
import type { ClaudeCliLaunch, ClaudeCliModelRow } from './types.ts'

/** The CLI executable is not installed or not executable. */
export const CLI_MISSING = 'CLI_MISSING'
/** The CLI is installed but reports no signed-in account for the configuration directory. */
export const CLI_NOT_AUTHENTICATED = 'CLI_NOT_AUTHENTICATED'
/** The CLI is installed and signed in but did not answer with a catalog. */
export const CLI_CATALOG_UNAVAILABLE = 'CLI_CATALOG_UNAVAILABLE'

/**
 * The failure for a configuration directory with no signed-in account.
 *
 * `claude auth status --json` and an inference run whose login lapsed after the catalog was cached
 * both report this state, and both name the same place to sign in.
 * @param accountHome - the registered account's configuration directory, or `undefined` when no
 *   Claude account is registered.
 * @returns the `CLI_NOT_AUTHENTICATED` failure naming where to sign in.
 */
export function notAuthenticatedFailure(accountHome: string | undefined): LlmFailure {
  return {
    message: accountHome === undefined
      ? 'No Claude account is registered. Open Settings, AI Account, and sign in to Claude; the Claude Code CLI performs the sign-in and keeps the credential.'
      : 'The registered Claude account is signed out. Open Settings, AI Account, and sign in to Claude again; the Claude Code CLI performs the sign-in and keeps the credential.',
    code: CLI_NOT_AUTHENTICATED,
  }
}

/** Everything the probe needs; every timeout and path is a validated `Config` field upstream. */
export interface ClaudeCliCatalogDeps {
  readonly spawn: SpawnChild
  readonly resolveExecutable: ResolveExecutable
  readonly cliPath: string
  readonly extraArgs: readonly string[]
  readonly workingDirectory: string
  readonly authTimeoutMs: number
  readonly catalogTimeoutMs: number
  readonly graceMs: number
  /** Resolves the account's configuration directory, or `undefined` when no account has a default. */
  readonly accountHome: (signal?: AbortSignal) => string | undefined | Promise<string | undefined>
}

/** One cached catalog, valid only while the CLI installation fingerprint is unchanged. */
interface CachedCatalog {
  readonly fingerprint: string
  readonly rows: readonly ClaudeCliModelRow[]
}

/** Combine the caller's cancellation with this probe's own deadline. */
function deadline(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/**
 * Probes one Claude Code CLI installation for its login state and its model catalog, caching the
 * catalog per account directory and per installation fingerprint.
 */
export class ClaudeCliCatalog {
  private readonly deps: ClaudeCliCatalogDeps
  private readonly runDeps: CliRunDeps
  /** Keyed by account directory, so one account's rows can never be served for another. */
  private readonly cache = new Map<string, CachedCatalog>()
  private executablePath: string | undefined
  private version: string | undefined
  private workingDirectoryReady: Promise<void> | undefined
  private accountSignedOut = false

  /**
   * @param deps - CLI path, extra args, working directory, deadlines, and the account resolver.
   * @throws Error at construction when a configured extra argument is forbidden, so a bad
   *   composition fails at load rather than on a user's first message.
   */
  constructor(deps: ClaudeCliCatalogDeps) {
    assertAllowedExtraArgs(deps.extraArgs)
    this.deps = deps
    this.runDeps = { spawn: deps.spawn, cwd: deps.workingDirectory, graceMs: deps.graceMs }
  }

  /**
   * Resolve the CLI installation and the current account into one launch.
   * @param signal - the caller's cancellation.
   * @returns the executable, the configured extra args, and the account directory.
   * @throws LlmError `CLI_MISSING` when the executable cannot be resolved.
   */
  async launch(signal?: AbortSignal): Promise<ClaudeCliLaunch> {
    // Every caller resolves a launch before it spawns, so this is the one place that has to make
    // sure the working directory exists; a child spawned into a missing cwd fails with ENOENT.
    await this.ensureWorkingDirectory()
    return {
      executable: await this.executable(signal),
      extraArgs: this.deps.extraArgs,
      accountHome: await this.deps.accountHome(signal),
    }
  }

  /**
   * List the models the signed-in account can use, from the CLI's own answer.
   * @param signal - the caller's cancellation.
   * @returns the CLI's rows, in the CLI's order, never empty.
   * @throws LlmError `CLI_MISSING`, `CLI_NOT_AUTHENTICATED`, or `CLI_CATALOG_UNAVAILABLE`, each
   *   naming what to do about it.
   */
  async rows(signal?: AbortSignal): Promise<readonly ClaudeCliModelRow[]> {
    const launch = await this.launch(signal)
    if (this.accountSignedOut) {
      const failure = notAuthenticatedFailure(launch.accountHome)
      throw new LlmError(failure.message, failure.code)
    }
    const key = launch.accountHome ?? '<no account>'
    const cached = this.cache.get(key)
    const fingerprint = launchFingerprint(launch, await this.cliVersion(launch, signal))
    if (cached !== undefined && cached.fingerprint === fingerprint) return cached.rows
    // The login state is asked only when the catalog must actually be probed. Re-asking it on every
    // model request would spawn one extra child per turn, and it would tell us nothing new: the
    // default account changing invalidates this cache, and a login that lapses between listings is
    // reported by the run itself in the CLI's own result message.
    await this.assertAuthenticated(launch, signal)
    const rows = await this.probeRows(launch, signal)
    this.cache.set(key, { fingerprint, rows })
    return rows
  }

  /**
   * Record the default Claude account's latest sign-in status check. While it reports the account
   * signed out, {@link rows} fails with `CLI_NOT_AUTHENTICATED` without spawning the CLI; either
   * answer drops the cached catalog, so the first listing after sign-in re-asks the CLI.
   * @param signedOut - whether the latest check answered `signedOut`.
   */
  setAccountSignedOut(signedOut: boolean): void {
    this.accountSignedOut = signedOut
    this.invalidate()
  }

  /** Drop every cached catalog, so the next listing re-asks the CLI. */
  invalidate(): void {
    this.cache.clear()
    this.executablePath = undefined
    this.version = undefined
  }

  /** Resolve the executable once per plugin generation. */
  private async executable(signal: AbortSignal | undefined): Promise<string> {
    const known = this.executablePath
    if (known !== undefined) return known
    try {
      const resolved = await this.deps.resolveExecutable(this.deps.cliPath, undefined, signal)
      this.executablePath = resolved
      return resolved
    }
    catch (error) {
      if (error instanceof SubprocessExecutableNotFoundError) {
        throw new LlmError(
          `The Claude Code CLI (${this.deps.cliPath}) is not installed or not on PATH. Install Claude Code, or set this route's cliPath to its absolute path.`,
          CLI_MISSING,
        )
      }
      throw error
    }
  }

  /** Ask the CLI whether the configuration directory it was given is signed in. */
  private async assertAuthenticated(launch: ClaudeCliLaunch, signal: AbortSignal | undefined): Promise<void> {
    const { stdout, stderr } = await collectCliRun(
      this.runDeps,
      resolveAuthSpec(launch),
      deadline(this.deps.authTimeoutMs, signal),
    )
    const status = decodeAuthStatus(stdout)
    if (status === undefined) {
      throw new LlmError(
        `The Claude Code CLI did not answer \`auth status --json\` with a readable login state.${tail(stderr)}`,
        CLI_NOT_AUTHENTICATED,
      )
    }
    if (!status.loggedIn) {
      const failure = notAuthenticatedFailure(launch.accountHome)
      throw new LlmError(failure.message, failure.code)
    }
  }

  /** Read the CLI's version, one probe per plugin generation, for the cache fingerprint. */
  private async cliVersion(launch: ClaudeCliLaunch, signal: AbortSignal | undefined): Promise<string> {
    const known = this.version
    if (known !== undefined) return known
    const { stdout } = await collectCliRun(
      this.runDeps,
      resolveVersionSpec(launch),
      deadline(this.deps.authTimeoutMs, signal),
    )
    const reported = stdout.trim()
    // An unreadable version is not worth failing a listing over; it only keys the cache, and an
    // empty key simply means the next generation re-probes.
    this.version = reported
    return reported
  }

  /** Spawn the one-shot catalog probe and stop the child as soon as it answers. */
  private async probeRows(
    launch: ClaudeCliLaunch,
    signal: AbortSignal | undefined,
  ): Promise<readonly ClaudeCliModelRow[]> {
    const { value, stderr } = await firstCliAnswer(
      this.runDeps,
      resolveCatalogSpec(launch),
      deadline(this.deps.catalogTimeoutMs, signal),
      decodeModelRows,
    )
    if (value?.kind === 'refused') {
      throw new LlmError(
        `The Claude Code CLI could not list models: ${value.reason}${tail(stderr)}`,
        CLI_CATALOG_UNAVAILABLE,
      )
    }
    if (value === undefined || value.rows.length === 0) {
      throw new LlmError(
        `The Claude Code CLI listed no models. Check that \`${this.deps.cliPath}\` runs and that its version answers the list_models control request.${tail(stderr)}`,
        CLI_CATALOG_UNAVAILABLE,
      )
    }
    return value.rows
  }

  /** Create the fixed working directory once, so every run reports the same empty directory. */
  private ensureWorkingDirectory(): Promise<void> {
    this.workingDirectoryReady ??= mkdir(this.deps.workingDirectory, { recursive: true, mode: 0o700 })
      .then(() => undefined)
    return this.workingDirectoryReady
  }
}

/** Append a CLI stderr tail to a message, when there is one. */
function tail(stderr: string): string {
  const trimmed = stderr.trim()
  return trimmed.length === 0 ? '' : ` The CLI reported: ${trimmed}`
}
