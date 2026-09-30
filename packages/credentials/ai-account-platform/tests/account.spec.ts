/** Official-CLI account sign-in, identity, default selection, removal, and persistence against fake executables. */
import { randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { AiAccountId, AiAccountKind, AiAccountSignInId, AiAccountStatusChange, AiAccountsView } from '@deepseek-ai/dsh-ai-account'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PlatformAiAccount, { resolveConfig, type Config } from '../src/index.ts'

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-cli.cjs', import.meta.url))
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface Fixture {
  readonly ctx: Context
  readonly service: PlatformAiAccount
  readonly bin: string
  readonly root: string
  readonly changes: AiAccountKind[]
  readonly transitions: AiAccountStatusChange[]
}

/** @returns a temporary directory holding fake `claude` and `codex` executables. */
function fakeBin(): string {
  const bin = mkdtempSync(join(tmpdir(), 'dsh-ai-account-bin-'))
  for (const product of ['claude', 'codex']) {
    copyFileSync(FAKE_CLI, join(bin, product))
    chmodSync(join(bin, product), 0o755)
  }
  cleanups.push(() =>{  rmSync(bin, { recursive: true, force: true }) })
  return bin
}

async function mount(options: { bin?: string; root?: string; config?: Config } = {}): Promise<Fixture> {
  const bin = options.bin ?? fakeBin()
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'dsh-ai-account-root-'))
  if (options.root === undefined) cleanups.push(() =>{  rmSync(root, { recursive: true, force: true }) })
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  const changes: AiAccountKind[] = []
  ctx.on('ai-account/default-changed', (kind) => { changes.push(kind) })
  const transitions: AiAccountStatusChange[] = []
  ctx.on('ai-account/status-changed', (change) => { transitions.push(change) })
  // Periodic checks stay off unless a test enables them, so status commands appear only where a test expects them.
  const config: Config = Object.assign(
    { root, claudeCliPath: join(bin, 'claude'), codexCliPath: join(bin, 'codex'), statusCheckIntervalMs: 0 }, options.config,
  )
  await ctx.plugin(PlatformAiAccount, config)
  return { ctx, service: ctx.get('aiAccount') as PlatformAiAccount, bin, root, changes, transitions }
}

/** Resolve with the first watched snapshot that satisfies the predicate. */
async function until(service: PlatformAiAccount, predicate: (view: AiAccountsView) => boolean): Promise<AiAccountsView> {
  const lifetime = new AbortController()
  try {
    for await (const view of service.watch(lifetime.signal)) if (predicate(view)) return view
  } finally {
    lifetime.abort()
  }
  throw new Error('watch ended before the expected snapshot')
}

interface Call { product: string; args: string; home: string }

function calls(bin: string): Call[] {
  const log = join(bin, 'calls.log')
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Call) : []
}

function statusCalls(bin: string): number {
  return calls(bin).filter(call => call.args === 'auth status --json' || call.args === 'login status').length
}

/** @returns an account root whose stored accounts are signed in; the first account of each kind is its default. */
function seed(kinds: readonly AiAccountKind[]): { root: string; ids: AiAccountId[] } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ai-account-seeded-'))
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }) })
  const accounts = kinds.map((kind, index) => ({ id: randomUUID() as AiAccountId, kind, email: null, plan: null, createdAt: index + 1 }))
  const defaults: Partial<Record<AiAccountKind, AiAccountId>> = {}
  for (const account of accounts) {
    defaults[account.kind] ??= account.id
    const home = join(root, account.kind === 'claude' ? 'claude' : 'codex', account.id)
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'fake-signed-in'), 'yes')
  }
  writeFileSync(join(root, 'accounts.json'), JSON.stringify({ version: 1, accounts, defaults }))
  return { root, ids: accounts.map(account => account.id) }
}

/** Let settled checks run their completion handlers; only interval timers are ever faked here. */
const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

/**
 * Authorize the waiting login the way its own flow does: Claude reads the code the
 * browser page showed from its terminal, and Codex polls the authorization service.
 */
async function authorize(fixture: Fixture, kind: AiAccountKind, id: AiAccountSignInId, code = 'browser-code'): Promise<void> {
  if (kind === 'claude') await fixture.service.submitSignInCode(id, code)
  else writeFileSync(join(fixture.bin, 'codex.approve'), '')
}

async function addAccount(fixture: Fixture, kind: AiAccountKind): Promise<AiAccountId> {
  const before = new Set((await fixture.service.getState()).accounts.map(account => account.id))
  const started = await fixture.service.startSignIn(kind)
  const attempt = started.signIn!.id
  await until(fixture.service, view => view.signIn !== null && view.signIn.id === attempt && view.signIn.url !== null
    && (kind === 'claude' || view.signIn.userCode !== null))
  await authorize(fixture, kind, attempt)
  const done = await until(fixture.service, view => view.signIn !== null && view.signIn.id === attempt && view.signIn.phase === 'succeeded')
  const added = done.accounts.find(account => !before.has(account.id))
  if (added === undefined) throw new Error('no account was added')
  return added.id
}

describe.skipIf(process.platform === 'win32')('official-CLI AI accounts', () => {
  it('signs a Claude account in through its own configuration directory and makes it the default', async () => {
    const fixture = await mount()
    const started = await fixture.service.startSignIn('claude')
    expect(started.signIn).toMatchObject({ kind: 'claude', phase: 'starting', url: null, userCode: null, errorCode: null })
    const joined = await fixture.service.startSignIn('chatgpt')
    expect(joined.signIn?.id).toBe(started.signIn?.id)
    const waiting = await until(fixture.service, view => view.signIn?.url !== null)
    expect(waiting.signIn).toMatchObject({
      phase: 'waiting-browser', url: 'https://claude.ai/oauth/authorize?code=true&state=fake', userCode: null, awaitingCode: true,
    })
    await fixture.service.submitSignInCode(started.signIn!.id, 'browser-code')
    const done = await until(fixture.service, view => view.signIn?.phase === 'succeeded')
    // The code reached the login command's own terminal, which is the only channel that completes the flow.
    expect(readFileSync(join(fixture.bin, 'submitted-code'), 'utf8')).toBe('browser-code')
    expect(done.signIn?.awaitingCode).toBe(false)
    const [account] = done.accounts
    expect(done.accounts).toHaveLength(1)
    expect(account).toMatchObject({ kind: 'claude', email: 'claude-user@example.com', plan: 'max', isDefault: true })
    const home = join(fixture.root, 'claude', account!.id)
    expect(fixture.service.defaultHome('claude')).toBe(home)
    expect(fixture.service.defaultHome('chatgpt')).toBeUndefined()
    expect(fixture.changes).toEqual(['claude'])
    expect(calls(fixture.bin)).toEqual([
      { product: 'claude', args: 'auth login --claudeai', home },
      { product: 'claude', args: 'auth status --json', home },
    ])
    const stored: unknown = JSON.parse(readFileSync(join(fixture.root, 'accounts.json'), 'utf8'))
    expect(stored).toEqual({ version: 1, accounts: [{ id: account!.id, kind: 'claude', email: 'claude-user@example.com', plan: 'max', createdAt: account!.createdAt }], defaults: { claude: account!.id } })
    expect(JSON.stringify(stored)).not.toContain('fake-signed-in')
  })

  it('surfaces the ChatGPT device code, switches the default, and promotes the remaining account on removal', async () => {
    const fixture = await mount()
    await fixture.service.startSignIn('chatgpt')
    const prompted = await until(fixture.service, view => view.signIn?.userCode !== null)
    expect(prompted.signIn).toMatchObject({
      phase: 'waiting-device-code', url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGHI', awaitingCode: false,
    })
    writeFileSync(join(fixture.bin, 'codex.approve'), '')
    await until(fixture.service, view => view.signIn?.phase === 'succeeded')
    const first = (await fixture.service.getState()).accounts[0]!
    expect(first).toMatchObject({ kind: 'chatgpt', email: null, plan: null, isDefault: true })
    writeFileSync(join(fixture.bin, 'codex.behavior'), 'status-email')
    const second = await addAccount(fixture, 'chatgpt')
    const both = await fixture.service.getState()
    expect(both.accounts.map(account => [account.id, account.email, account.isDefault])).toEqual([
      [first.id, null, true], [second, 'codex-user@example.com', false],
    ])
    expect(fixture.changes).toEqual(['chatgpt'])
    const switched = await fixture.service.setDefault(second)
    expect(switched.accounts.find(account => account.id === second)?.isDefault).toBe(true)
    expect(fixture.service.defaultHome('chatgpt')).toBe(join(fixture.root, 'codex', second))
    await fixture.service.setDefault(second)
    expect(fixture.changes).toEqual(['chatgpt', 'chatgpt'])
    const secondHome = join(fixture.root, 'codex', second)
    const remaining = await fixture.service.remove(second)
    expect(remaining.accounts.map(account => [account.id, account.isDefault])).toEqual([[first.id, true]])
    expect(existsSync(secondHome)).toBe(false)
    expect(calls(fixture.bin).filter(call => call.args === 'logout')).toEqual([{ product: 'codex', args: 'logout', home: secondHome }])
    expect(fixture.changes).toEqual(['chatgpt', 'chatgpt', 'chatgpt'])
    await fixture.service.remove(first.id)
    expect(fixture.service.defaultHome('chatgpt')).toBeUndefined()
    expect(fixture.changes).toHaveLength(4)
    await expect(fixture.service.setDefault(first.id)).rejects.toThrow(`ai-account: no account ${first.id}`)
    await expect(fixture.service.remove(first.id)).rejects.toThrow('no account')
  })

  it('keeps defaults per kind and removing a non-default account keeps the default', async () => {
    const fixture = await mount()
    const claude = await addAccount(fixture, 'claude')
    const codex = await addAccount(fixture, 'chatgpt')
    const claudeSecond = await addAccount(fixture, 'claude')
    const claudeThird = await addAccount(fixture, 'claude')
    const view = await fixture.service.getState()
    expect(view.accounts.map(account => [account.id, account.kind, account.isDefault])).toEqual([
      [claude, 'claude', true], [claudeSecond, 'claude', false], [claudeThird, 'claude', false], [codex, 'chatgpt', true],
    ])
    fixture.changes.length = 0
    await fixture.service.remove(claudeThird)
    expect(fixture.changes).toEqual([])
    expect(fixture.service.defaultHome('claude')).toBe(join(fixture.root, 'claude', claude))
    await fixture.service.setDefault(claudeSecond)
    const thirdAgain = await addAccount(fixture, 'claude')
    await fixture.service.remove(claudeSecond)
    expect(fixture.changes).toEqual(['claude', 'claude'])
    expect(fixture.service.defaultHome('claude')).toBe(join(fixture.root, 'claude', claude))
    expect((await fixture.service.getState()).accounts.map(account => account.id)).toEqual([claude, thirdAgain, codex])
  })

  it('cancels an attempt, discards its directory, and ignores a stale attempt id', async () => {
    const fixture = await mount()
    const started = await fixture.service.startSignIn('claude')
    await until(fixture.service, view => view.signIn?.url !== null)
    const home = calls(fixture.bin)[0]!.home
    expect(existsSync(home)).toBe(true)
    const unchanged = await fixture.service.cancelSignIn('stale' as AiAccountSignInId)
    expect(unchanged.signIn?.phase).toBe('waiting-browser')
    const cancelled = await fixture.service.cancelSignIn(started.signIn!.id)
    expect(cancelled.accounts).toEqual([])
    expect(cancelled.signIn).toMatchObject({ phase: 'cancelled', errorCode: null })
    expect(existsSync(home)).toBe(false)
    const restarted = await fixture.service.startSignIn('claude')
    expect(restarted.signIn?.id).not.toBe(started.signIn?.id)
  })

  it('cancels before the login command starts', async () => {
    const fixture = await mount()
    const started = await fixture.service.startSignIn('chatgpt')
    const cancelled = await fixture.service.cancelSignIn(started.signIn!.id)
    expect(cancelled.signIn?.phase).toBe('cancelled')
    expect(calls(fixture.bin)).toEqual([])
  })

  it('runs the login command on a terminal, which closed standard input cannot replace', async () => {
    // The disposition this provider used before: fd 0 on /dev/null. Every official login
    // command renders a terminal interface and reads its confirmation from one, so it
    // refuses this launch outright — the sign-in could never be confirmed on it.
    const fixture = await mount()
    const handle = fixture.ctx.get('subprocess')!.spawn({
      argv: [join(fixture.bin, 'claude'), 'auth', 'login', '--claudeai'],
      cwd: fixture.root,
      env: { CLAUDE_CONFIG_DIR: fixture.root },
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      graceMs: 1_000,
      signal: AbortSignal.timeout(20_000),
    })
    const { exitCode } = await handle.done
    expect(exitCode).toBe(2)
    expect(handle.collected.stderr?.readFrom(0).text).toContain('raw mode is not supported')
    // On a terminal the same command prints its URL and takes the code it reads there.
    await addAccount(fixture, 'claude')
    expect(readFileSync(join(fixture.bin, 'submitted-code'), 'utf8')).toBe('browser-code')
  })

  it('records a login terminal that cannot be cleaned up without losing the sign-in', async () => {
    const fixture = await mount()
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    cleanups.push(() =>{  info.mockRestore() })
    const runtime = fixture.ctx.get('subprocess')!
    const real = runtime.spawnTerminal.bind(runtime)
    const spawnTerminal = vi.spyOn(runtime, 'spawnTerminal').mockImplementation(async (spec) => {
      const handle = await real(spec)
      const wrapped: SubprocessTerminalHandle = {
        pid: handle.pid,
        output: handle.output,
        done: handle.done,
        write: data => handle.write(data),
        resize: (cols, rows) => handle.resize(cols, rows),
        inspectForeground: () => handle.inspectForeground(),
        inspectActivity: () => handle.inspectActivity(),
        signalForeground: signal => handle.signalForeground(signal),
        terminate: async () => { await handle.terminate(); throw new Error('terminate exploded') },
      }
      return wrapped
    })
    // The account was already written when cleanup failed, so the attempt keeps its outcome.
    const id = await addAccount(fixture, 'claude')
    expect((await fixture.service.getState()).accounts.map(account => account.id)).toEqual([id])
    expect(info).toHaveBeenCalledWith('[ai-account] login terminal cleanup failed', { kind: 'claude', error: 'terminate exploded' })
    spawnTerminal.mockRestore()
  })

  it('stops a login whose deadline passed while its terminal was still being allocated', async () => {
    // The spawn signal only cancels allocation. An attempt aborted in the window between
    // a published terminal and the abort listener would otherwise run to no deadline at all.
    const fixture = await mount({ config: { loginTimeoutMs: 1_000 } })
    const runtime = fixture.ctx.get('subprocess')!
    const real = runtime.spawnTerminal.bind(runtime)
    const spawnTerminal = vi.spyOn(runtime, 'spawnTerminal').mockImplementation(async (spec) => {
      const handle = await real(spec)
      await new Promise(resolve => setTimeout(resolve, 1_500))
      return handle
    })
    await fixture.service.startSignIn('claude')
    const failed = await until(fixture.service, view => view.signIn?.phase === 'failed')
    expect(failed.signIn?.errorCode).toBe('timeout')
    expect(existsSync(join(fixture.root, 'claude'))).toBe(false)
    spawnTerminal.mockRestore()
  })

  it('leaves no empty kind directory behind when an attempt never registers an account', async () => {
    const fixture = await mount()
    writeFileSync(join(fixture.bin, 'claude.behavior'), 'login-fails')
    await fixture.service.startSignIn('claude')
    await until(fixture.service, view => view.signIn?.phase === 'failed')
    // An empty `<root>/claude/` would look like a kind that already has accounts.
    expect(existsSync(join(fixture.root, 'claude'))).toBe(false)
    writeFileSync(join(fixture.bin, 'claude.behavior'), '')
    const kept = await addAccount(fixture, 'claude')
    const removed = await addAccount(fixture, 'claude')
    // A kind directory that still holds another account survives one account's removal.
    await fixture.service.remove(removed)
    expect(existsSync(join(fixture.root, 'claude', kept))).toBe(true)
    await fixture.service.remove(kept)
    expect(existsSync(join(fixture.root, 'claude'))).toBe(false)
  })

  it('reports a failed account write as its own cause and signs the CLI back out', async () => {
    const fixture = await mount()
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    cleanups.push(() =>{  info.mockRestore() })
    const started = await fixture.service.startSignIn('claude')
    await until(fixture.service, view => view.signIn?.phase === 'waiting-browser')
    // The CLI signs in and only this Harness's own write fails.
    chmodSync(fixture.root, 0o500)
    // Cleanups run last-registered first, so this restores write access before the root is deleted.
    cleanups.push(() =>{  chmodSync(fixture.root, 0o700) })
    await fixture.service.submitSignInCode(started.signIn!.id, 'browser-code')
    const failed = await until(fixture.service, view => view.signIn?.phase === 'failed')
    // Not `login-failed`: the vendor did sign in, so the cause must stay distinguishable.
    expect(failed.signIn?.errorCode).toBe('store-failed')
    expect(failed.accounts).toEqual([])
    expect(info).toHaveBeenCalledWith('[ai-account] storing the signed-in account failed', expect.objectContaining({ kind: 'claude' }))
    // The directory would otherwise keep a credential no account record points at.
    expect(calls(fixture.bin).at(-1)).toMatchObject({ args: 'auth logout' })
    expect(existsSync(join(fixture.root, 'claude', started.signIn!.id))).toBe(false)
  })

  it('ignores a code for a stale attempt, an attempt reading none, and a rejected code', async () => {
    const fixture = await mount()
    // No attempt at all, then an attempt that reads no code.
    expect((await fixture.service.submitSignInCode('stale' as AiAccountSignInId, 'x')).signIn).toBeNull()
    const codex = await fixture.service.startSignIn('chatgpt')
    await until(fixture.service, view => view.signIn?.phase === 'waiting-device-code')
    const unchanged = await fixture.service.submitSignInCode(codex.signIn!.id, 'x')
    expect(unchanged.signIn).toMatchObject({ phase: 'waiting-device-code', awaitingCode: false })
    expect(existsSync(join(fixture.bin, 'submitted-code'))).toBe(false)
    await fixture.service.cancelSignIn(codex.signIn!.id)

    const started = await fixture.service.startSignIn('claude')
    await until(fixture.service, view => view.signIn?.phase === 'waiting-browser')
    // A stale id never reaches the live attempt's terminal.
    await fixture.service.submitSignInCode('stale' as AiAccountSignInId, 'x')
    expect(existsSync(join(fixture.bin, 'submitted-code'))).toBe(false)
    await fixture.service.cancelSignIn(started.signIn!.id)

    writeFileSync(join(fixture.bin, 'claude.behavior'), 'code-rejected')
    const rejected = await fixture.service.startSignIn('claude')
    await until(fixture.service, view => view.signIn !== null && view.signIn.id === rejected.signIn?.id && view.signIn.phase === 'waiting-browser')
    await fixture.service.submitSignInCode(rejected.signIn!.id, 'wrong-code')
    const failed = await until(fixture.service, view => view.signIn !== null && view.signIn.id === rejected.signIn?.id && view.signIn.phase === 'failed')
    expect(failed.signIn).toMatchObject({ errorCode: 'login-failed', awaitingCode: false })
  })

  it('reports login failure, a missing executable, an unreadable identity, and the login deadline', async () => {
    const fixture = await mount({ config: { loginTimeoutMs: 1_000 } })
    writeFileSync(join(fixture.bin, 'claude.behavior'), 'login-fails')
    await fixture.service.startSignIn('claude')
    const failed = await until(fixture.service, view => view.signIn?.phase === 'failed')
    expect(failed.signIn?.errorCode).toBe('login-failed')
    expect(existsSync(calls(fixture.bin)[0]!.home)).toBe(false)

    writeFileSync(join(fixture.bin, 'claude.behavior'), 'status-garbage')
    const started = await fixture.service.startSignIn('claude')
    await until(fixture.service, view => view.signIn !== null && view.signIn.id === started.signIn?.id && view.signIn.phase === 'waiting-browser')
    await fixture.service.submitSignInCode(started.signIn!.id, 'browser-code')
    const unidentified = await until(fixture.service, view => view.signIn !== null && view.signIn.id === started.signIn?.id && view.signIn.phase === 'failed')
    expect(unidentified.signIn?.errorCode).toBe('identity-unavailable')
    expect(calls(fixture.bin).slice(-2).map(call => call.args)).toEqual(['auth status --json', 'auth logout'])
    expect(unidentified.accounts).toEqual([])

    const timed = await fixture.service.startSignIn('chatgpt')
    const expired = await until(fixture.service, view => view.signIn !== null && view.signIn.id === timed.signIn?.id && view.signIn.phase === 'failed')
    expect(expired.signIn?.errorCode).toBe('timeout')

    const missing = await mount({ config: { claudeCliPath: join(fixture.bin, 'absent-claude') } })
    await missing.service.startSignIn('claude')
    const absent = await until(missing.service, view => view.signIn?.phase === 'failed')
    expect(absent.signIn?.errorCode).toBe('executable-missing')
  })

  it('reports an unexpected lookup failure as a login failure and still removes accounts whose logout fails', async () => {
    const fixture = await mount()
    const id = await addAccount(fixture, 'claude')
    writeFileSync(join(fixture.bin, 'claude.behavior'), 'logout-fails')
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    cleanups.push(() =>{  info.mockRestore() })
    await fixture.service.remove(id)
    expect(info).toHaveBeenCalledWith('[ai-account] logout failed', { kind: 'claude', exitCode: 3 })
    const runtime = fixture.ctx.get('subprocess')!
    const lookup = vi.spyOn(runtime, 'resolveExecutable').mockRejectedValue('lookup exploded')
    await fixture.service.startSignIn('claude')
    const failed = await until(fixture.service, view => view.signIn?.phase === 'failed')
    expect(failed.signIn?.errorCode).toBe('login-failed')
    lookup.mockRestore()
    const second = await addAccount(fixture, 'claude')
    const spawn = vi.spyOn(runtime, 'spawn').mockImplementation(() => { throw new Error('spawn exploded') })
    await fixture.service.remove(second)
    expect(info).toHaveBeenCalledWith('[ai-account] logout failed', { kind: 'claude', error: 'spawn exploded' })
    spawn.mockRestore()
    writeFileSync(join(fixture.bin, 'claude.behavior'), '')
    const started = await fixture.service.startSignIn('claude')
    await until(fixture.service, view => view.signIn !== null && view.signIn.id === started.signIn?.id && view.signIn.phase === 'waiting-browser')
    const statusSpawn = vi.spyOn(runtime, 'spawn').mockImplementation(() => { throw new Error('status exploded') })
    await fixture.service.submitSignInCode(started.signIn!.id, 'browser-code')
    const unidentified = await until(fixture.service, view => view.signIn !== null && view.signIn.id === started.signIn?.id && view.signIn.phase === 'failed')
    expect(unidentified.signIn?.errorCode).toBe('identity-unavailable')
    expect(info).toHaveBeenCalledWith('[ai-account] status failed', { kind: 'claude', error: 'status exploded' })
    statusSpawn.mockRestore()
    const root = mkdtempSync(join(tmpdir(), 'dsh-ai-account-missing-'))
    cleanups.push(() =>{  rmSync(root, { recursive: true, force: true }) })
    writeFileSync(join(root, 'accounts.json'), JSON.stringify({
      version: 1, defaults: {}, accounts: [{ id, kind: 'claude', email: null, plan: null, createdAt: 1 }],
    }))
    const reloaded = await mount({ bin: fixture.bin, root, config: { claudeCliPath: join(fixture.bin, 'absent-claude') } })
    expect((await reloaded.service.remove(id)).accounts).toEqual([])
  })

  it('restores stored accounts and rejects a corrupt account file', async () => {
    const fixture = await mount()
    const id = await addAccount(fixture, 'claude')
    await fixture.ctx.fiber.dispose()
    const restored = await mount({ bin: fixture.bin, root: fixture.root })
    expect((await restored.service.getState()).accounts).toMatchObject([{ id, isDefault: true }])
    expect(restored.service.defaultHome('claude')).toBe(join(fixture.root, 'claude', id))

    for (const content of [
      { version: 1, accounts: [], defaults: { claude: id } },
      { version: 1, accounts: [{ id, kind: 'claude', email: null, plan: null, createdAt: 1 }, { id, kind: 'claude', email: null, plan: null, createdAt: 2 }], defaults: {} },
      { version: 1, accounts: [{ id: '../escape', kind: 'claude', email: null, plan: null, createdAt: 1 }], defaults: {} },
    ]) {
      const root = mkdtempSync(join(tmpdir(), 'dsh-ai-account-corrupt-'))
      cleanups.push(() =>{  rmSync(root, { recursive: true, force: true }) })
      writeFileSync(join(root, 'accounts.json'), JSON.stringify(content))
      const ctx = new Context()
      cleanups.push(() => ctx.fiber.dispose())
      await ctx.plugin(LocalSubprocessRuntime)
      const fiber = ctx.plugin(PlatformAiAccount, { root })
      await expect(fiber).rejects.toThrow('is not a valid account file')
    }
    const unreadable = mkdtempSync(join(tmpdir(), 'dsh-ai-account-unreadable-'))
    cleanups.push(() =>{  rmSync(unreadable, { recursive: true, force: true }) })
    mkdirSync(join(unreadable, 'accounts.json'))
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.plugin(PlatformAiAccount, { root: unreadable })).rejects.toThrow()
  })

  it('cancels the active attempt on disposal and refuses later operations', async () => {
    const fixture = await mount()
    const id = await addAccount(fixture, 'claude')
    await fixture.service.startSignIn('chatgpt')
    await until(fixture.service, view => view.signIn?.phase === 'waiting-device-code')
    const service = fixture.service
    const lifetime = new AbortController()
    const stream = service.watch(lifetime.signal)[Symbol.asyncIterator]()
    await stream.next()
    const ended = stream.next()
    await fixture.ctx.fiber.dispose()
    expect(await ended).toMatchObject({ done: true })
    expect((await service.getState()).signIn?.phase).toBe('cancelled')
    await expect(service.startSignIn('claude')).rejects.toThrow('provider closed')
    await expect(service.setDefault(id)).rejects.toThrow('provider closed')
  })

  it('checks sign-in status at start and on each interval, emitting once per transition, until unload', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    cleanups.push(() => { vi.useRealTimers() })
    const { root, ids: [id] } = seed(['claude'])
    const signedIn = join(root, 'claude', id!, 'fake-signed-in')
    const fixture = await mount({ root, config: { statusCheckIntervalMs: 30_000 } })
    const status = (view: AiAccountsView) => view.accounts[0]!.status
    const started = await until(fixture.service, view => status(view).status === 'signedIn')
    await settle()
    expect(status(started)).toEqual({ status: 'signedIn', checkedAt: expect.any(Number), message: null })
    expect(fixture.transitions).toEqual([{ id, kind: 'claude', isDefault: true, previous: 'unknown', current: status(started) }])

    rmSync(signedIn)
    vi.advanceTimersByTime(30_000)
    // A caller during the interval's check joins it instead of starting another.
    const out = await fixture.service.checkStatus()
    expect(status(out)).toEqual({ status: 'signedOut', checkedAt: expect.any(Number), message: '{"loggedIn":false,"authMethod":"none"}' })
    vi.advanceTimersByTime(30_000)
    expect(status(await fixture.service.checkStatus()).status).toBe('signedOut')
    writeFileSync(signedIn, 'yes')
    expect(status(await fixture.service.checkStatus()).status).toBe('signedIn')
    expect(statusCalls(fixture.bin)).toBe(4)
    expect(fixture.transitions.map(change => [change.previous, change.current.status])).toEqual([
      ['unknown', 'signedIn'], ['signedIn', 'signedOut'], ['signedOut', 'signedIn'],
    ])

    await fixture.ctx.fiber.dispose()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(300_000)
    await settle()
    expect(statusCalls(fixture.bin)).toBe(4)
    await expect(fixture.service.checkStatus()).rejects.toThrow('provider closed')
  })

  it('runs no periodic check when the interval is 0', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    cleanups.push(() => { vi.useRealTimers() })
    const fixture = await mount({ root: seed(['claude']).root, config: { statusCheckIntervalMs: 0 } })
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(86_400_000)
    await settle()
    expect(statusCalls(fixture.bin)).toBe(0)
    expect((await fixture.service.getState()).accounts[0]!.status).toEqual({ status: 'unknown', checkedAt: null, message: null })
  })

  it('ends a watch when its subscriber aborts', async () => {
    const fixture = await mount()
    const lifetime = new AbortController()
    const stream = fixture.service.watch(lifetime.signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toEqual({ accounts: [], signIn: null })
    const ended = stream.next()
    lifetime.abort()
    expect(await ended).toMatchObject({ done: true })
  })
})

it('defaults the account root to the Harness home and applies documented defaults', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = join(tmpdir(), 'dsh-home-for-ai-account')
  try {
    expect(resolveConfig({})).toEqual({
      root: join(tmpdir(), 'dsh-home-for-ai-account', 'ai-accounts'),
      executables: { claude: 'claude', chatgpt: 'codex' },
      loginTimeoutMs: 900_000,
      commandTimeoutMs: 15_000,
      graceMs: 2_000,
      loginRows: 40,
      loginCols: 200,
      loginTerminalType: 'xterm-256color',
      statusCheckIntervalMs: 300_000,
      statusCheckTimeoutMs: 15_000,
      statusCheckConcurrency: 2,
    })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  expect(() => resolveConfig({ loginTimeoutMs: 10 })).toThrow()
  expect(() => resolveConfig({ loginCols: 10 })).toThrow()
  expect(() => resolveConfig({ loginRows: 0 })).toThrow()
  expect(() => resolveConfig({ loginTerminalType: '' })).toThrow()
  expect(resolveConfig({ loginRows: 24, loginCols: 80, loginTerminalType: 'vt100' })).toMatchObject({
    loginRows: 24, loginCols: 80, loginTerminalType: 'vt100',
  })
})

it('validates the sign-in status check settings and resolves 0 to disabled periodic checks', () => {
  expect(resolveConfig({ root: '/r', statusCheckIntervalMs: 0 }).statusCheckIntervalMs).toBeNull()
  expect(resolveConfig({ root: '/r', statusCheckIntervalMs: 30_000, statusCheckTimeoutMs: 1_000, statusCheckConcurrency: 8 }))
    .toMatchObject({ statusCheckIntervalMs: 30_000, statusCheckTimeoutMs: 1_000, statusCheckConcurrency: 8 })
  for (const invalid of [
    { statusCheckIntervalMs: 29_999 }, { statusCheckIntervalMs: -1 }, { statusCheckIntervalMs: 40_000.5 },
    { statusCheckTimeoutMs: 999 }, { statusCheckTimeoutMs: 120_001 },
    { statusCheckConcurrency: 0 }, { statusCheckConcurrency: 9 }, { statusCheckConcurrency: 1.5 },
  ]) expect(() => resolveConfig({ root: '/r', ...invalid }), JSON.stringify(invalid)).toThrow()
})
