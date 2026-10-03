/**
 * Every browser row of the shipped composition, booted as the Host mounts it:
 * one test-only `cordis.yml` per row through the real Loader, with the package's
 * real Node half and no services provided.
 *
 * A `dsh.client` row is mounted twice — its Node half in the Host process and
 * its browser half in the client. Only the browser half may require browser
 * services (`slots`, `locale`, `remote`, …); a Node half that names one waits
 * for a service the Host never provides, so its row stays PENDING forever. The
 * application reports that as a startup warning and keeps running, and no gate
 * reads the warning, so {@link HOST_FACING_ROWS} is where an unwired row is
 * caught: a row absent from the table must activate on a service-less Host.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { Context, type FiberState } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import { mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import { bundleRoster, WEB_PROFILE_BUNDLES } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/bundle-roster.ts'

/** Cordis reports an activated fiber as this state; app-boot's startup audit treats every other state as inactive. */
const ACTIVE = 2 as FiberState.ACTIVE

/** The web-app bundle manifest the roster resolves its layers and plugin packages from. */
const ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/**
 * Browser rows whose Node half serves the Host, and the Host services each one
 * requires. Every service here must be provided by another row of the shipped
 * composition; a browser service in this table is the bug this suite exists for.
 * A row missing from the table must activate with no services at all.
 */
const HOST_FACING_ROWS: Readonly<Record<string, readonly string[]>> = {
  '@deepseek-ai/dsh-api-gateway': ['typert'],
  '@deepseek-ai/dsh-api-job-controller': ['jobs', 'typert'],
  '@deepseek-ai/dsh-api-remotes': ['typertGateway'],
  '@deepseek-ai/dsh-api-session-controller': [
    'agentDefaultModel', 'agents', 'attachments', 'fileUploads', 'fs', 'llm',
    'sessions', 'sessionProjections', 'sessionQuery', 'typert', 'workspaceRegistry',
  ],
  '@deepseek-ai/dsh-api-terminal-controller': ['subprocess', 'sandboxPolicy', 'typert'],
  '@deepseek-ai/dsh-api-workspace-controller': ['typert', 'workspaceRegistry'],
  '@deepseek-ai/dsh-api-workspace-files': ['fs', 'sandboxPolicy', 'sessions', 'typert'],
  '@deepseek-ai/dsh-client-connection': ['credentials'],
  '@deepseek-ai/dsh-client-file-upload': ['agents', 'attachments', 'commands', 'connection'],
  '@deepseek-ai/dsh-client-hmr': ['clientModules', 'webServer'],
  // Identity is read through `ctx.get('deepseekAccount')`: CTD Core ships DeepSeek
  // Platform sign-in disabled, so a hard injection would never activate this row.
  '@deepseek-ai/dsh-client-product-analytics': ['productTelemetry'],
  '@deepseek-ai/dsh-client-ui-deliverables': [
    'systemPrompt', 'connection', 'sessionQuery', 'sessionController',
    'workspaceFiles', 'fs', 'sandboxPolicy', 'workspaceChanges',
  ],
  '@deepseek-ai/dsh-session-log-export': ['commands', 'connection'],
}

/** One row's activation outcome on a Host that provides nothing. */
interface Outcome {
  /** Whether the Loader activated the row's Node half. */
  readonly active: boolean
  /** Services the row still waits for, in declaration order. */
  readonly waiting: readonly string[]
}

/**
 * Boot one package's Node half from a test-only `cordis.yml` through the real Loader.
 * @param packageName - the browser row's package, mounted as the Loader entry name.
 * @returns the row's activation state and the services it still waits for.
 */
async function bootRow(packageName: string): Promise<Outcome> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-surface-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, `- id: surface\n  name: ${JSON.stringify(packageName)}\n`)
  const half: unknown = await import(packageName)
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  // The Loader resolves the one entry name to the already-imported Node half; a
  // second specifier would mean the row pulled in a module this boot never declared.
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => specifier === packageName
      ? Promise.resolve(half)
      : Promise.reject(new Error(`unexpected Loader import: ${specifier}`)),
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  await mountRootInclude(ctx, configPath)
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) {
    if (entry.options.name !== packageName) continue
    const fiber = entry.fiber
    if (fiber === undefined) return { active: false, waiting: [] }
    return {
      active: fiber.state === ACTIVE,
      waiting: Object.keys(fiber.inject).filter(service => fiber.ctx.get(service) === undefined),
    }
  }
  throw new Error(`the Loader mounted no entry for ${packageName}`)
}

/**
 * The shipped browser roster of one profile, read from the real bundle patches.
 * @param profile - the `dsh --profile` name the rows' `disabled` expressions see.
 * @returns the package names in composition order.
 */
function roster(profile: string): readonly string[] {
  const services: Readonly<Record<string, object | undefined>> = { profileContext: { name: profile } }
  return bundleRoster(WEB_PROFILE_BUNDLES, ANCHOR, {
    get: (name: string) => services[name],
    process: { platform: process.platform },
  }).rows.map(row => row.name)
}

it.each(['web', 'desktop'])(
  'leaves no browser row of the shipped %s composition waiting for an undeclared service',
  async (profile) => {
    const rows = roster(profile)
    expect(rows.length).toBeGreaterThan(50)
    const waiting: Record<string, readonly string[]> = {}
    const inactive: string[] = []
    for (const packageName of rows) {
      const outcome = await bootRow(packageName)
      if (outcome.waiting.length > 0) waiting[packageName] = outcome.waiting
      else if (!outcome.active) inactive.push(packageName)
    }
    // A row that waits for nothing and still did not activate failed to apply.
    expect(inactive).toEqual([])
    // Exact equality both ways: an unwired row appears with the services it
    // cannot get, and a row that stopped needing the Host leaves the table.
    expect(waiting).toEqual(Object.fromEntries(
      Object.entries(HOST_FACING_ROWS).filter(([name]) => rows.includes(name)),
    ))
  },
  120_000,
)

it('activates the AI Account settings rows, whose browser services belong to their browser halves', async () => {
  for (const packageName of [
    '@deepseek-ai/dsh-client-ui-settings-ai-account',
    '@deepseek-ai/dsh-client-ui-settings-coteccons-sso',
  ]) {
    expect(await bootRow(packageName), packageName).toEqual({ active: true, waiting: [] })
  }
}, 60_000)

it('leaves Desktop analytics waiting only for its telemetry sibling, not for the disabled DeepSeek Platform sign-in', async () => {
  // `desktop-product-telemetry` provides `productTelemetry` beside this row in
  // the shipped Desktop composition; `deepseekAccount` has no enabled provider.
  expect(await bootRow('@deepseek-ai/dsh-client-product-analytics'))
    .toEqual({ active: false, waiting: ['productTelemetry'] })
}, 60_000)
