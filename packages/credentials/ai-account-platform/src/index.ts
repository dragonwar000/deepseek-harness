/**
 * AI Account provider that signs in, identifies, and signs out Claude and ChatGPT subscription
 * accounts only by running the official Claude Code and Codex CLIs against one configuration
 * directory per account. It never reads, copies, or refreshes the credentials those CLIs store.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, rm, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  AiAccount, type AiAccountId, type AiAccountKind, type AiAccountSignInId, type AiAccountSignInView, type AiAccountStatusView,
  type AiAccountView, type AiAccountsView,
} from '@deepseek-ai/dsh-ai-account'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { SubprocessExecutableNotFoundError, type SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { CLI, INCONCLUSIVE, LoginOutput, type CliIdentity, type CliStatus } from './cli.ts'
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
  /** Rows of the terminal allocated for the login command. */
  loginRows?: number
  /** Columns of the terminal allocated for the login command; a narrow terminal can wrap the URL the CLI prints. */
  loginCols?: number
  /** Terminal type advertised to the login command through `TERM`; the Host must have its terminfo entry. */
  loginTerminalType?: string
  /** Interval between periodic sign-in status checks of every account, in milliseconds; `0` disables periodic checks. */
  statusCheckIntervalMs?: number
  /** Deadline for one account's status command during a sign-in status check, in milliseconds. */
  statusCheckTimeoutMs?: number
  /** Accounts whose status commands one sign-in status check runs at the same time. */
  statusCheckConcurrency?: number
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
  loginRows: Schema.number().min(1).max(1_000).default(40),
  loginCols: Schema.number().min(40).max(1_000).default(200),
  loginTerminalType: Schema.string().min(1).default('xterm-256color'),
  statusCheckIntervalMs: Schema.union([Schema.const(0), Schema.natural().min(30_000).max(86_400_000)]).default(300_000),
  statusCheckTimeoutMs: Schema.natural().min(1_000).max(120_000).default(15_000),
  statusCheckConcurrency: Schema.natural().min(1).max(8).default(2),
})

/** Configuration with every default applied. */
export interface ResolvedConfig {
  readonly root: string
  readonly executables: Readonly<Record<AiAccountKind, string>>
  readonly loginTimeoutMs: number
  readonly commandTimeoutMs: number
  readonly graceMs: number
  readonly loginRows: number
  readonly loginCols: number
  readonly loginTerminalType: string
  /** Interval between periodic sign-in status checks; `null` when periodic checks are disabled. */
  readonly statusCheckIntervalMs: number | null
  readonly statusCheckTimeoutMs: number
  readonly statusCheckConcurrency: number
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
    loginRows: valid.loginRows,
    loginCols: valid.loginCols,
    loginTerminalType: valid.loginTerminalType,
    statusCheckIntervalMs: valid.statusCheckIntervalMs === 0 ? null : valid.statusCheckIntervalMs,
    statusCheckTimeoutMs: valid.statusCheckTimeoutMs,
    statusCheckConcurrency: valid.statusCheckConcurrency,
  }
}

/** Bytes kept from a status or logout command's output. */
const OUTPUT_LIMIT_BYTES = 16 * 1024
const KIND_ORDER: readonly AiAccountKind[] = ['claude', 'chatgpt']
const ACTIVE_PHASES = new Set<AiAccountSignInView['phase']>(['starting', 'waiting-browser', 'waiting-device-code', 'verifying'])
const UNKNOWN_STATUS: AiAccountStatusView = { status: 'unknown', checkedAt: null, message: null }

interface Attempt {
  view: AiAccountSignInView
  readonly accountId: AiAccountId
  readonly home: string
  readonly controller: AbortController
  done: Promise<void>
  /** Login terminal while the command runs, so a submitted authorization code reaches its standard input. */
  terminal: SubprocessTerminalHandle | undefined
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
  /** Latest conclusive status per account; held in memory only, so every account starts `unknown`. */
  private readonly statuses = new Map<AiAccountId, AiAccountStatusView>()
  /** The running sign-in status check, joined by every caller until it settles. */
  private checking: Promise<void> | undefined
  /** Aborted at unload so a running status check stops its CLI commands. */
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - context providing the subprocess seam.
   * @param config - deployment choices.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    ctx.effect(() => async () => {
      this.closed = true
      this.lifetime.abort()
      this.attempt?.controller.abort()
      await this.checking
      await this.attempt?.done
      await this.queue
      this.publish()
    }, 'ai-account: sign-in, status check, and mutation lifetime')
  }

  async [Service.init](): Promise<void> {
    this.file = await readAccountFile(this.filePath())
    const interval = this.config.statusCheckIntervalMs
    if (interval === null) return
    this.ctx.effect(() => {
      void this.check()
      const timer = setInterval(() => { void this.check() }, interval)
      return () => { clearInterval(timer) }
    }, 'ai-account: periodic sign-in status checks')
  }

  override getState(): Promise<AiAccountsView> {
    return Promise.resolve(this.snapshot())
  }

  override startSignIn(kind: AiAccountKind): Promise<AiAccountsView> {
    if (this.closed) return Promise.reject(new Error('ai-account: provider closed'))
    if (this.attempt === undefined || !ACTIVE_PHASES.has(this.attempt.view.phase)) {
      const accountId = randomUUID() as AiAccountId
      const attempt: Attempt = {
        view: {
          id: randomUUID() as AiAccountSignInId, kind, phase: 'starting', url: null, userCode: null,
          awaitingCode: false, errorCode: null,
        },
        accountId,
        home: this.homeOf(kind, accountId),
        controller: new AbortController(),
        done: Promise.resolve(),
        terminal: undefined,
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

  override async submitSignInCode(id: AiAccountSignInId, code: string): Promise<AiAccountsView> {
    const attempt = this.attempt
    const terminal = attempt?.terminal
    if (attempt?.view.id === id && attempt.view.awaitingCode && terminal !== undefined) {
      // The code is the vendor's, so it is written straight through to the CLI's
      // terminal and never logged, stored, or matched against the CLI's output.
      // `awaitingCode` deliberately stays set until the command exits: a CLI that
      // rejects one code prompts again, and clearing the field here would leave the
      // user no way to answer that prompt.
      await terminal.write(`${code}\r`)
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
      await this.discardHome(home)
      const accounts = this.file.accounts.filter(candidate => candidate.id !== id)
      const wasDefault = this.file.defaults[account.kind] === id
      const successor = accounts.filter(candidate => candidate.kind === account.kind)
        .toSorted((left, right) => left.createdAt - right.createdAt)[0]
      const defaults = wasDefault ? { ...this.file.defaults, [account.kind]: successor?.id } : this.file.defaults
      await this.commit({ ...this.file, accounts, defaults })
      this.statuses.delete(id)
      if (wasDefault) this.ctx.emit('ai-account/default-changed', account.kind)
      return this.snapshot()
    })
  }

  override async checkStatus(): Promise<AiAccountsView> {
    if (this.closed) throw new Error('ai-account: provider closed')
    await this.check()
    return this.snapshot()
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
      .map(account => ({
        ...account,
        isDefault: this.file.defaults[account.kind] === account.id,
        status: this.statuses.get(account.id) ?? UNKNOWN_STATUS,
      }))
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
    if (outcome.phase !== 'succeeded') await this.discardHome(attempt.home)
    attempt.terminal = undefined
    this.update(attempt, { ...outcome, awaitingCode: false })
  }

  /**
   * Delete one attempt's configuration directory and the kind directory that held it
   * when nothing else does, so a failed first attempt leaves no empty `<root>/<kind>/`
   * behind to look like a registered account.
   */
  private async discardHome(home: string): Promise<void> {
    await rm(home, { recursive: true, force: true })
    try {
      await rmdir(dirname(home))
    } catch (_kindDirectoryKeptOrGone: unknown) {
      // ENOTEMPTY means another account of this kind still lives there and ENOENT that
      // the directory never existed; neither is a failure of this attempt's cleanup.
    }
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
      // A terminal, not pipes: every official login command is an interactive
      // prompt that reads its confirmation from a terminal, so on /dev/null
      // standard input it prints its URL and then waits for an answer it can
      // never receive until the deadline fires.
      const terminal = await this.ctx.subprocess.spawnTerminal({
        argv: [executable, ...cli.loginArgs],
        cwd: attempt.home,
        env: { [cli.homeEnv]: attempt.home },
        rows: this.config.loginRows,
        cols: this.config.loginCols,
        terminalType: this.config.loginTerminalType,
        graceMs: this.config.graceMs,
        signal,
      })
      attempt.terminal = terminal
      // The spawn signal only cancels allocation, so cancellation and the deadline
      // reach a live login only through this listener.
      let termination: Promise<void> | undefined
      const stop = (): void => { termination ??= terminal.terminate() }
      signal.addEventListener('abort', stop, { once: true })
      // An abort between allocation and this listener would otherwise never be observed.
      if (signal.aborted) stop()
      try {
        const output = new LoginOutput(cli.deviceCode)
        terminal.output.on('data', (chunk: Buffer) => {
          const prompt = output.push(chunk.toString('utf8'))
          if (prompt !== undefined) this.update(attempt, prompt)
        })
        this.update(attempt, { phase: cli.waitingPhase, awaitingCode: cli.awaitsCode })
        const { exitCode } = await terminal.done
        const stopped = interrupted()
        if (stopped !== undefined) return stopped
        if (exitCode !== 0) return { phase: 'failed', errorCode: 'login-failed' }
        this.update(attempt, { phase: 'verifying', awaitingCode: false })
        const identity = await this.identify(kind, attempt.home, executable)
        if (identity === undefined) {
          await this.signOutHome(kind, attempt.home)
          return { phase: 'failed', errorCode: 'identity-unavailable' }
        }
        const outcome = await this.register(attempt, kind, identity)
        // A provider closing while the record is written is a cancelled attempt, not a storage fault.
        return outcome.errorCode === 'store-failed' ? interrupted() ?? outcome : outcome
      } finally {
        signal.removeEventListener('abort', stop)
        attempt.terminal = undefined
        // Reach quiescence rather than request it: a login left running would keep
        // the vendor CLI and its terminal alive past this attempt.
        try {
          await (termination ??= terminal.terminate())
        } catch (error: unknown) {
          console.info('[ai-account] login terminal cleanup failed', { kind, error: errorText(error) })
        }
      }
    } catch (error) {
      console.info('[ai-account] sign-in failed', { kind, error: errorText(error) })
      return interrupted() ?? { phase: 'failed', errorCode: 'login-failed' }
    }
  }

  /**
   * Record one signed-in account.
   * @returns `succeeded`, or `store-failed` when the account could not be recorded.
   */
  private async register(attempt: Attempt, kind: AiAccountKind, identity: CliIdentity): Promise<Outcome> {
    try {
      await this.exclusive(async () => {
        const record: AccountRecord = { id: attempt.accountId, kind, ...identity, createdAt: Date.now() }
        const promoted = this.file.defaults[kind] === undefined
        // The identity read that preceded registration is a conclusive status answer.
        this.statuses.set(record.id, { status: 'signedIn', checkedAt: Date.now(), message: null })
        await this.commit({
          ...this.file,
          accounts: [...this.file.accounts, record],
          defaults: promoted ? { ...this.file.defaults, [kind]: record.id } : this.file.defaults,
        })
        if (promoted) this.ctx.emit('ai-account/default-changed', kind)
      })
      return { phase: 'succeeded', errorCode: null }
    } catch (error) {
      // Not `login-failed`: the vendor signed in and only this Harness's own write
      // failed, so the cause must stay distinguishable from a refused login. The CLI
      // is signed back out because the discarded directory would otherwise keep a
      // credential that no account record points at.
      console.info('[ai-account] storing the signed-in account failed', { kind, error: errorText(error) })
      await this.signOutHome(kind, attempt.home)
      return { phase: 'failed', errorCode: 'store-failed' }
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

  private async run(kind: AiAccountKind, home: string, args: readonly string[], executable: string, signal: AbortSignal) {
    const handle = this.ctx.subprocess.spawn({
      argv: [executable, ...args],
      cwd: home,
      env: { [CLI[kind].homeEnv]: home },
      stdio: { stdin: 'ignore', stdout: { maxBytes: OUTPUT_LIMIT_BYTES }, stderr: { maxBytes: OUTPUT_LIMIT_BYTES } },
      graceMs: this.config.graceMs,
      signal,
    })
    const { exitCode } = await handle.done
    /* v8 ignore next -- collect-mode stdio always creates both readers; the optional type covers other dispositions. */
    const read = (reader: typeof handle.collected.stdout): string => reader?.readFrom(0).text ?? ''
    return { exitCode, stdout: read(handle.collected.stdout), stderr: read(handle.collected.stderr) }
  }

  private async identify(kind: AiAccountKind, home: string, executable: string): Promise<CliIdentity | undefined> {
    const answer = await this.status(kind, home, executable, AbortSignal.timeout(this.config.commandTimeoutMs))
    return answer.state === 'signedIn' ? answer.identity : undefined
  }

  /** Run one directory's status command; a command that fails to run is `inconclusive`. */
  private async status(kind: AiAccountKind, home: string, executable: string, signal: AbortSignal): Promise<CliStatus> {
    try {
      const { exitCode, stdout, stderr } = await this.run(kind, home, CLI[kind].statusArgs, executable, signal)
      return CLI[kind].parseStatus(exitCode, stdout, stderr)
    } catch (error) {
      console.info('[ai-account] status failed', { kind, error: errorText(error) })
      return INCONCLUSIVE
    }
  }

  /** Join the running sign-in status check or start one; never rejects. */
  private check(): Promise<void> {
    this.checking ??= this.checkAll().finally(() => { this.checking = undefined })
    return this.checking
  }

  /** Check the accounts registered when the check starts, at most `statusCheckConcurrency` at a time. */
  private async checkAll(): Promise<void> {
    const pending = [...this.file.accounts]
    const worker = async (): Promise<void> => {
      for (let account = pending.shift(); account !== undefined; account = pending.shift()) await this.checkOne(account)
    }
    await Promise.all(Array.from({ length: Math.min(this.config.statusCheckConcurrency, pending.length) }, worker))
  }

  /** Record one account's conclusive status answer and emit `ai-account/status-changed` on a transition. */
  private async checkOne(account: AccountRecord): Promise<void> {
    if (this.lifetime.signal.aborted) return
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.statusCheckTimeoutMs)])
    let executable: string | undefined
    try {
      executable = await this.executable(account.kind, signal)
    } catch (error) {
      console.info('[ai-account] status failed', { kind: account.kind, error: errorText(error) })
      return
    }
    if (executable === undefined) return
    const answer = await this.status(account.kind, this.homeOf(account.kind, account.id), executable, signal)
    // Output cut short by the deadline or unload is not an answer, and a removed account has no status.
    if (answer.state === 'inconclusive' || signal.aborted || !this.file.accounts.some(({ id }) => id === account.id)) return
    const current: AiAccountStatusView = answer.state === 'signedIn'
      ? { status: 'signedIn', checkedAt: Date.now(), message: null }
      : { status: 'signedOut', checkedAt: Date.now(), message: answer.message }
    const previous = (this.statuses.get(account.id) ?? UNKNOWN_STATUS).status
    this.statuses.set(account.id, current)
    this.publish()
    if (previous === current.status) return
    const isDefault = this.file.defaults[account.kind] === account.id
    this.ctx.emit('ai-account/status-changed', { id: account.id, kind: account.kind, isDefault, previous, current })
  }

  /** Revoke the CLI's stored login for one directory; failures are logged because the directory is deleted next. */
  private async signOutHome(kind: AiAccountKind, home: string): Promise<void> {
    try {
      const executable = await this.executable(kind)
      if (executable === undefined) return
      const { exitCode } = await this.run(kind, home, CLI[kind].logoutArgs, executable, AbortSignal.timeout(this.config.commandTimeoutMs))
      if (exitCode !== 0) console.info('[ai-account] logout failed', { kind, exitCode })
    } catch (error) {
      console.info('[ai-account] logout failed', { kind, error: errorText(error) })
    }
  }
}
export default PlatformAiAccount
