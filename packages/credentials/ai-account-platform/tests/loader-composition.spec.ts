/**
 * A sign-in driven through a Loader-booted composition, not a hand-built context: the
 * provider must reach the shipped subprocess runtime's terminal primitive, because a
 * login command that cannot read its terminal never completes.
 */
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { AiAccountsView } from '@deepseek-ai/dsh-ai-account'
import { afterEach, expect, it } from 'vitest'
import PlatformAiAccount from '../src/index.ts'

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-cli.cjs', import.meta.url))
const ROWS = ['@deepseek-ai/dsh-subprocess-local', '@deepseek-ai/dsh-ai-account-platform'] as const

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

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

it.skipIf(process.platform === 'win32')('signs an account in through the Loader-composed provider and stores it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ai-account-loader-'))
  cleanups.push(() =>{  rmSync(root, { recursive: true, force: true }) })
  const bin = join(root, 'bin')
  await mkdir(bin, { recursive: true })
  copyFileSync(FAKE_CLI, join(bin, 'claude'))
  chmodSync(join(bin, 'claude'), 0o755)
  const accounts = join(root, 'ai-accounts')

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: subprocess',
    `  name: ${JSON.stringify(ROWS[0])}`,
    '- id: ai-account',
    `  name: ${JSON.stringify(ROWS[1])}`,
    '  config:',
    `    root: ${JSON.stringify(accounts)}`,
    `    claudeCliPath: ${JSON.stringify(join(bin, 'claude'))}`,
    '    loginTimeoutMs: 30000',
    '    refreshEnabled: false',
    '',
  ].join('\n'))

  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    [ROWS[0], LocalSubprocessRuntime],
    [ROWS[1], PlatformAiAccount],
  ])
  // The custom importer bypasses Node resolution; mirror the package manifests a
  // deployed cordis.yml has beside its declared dependencies.
  await Promise.all([...modules.keys()].map(async (packageName) => {
    const packageDir = join(root, 'node_modules', ...packageName.split('/'))
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({ name: packageName, version: '0.0.0', type: 'module' })}\n`)
  }))
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => modules.has(specifier)
      ? Promise.resolve(modules.get(specifier))
      : Promise.reject(new Error(`unexpected Loader import: ${specifier}`)),
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()

  const service = ctx.get('aiAccount') as PlatformAiAccount
  expect(service).toBeInstanceOf(PlatformAiAccount)
  const started = await service.startSignIn('claude')
  const attempt = started.signIn!.id
  const waiting = await until(service, view => view.signIn?.url !== null)
  expect(waiting.signIn).toMatchObject({ phase: 'waiting-browser', awaitingCode: true })
  await service.submitSignInCode(attempt, 'loader-code')
  const done = await until(service, view => view.signIn?.phase === 'succeeded')

  // The composed provider ran the login on a terminal the code could reach,
  expect(readFileSync(join(bin, 'submitted-code'), 'utf8')).toBe('loader-code')
  // read the identity back from the CLI, and stored the account durably.
  expect(done.accounts).toMatchObject([{ kind: 'claude', email: 'claude-user@example.com', plan: 'max', isDefault: true }])
  const stored: unknown = JSON.parse(readFileSync(join(accounts, 'accounts.json'), 'utf8'))
  expect(stored).toMatchObject({ version: 1, accounts: [{ kind: 'claude', email: 'claude-user@example.com' }] })
  expect(service.defaultHome('claude')).toBe(join(accounts, 'claude', done.accounts[0]!.id))
})
