/** Official-CLI account sign-in, identity, default selection, removal, and persistence against fake executables. */
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { AiAccountId, AiAccountKind, AiAccountSignInId, AiAccountsView } from '@deepseek-ai/dsh-ai-account'
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
  const config: Config = Object.assign({ root, claudeCliPath: join(bin, 'claude'), codexCliPath: join(bin, 'codex') }, options.config)
  await ctx.plugin(PlatformAiAccount, config)
  return { ctx, service: ctx.get('aiAccount') as PlatformAiAccount, bin, root, changes }
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

async function addAccount(fixture: Fixture, kind: AiAccountKind): Promise<AiAccountId> {
  const before = new Set((await fixture.service.getState()).accounts.map(account => account.id))
  const started = await fixture.service.startSignIn(kind)
  const attempt = started.signIn?.id
  await until(fixture.service, view => view.signIn !== null && view.signIn.id === attempt && view.signIn.url !== null
    && (kind === 'claude' || view.signIn.userCode !== null))
  writeFileSync(join(fixture.bin, `${kind === 'claude' ? 'claude' : 'codex'}.approve`), '')
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
    expect(waiting.signIn).toMatchObject({ phase: 'waiting-browser', url: 'https://claude.ai/oauth/authorize?code=true&state=fake', userCode: null })
    writeFileSync(join(fixture.bin, 'claude.approve'), '')
    const done = await until(fixture.service, view => view.signIn?.phase === 'succeeded')
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
    expect(prompted.signIn).toMatchObject({ phase: 'waiting-device-code', url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGHI' })
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
    writeFileSync(join(fixture.bin, 'claude.approve'), '')
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
    writeFileSync(join(fixture.bin, 'claude.approve'), '')
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
    })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  expect(() => resolveConfig({ loginTimeoutMs: 10 })).toThrow()
})
