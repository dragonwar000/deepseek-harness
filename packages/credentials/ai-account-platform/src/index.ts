/**
 * AI Account provider that signs in, identifies, and signs out Claude and ChatGPT subscription
 * accounts only by running the official Claude Code and Codex CLIs against one configuration
 * directory per account. It never reads, copies, or refreshes the credentials those CLIs store.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  AiAccount, type AiAccountId, type AiAccountKind, type AiAccountSignInId, type AiAccountSignInView, type AiAccountView,
  type AiAccountsView,
} from '@deepseek-ai/dsh-ai-account'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import { CLI, LoginOutput, type CliIdentity } from './cli.ts'
import { EMPTY_ACCOUNT_FILE, readAccountFile, writeAccountFile, type AccountFile, type AccountRecord } from './store.ts'

/** Deployment choices for the account root, CLI executables, and command deadlines. */
export interface Config {
  /** Directory holding `accounts.json` and the per-account CLI configuration directories; defaults to `<Harness home>/ai-accounts`. */
  root?: string
  /** Claude Code executable: an absolute path or a bare name resolved from `PATH`. */
  claudeCliPath?: string
  /** Codex executable: an absolute path or a bare name resolved from `PATH`. */
  codexCliPath?: string
  /** Deadline for one complete login, including the time the user spends authorizing, in milliseconds. */
  loginTimeoutMs?: number
  /** Deadline for one status or logout command, in milliseconds. */
  commandTimeoutMs?: number
  /** Grace between termination tiers when a CLI command is cancelled, in milliseconds. */
  graceMs?: number
}

/** Validated configuration: every field except `root` carries its default. */
type ValidConfig = Required<Omit<Config, 'root'>> & Pick<Config, 'root'>

/** Validated deployment choices. */
export const Config: Schema<Config, ValidConfig> = Schema.object({
  root: Schema.string().min(1),
  claudeCliPath: Schema.string().min(1).default('claude'),
  codexCliPath: Schema.string().min(1).default('codex'),
  loginTimeoutMs: Schema.number().min(1_000).max(1_800_000).default(900_000),
  commandTimeoutMs: Schema.number().min(1_000).max(120_000).default(15_000),
  graceMs: Schema.number().min(100).max(30_000).default(2_000),
})

/** Configuration with every default applied. */
export interface ResolvedConfig {
  readonly root: string
  readonly executables: Readonly<Record<AiAccountKind, string>>
  readonly loginTimeoutMs: number
  readonly commandTimeoutMs: number
  readonly graceMs: number
}

/**
 * Apply defaults to validated configuration.
 * @param config - schema-validated configuration.
 * @returns the configuration every operation reads.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const valid = Config(config)
  return {
    root: valid.root ?? dshHomePath('ai-accounts'),
    executables: { claude: valid.claudeCliPath, chatgpt: valid.codexCliPath },
    loginTimeoutMs: valid.loginTimeoutMs,
    commandTimeoutMs: valid.commandTimeoutMs,
    graceMs: valid.graceMs,
  }
}

/** Bytes kept from a status or logout command's output. */
const OUTPUT_LIMIT_BYTES = 16 * 1024
const KIND_ORDER: readonly AiAccountKind[] = ['claude', 'chatgpt']
const ACTIVE_PHASES = new Set<AiAccountSignInView['phase']>(['starting', 'waiting-browser', 'waiting-device-code', 'verifying'])

interface Attempt {
  view: AiAccountSignInView
  readonly accountId: AiAccountId
  readonly home: string
  readonly controller: AbortController
  done: Promise<void>
}

type Outcome = Pick<AiAccountSignInView, 'phase' | 'errorCode'>

/**
 * Describe a caught failure for the Host log.
 * @param error - caught value.
 * @returns its message, or its string form for a non-Error value.
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Official-CLI implementation of {@link AiAccount}. */
export class PlatformAiAccount extends AiAccount {
  static inject = ['subprocess']
  static Config = Config

  private readonly config: ResolvedConfig
  private file: AccountFile = EMPTY_ACCOUNT_FILE
  private attempt: Attempt | undefined
  private readonly listeners = new Set<() => void>()
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false

  /**
   * @param ctx - context providing the subprocess seam.
   * @param config - deployment choices.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    ctx.effect(() => async () => {
      this.closed = true
      this.attempt?.controller.abort()
      await this.attempt?.done
      await this.queue
      this.publish()
    }, 'ai-account: sign-in and mutation lifetime')
  }

  async [Service.init](): Promise<void> {
    this.file = await readAccountFile(this.filePath())
  }

  override getState(): Promise<AiAccountsView> {
    return Promise.resolve(this.snapshot())
  }

  override startSignIn(kind: AiAccountKind): Promise<AiAccountsView> {
    if (this.closed) return Promise.reject(new Error('ai-account: provider closed'))
    if (this.attempt === undefined || !ACTIVE_PHASES.has(this.attempt.view.phase)) {
      const accountId = randomUUID() as AiAccountId
      const attempt: Attempt = {
        view: { id: randomUUID() as AiAccountSignInId, kind, phase: 'starting', url: null, userCode: null, errorCode: null },
        accountId,
        home: this.homeOf(kind, accountId),
        controller: new AbortController(),
        done: Promise.resolve(),
      }
      this.attempt = attempt
      attempt.done = this.signIn(attempt)
      this.publish()
    }
    return this.getState()
  }

  override async cancelSignIn(id: AiAccountSignInId): Promise<AiAccountsView> {
    const attempt = this.attempt
    if (attempt?.view.id === id) {
      attempt.controller.abort()
      await attempt.done
    }
    return this.snapshot()
  }

  override setDefault(id: AiAccountId): Promise<AiAccountsView> {
    return this.exclusive(async () => {
      const account = this.account(id)
      if (this.file.defaults[account.kind] !== id) {
        await this.commit({ ...this.file, defaults: { ...this.file.defaults, [account.kind]: id } })
        this.ctx.emit('ai-account/default-changed', account.kind)
      }
      return this.snapshot()
    })
  }

  override remove(id: AiAccountId): Promise<AiAccountsView> {
    return this.exclusive(async () => {
      const account = this.account(id)
      const home = this.homeOf(account.kind, id)
      await this.signOutHome(account.kind, home)
      await rm(home, { recursive: true, force: true })
      const accounts = this.file.accounts.filter(candidate => candidate.id !== id)
      const wasDefault = this.file.defaults[account.kind] === id
      const successor = accounts.filter(candidate => candidate.kind === account.kind)
        .toSorted((left, right) => left.createdAt - right.createdAt)[0]
      const defaults = wasDefault ? { ...this.file.defaults, [account.kind]: successor?.id } : this.file.defaults
      await this.commit({ ...this.file, accounts, defaults })
      if (wasDefault) this.ctx.emit('ai-account/default-changed', account.kind)
      return this.snapshot()
    })
  }

  /* jscpd:ignore-start -- the coalescing snapshot stream follows the account providers' shared watch semantics
     (one snapshot per burst of changes, ended by close or abort) that each provider's listener set owns. */
  override async *watch(signal: AbortSignal): AsyncIterable<AiAccountsView> {
    let dirty = true
    let wake: (() => void) | undefined
    const changed = (): void => { dirty = true; wake?.() }
    this.listeners.add(changed)
    signal.addEventListener('abort', changed, { once: true })
    try {
      while (!this.closed && !signal.aborted) {
        if (dirty) {
          dirty = false
          yield this.snapshot()
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      this.listeners.delete(changed)
      signal.removeEventListener('abort', changed)
    }
  }
  /* jscpd:ignore-end */

  override defaultHome(kind: AiAccountKind): string | undefined {
    const id = this.file.defaults[kind]
    return id === undefined ? undefined : this.homeOf(kind, id)
  }

  private filePath(): string {
    return join(this.config.root, 'accounts.json')
  }

  private homeOf(kind: AiAccountKind, id: AiAccountId): string {
    return join(this.config.root, CLI[kind].directory, id)
  }

  private account(id: AiAccountId): AccountRecord {
    const account = this.file.accounts.find(candidate => candidate.id === id)
    if (account === undefined) throw new Error(`ai-account: no account ${id}`)
    return account
  }

  private snapshot(): AiAccountsView {
    const accounts: AiAccountView[] = this.file.accounts
      .toSorted((left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind) || left.createdAt - right.createdAt)
      .map(account => ({ ...account, isDefault: this.file.defaults[account.kind] === account.id }))
    return { accounts, signIn: this.attempt?.view ?? null }
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }

  private update(attempt: Attempt, value: Partial<AiAccountSignInView>): void {
    attempt.view = { ...attempt.view, ...value }
    this.publish()
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('ai-account: provider closed'))
    const result = this.queue.then(operation)
    this.queue = result.catch((_reported: unknown) => undefined)
    return result
  }

  private async commit(file: AccountFile): Promise<void> {
    await writeAccountFile(this.filePath(), file)
    this.file = file
    this.publish()
  }

  /** Run one attempt to its terminal phase; never rejects. */
  private async signIn(attempt: Attempt): Promise<void> {
    const outcome = await this.login(attempt)
    if (outcome.phase !== 'succeeded') await rm(attempt.home, { recursive: true, force: true })
    this.update(attempt, outcome)
  }

  private async login(attempt: Attempt): Promise<Outcome> {
    const { kind } = attempt.view
    const cli = CLI[kind]
    const deadline = AbortSignal.timeout(this.config.loginTimeoutMs)
    const signal = AbortSignal.any([attempt.controller.signal, deadline])
    const interrupted = (): Outcome | undefined => attempt.controller.signal.aborted
      ? { phase: 'cancelled', errorCode: null }
      : deadline.aborted ? { phase: 'failed', errorCode: 'timeout' } : undefined
    try {
      const executable = await this.executable(kind, signal)
      if (executable === undefined) return { phase: 'failed', errorCode: 'executable-missing' }
      await mkdir(attempt.home, { recursive: true, mode: 0o700 })
      const handle = this.ctx.subprocess.spawn({
        argv: [executable, ...cli.loginArgs],
        cwd: attempt.home,
        env: { [cli.homeEnv]: attempt.home },
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: this.config.graceMs,
        signal,
      })
      const output = new LoginOutput(cli.deviceCode)
      const scan = (chunk: Buffer): void => {
        const prompt = output.push(chunk.toString('utf8'))
        if (prompt !== undefined) this.update(attempt, prompt)
      }
      handle.stdout?.on('data', scan)
      handle.stderr?.on('data', scan)
      this.update(attempt, { phase: cli.waitingPhase })
      const { exitCode } = await handle.done
      const stopped = interrupted()
      if (stopped !== undefined) return stopped
      if (exitCode !== 0) return { phase: 'failed', errorCode: 'login-failed' }
      this.update(attempt, { phase: 'verifying' })
      const identity = await this.identify(kind, attempt.home, executable)
      if (identity === undefined) {
        await this.signOutHome(kind, attempt.home)
        return { phase: 'failed', errorCode: 'identity-unavailable' }
      }
      await this.exclusive(async () => {
        const record: AccountRecord = { id: attempt.accountId, kind, ...identity, createdAt: Date.now() }
        const promoted = this.file.defaults[kind] === undefined
        await this.commit({
          ...this.file,
          accounts: [...this.file.accounts, record],
          defaults: promoted ? { ...this.file.defaults, [kind]: record.id } : this.file.defaults,
        })
        if (promoted) this.ctx.emit('ai-account/default-changed', kind)
      })
      return { phase: 'succeeded', errorCode: null }
    } catch (error) {
      console.info('[ai-account] sign-in failed', { kind, error: errorText(error) })
      return interrupted() ?? { phase: 'failed', errorCode: 'login-failed' }
    }
  }

  private async executable(kind: AiAccountKind, signal?: AbortSignal): Promise<string | undefined> {
    try {
      return await this.ctx.subprocess.resolveExecutable(this.config.executables[kind], undefined, signal)
    } catch (error) {
      if (error instanceof SubprocessExecutableNotFoundError) return undefined
      throw error
    }
  }

  private async run(kind: AiAccountKind, home: string, args: readonly string[], executable: string) {
    const handle = this.ctx.subprocess.spawn({
      argv: [executable, ...args],
      cwd: home,
      env: { [CLI[kind].homeEnv]: home },
      stdio: { stdin: 'ignore', stdout: { maxBytes: OUTPUT_LIMIT_BYTES }, stderr: { maxBytes: OUTPUT_LIMIT_BYTES } },
      graceMs: this.config.graceMs,
      signal: AbortSignal.timeout(this.config.commandTimeoutMs),
    })
    const { exitCode } = await handle.done
    /* v8 ignore next -- collect-mode stdio always creates both readers; the optional type covers other dispositions. */
    const read = (reader: typeof handle.collected.stdout): string => reader?.readFrom(0).text ?? ''
    return { exitCode, stdout: read(handle.collected.stdout), stderr: read(handle.collected.stderr) }
  }

  private async identify(kind: AiAccountKind, home: string, executable: string): Promise<CliIdentity | undefined> {
    try {
      const { exitCode, stdout, stderr } = await this.run(kind, home, CLI[kind].statusArgs, executable)
      return CLI[kind].parseIdentity(exitCode, stdout, stderr)
    } catch (error) {
      console.info('[ai-account] status failed', { kind, error: errorText(error) })
      return undefined
    }
  }

  /** Revoke the CLI's stored login for one directory; failures are logged because the directory is deleted next. */
  private async signOutHome(kind: AiAccountKind, home: string): Promise<void> {
    try {
      const executable = await this.executable(kind)
      if (executable === undefined) return
      const { exitCode } = await this.run(kind, home, CLI[kind].logoutArgs, executable)
      if (exitCode !== 0) console.info('[ai-account] logout failed', { kind, exitCode })
    } catch (error) {
      console.info('[ai-account] logout failed', { kind, error: errorText(error) })
    }
  }
}
export default PlatformAiAccount
