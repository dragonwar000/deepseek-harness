/** The shipped Coteccons rows booted through the Loader: signed out the route fails clearly; signed in it sends the user's Bearer token. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import { mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import LlmRuntime, { type FinishReason } from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import MsalCotecconsSso, { type Config as SsoConfig } from '@deepseek-ai/dsh-coteccons-sso-msal'
import { AUTHORIZE, CLIENT, FakeMsal, TENANT, account } from '../../../credentials/coteccons-sso-msal/tests/fake-msal.ts'
import { closeMockServers, mockServer, textEvents } from '../../llm-pi-ai/tests/mock-server.ts'
import * as Route from '../src/index.ts'

let root: string | undefined
let context: Context | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await closeMockServers()
})

async function boot(baseURL: string) {
  root = await mkdtemp(join(tmpdir(), 'dsh-coteccons-composition-'))
  const credentialsPath = join(root, '.credentials.yaml')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(credentialsPath)}`,
    '    watch: false',
    '- id: coteccons-sso',
    "  name: '@deepseek-ai/dsh-coteccons-sso-msal'",
    '  config:',
    `    tenantId: ${TENANT}`,
    `    clientId: ${CLIENT}`,
    '- id: llm-coteccons-sso',
    "  name: '@deepseek-ai/dsh-llm-coteccons-sso'",
    '  config:',
    `    baseURL: ${baseURL}`,
    '',
  ].join('\n'))
  const clients: FakeMsal[] = []
  // Microsoft Entra ID is the only external service; the MSAL client is replaced, every Harness plugin is real.
  class ComposedSso extends MsalCotecconsSso {
    constructor(scope: Context, config: SsoConfig) {
      super(scope, config, {
        createClient: (configuration) => { const client = new FakeMsal(configuration); clients.push(client); return client },
        openBrowser: () => Promise.resolve(),
      })
    }
  }
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-coteccons-sso-msal', ComposedSso],
    ['@deepseek-ai/dsh-llm-coteccons-sso', Route],
  ])
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  await mountRootInclude(ctx, configPath)
  await ctx.loader.await()
  return { ctx, clients, credentialsPath }
}

async function finish(ctx: Context): Promise<FinishReason | undefined> {
  let reason: FinishReason | undefined
  const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }]
  for await (const chunk of ctx.llm.stream({ provider: 'coteccons', model: 'DeepSeek-V4-Pro', messages })) {
    if (chunk.type === 'finish') reason = chunk.reason
  }
  return reason
}

it('refuses requests while signed out and authorizes them with the signed-in user token', async () => {
  const server = await mockServer([{ events: textEvents }])
  const { ctx, clients, credentialsPath } = await boot(`${server.url}/openai/v1`)
  expect((await ctx.llm.listModels('coteccons')).map(model => model.id)).toEqual(['DeepSeek-V4-Pro', 'gpt-5.6-terra'])
  expect(await finish(ctx)).toEqual({ kind: 'error', failure: expect.objectContaining({
    code: 'MISSING_CREDENTIAL', message: 'Sign in with Coteccons SSO in Settings → AI Account to use the Coteccons models.',
  }) as object })
  expect(server.headers).toEqual([])

  await ctx.cotecconsSso.startSignIn()
  await vi.waitFor(async () => { expect(await ctx.cotecconsSso.getState()).toMatchObject({ status: 'signing-in', url: AUTHORIZE }) })
  await clients.at(-1)?.finish(account('a.nguyen@coteccons.vn'))
  await vi.waitFor(async () => { expect((await ctx.cotecconsSso.getState()).status).toBe('signed-in') })
  expect(await readFile(credentialsPath, 'utf8')).toContain('coteccons-sso/token-cache')

  expect(await finish(ctx)).toEqual({ kind: 'stop' })
  expect(server.headers[0]?.authorization).toBe('Bearer access:https://cognitiveservices.azure.com/.default')
  expect(server.paths).toEqual(['/openai/v1/chat/completions'])
}, 30_000)
