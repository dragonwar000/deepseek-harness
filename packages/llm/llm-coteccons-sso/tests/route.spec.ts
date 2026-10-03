/** The `coteccons` route lists its models, sends the SSO token as a Bearer credential, and fails clearly while signed out. */
import { Context, Service } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits, ImageAttachmentRef, ImageRequestTarget, RequestImageAttachment, SaveImageAttachment, StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { FinishReason } from '@deepseek-ai/dsh-llm'
import { CotecconsSsoTokenUnavailableError, type CotecconsSso } from '@deepseek-ai/dsh-coteccons-sso'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeMockServers, mockServer, textEvents } from '../../llm-pi-ai/tests/mock-server.ts'
import * as Route from '../src/index.ts'
import { TOKEN_ONLY_AUTH } from '../src/auth.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await closeMockServers()
})

async function mount(config: Route.Config = {}, sso?: Pick<CotecconsSso, 'aiScope' | 'getAccessToken'>) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  if (sso !== undefined) ctx.provide('cotecconsSso', sso as CotecconsSso)
  await ctx.plugin(Route, config)
  return ctx
}

async function finish(ctx: Context, model = 'DeepSeek-V4-Pro'): Promise<FinishReason | undefined> {
  let reason: FinishReason | undefined
  const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }]
  for await (const chunk of ctx.llm.stream({ provider: Route.PROVIDER, model, messages })) {
    if (chunk.type === 'finish') reason = chunk.reason
  }
  return reason
}

describe('llm-coteccons-sso', () => {
  it('lists the default Coteccons models whether or not anyone is signed in', async () => {
    const ctx = await mount()
    expect(ctx.llm.listProviders().map(provider => [provider.id, provider.name])).toEqual([['coteccons', 'Coteccons']])
    expect((await ctx.llm.listModels('coteccons')).map(model => model.id)).toEqual(['DeepSeek-V4-Pro', 'gpt-5.6-terra'])
    const pro = await ctx.llm.resolveModelInfo('coteccons', 'DeepSeek-V4-Pro')
    expect(pro.context?.contextWindow).toBe(131_072)
    expect(pro.reasoning).toBeUndefined()
    expect(ctx.llm.listConfigurableProviders()).toEqual([
      expect.objectContaining({ provider: 'coteccons', displayName: 'Coteccons', settingsNs: 'llm-coteccons-sso', settingsPath: [] }),
    ])
    expect(Route.Config({}).baseURL).toBe('https://ctd-opus-resource.openai.azure.com/openai/v1')
  })

  it('sends the signed-in user token as a Bearer credential to the configured endpoint', async () => {
    const server = await mockServer([{ events: textEvents }])
    const getAccessToken = vi.fn<CotecconsSso['getAccessToken']>().mockResolvedValue('entra-access-token')
    const ctx = await mount(
      { baseURL: `${server.url}/openai/v1`, models: [{ id: 'gpt-5.6-terra' }] },
      { aiScope: 'https://cognitiveservices.azure.com/.default', getAccessToken },
    )
    expect(await finish(ctx, 'gpt-5.6-terra')).toEqual({ kind: 'stop' })
    expect(getAccessToken).toHaveBeenCalledExactlyOnceWith('https://cognitiveservices.azure.com/.default')
    expect(server.paths).toEqual(['/openai/v1/chat/completions'])
    expect(server.headers[0]?.authorization).toBe('Bearer entra-access-token')
    expect(server.headers[0]?.['api-key']).toBeUndefined()
    expect(server.requests[0]).toMatchObject({ model: 'gpt-5.6-terra' })
  })

  it.each([
    ['signed-out', 'Sign in with Coteccons SSO in Settings → AI Account to use the Coteccons models.'],
    ['session-expired', 'Your Coteccons SSO sign-in expired. Sign in with Coteccons SSO in Settings → AI Account again.'],
    ['not-configured', 'Coteccons SSO is not configured: set tenantId and clientId on the coteccons-sso composition row, then sign in with Coteccons SSO in Settings → AI Account.'],
  ] as const)('fails with MISSING_CREDENTIAL while %s', async (reason, message) => {
    const ctx = await mount({}, {
      aiScope: 'scope',
      getAccessToken: () => Promise.reject(new CotecconsSsoTokenUnavailableError(reason)),
    })
    expect(await finish(ctx)).toEqual({ kind: 'error', failure: expect.objectContaining({ code: 'MISSING_CREDENTIAL', message }) as object })
  })

  it('fails with MISSING_CREDENTIAL without the SSO service and passes other token failures through', async () => {
    const bare = await mount()
    expect(await finish(bare)).toEqual({ kind: 'error', failure: expect.objectContaining({ code: 'MISSING_CREDENTIAL' }) as object })
    const broken = await mount({}, { aiScope: 'scope', getAccessToken: () => Promise.reject(new Error('token endpoint unreachable')) })
    const reason = await finish(broken)
    expect(reason).toMatchObject({ kind: 'error', failure: { message: expect.stringContaining('token endpoint unreachable') as string } })
    expect(reason).not.toMatchObject({ failure: { code: 'MISSING_CREDENTIAL' } })
  })

  it('refuses an insecure endpoint and an invalid catalog at load', async () => {
    expect(() => Route.Config({ baseURL: 'http://ctd-opus-resource.openai.azure.com/openai/v1' })).toThrow()
    expect(Route.Config({ baseURL: 'http://127.0.0.1:8080/v1' }).baseURL).toBe('http://127.0.0.1:8080/v1')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    const fiber = ctx.plugin(Route, { models: [{ id: 'bad', contextWindow: 0 }] })
    await expect(fiber).rejects.toThrow()
  })

  it('answers nothing from pi-ai stored or ambient auth', async () => {
    const { credentials, authContext } = TOKEN_ONLY_AUTH
    expect(await credentials.read('coteccons')).toBeUndefined()
    expect(await credentials.list()).toEqual([])
    expect(await credentials.modify('coteccons', current => Promise.resolve(current))).toBeUndefined()
    await expect(credentials.delete('coteccons')).resolves.toBeUndefined()
    expect(await authContext.env('OPENAI_API_KEY')).toBeUndefined()
    expect(await authContext.fileExists('~/.azure')).toBe(false)
  })

  it('sends image attachments through the model-visible filesystem path', async () => {
    const server = await mockServer([{ status: 401, body: JSON.stringify({ error: { message: 'expected mock failure' } }) }])
    const ref: ImageAttachmentRef = { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', bytes: 1, width: 1, height: 1 }
    class Attachments extends AttachmentStore {
      readonly imageLimits: ImageAttachmentLimits = {
        maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1, maxImagePixels: 1, maxImageDimension: 2000, mediaTypes: ['image/png'],
      }

      validateImage(_input: SaveImageAttachment): Promise<void> { return Promise.reject(new Error('not used')) }
      saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> { return Promise.reject(new Error('not used')) }
      readImage(value: ImageAttachmentRef): Promise<StoredImageAttachment> {
        return Promise.resolve({ ref: value, data: Uint8Array.of(1) })
      }
      override imageHostPath(_ref: ImageAttachmentRef): string { return '/host/image' }
      override readImageRequest(value: ImageAttachmentRef, _target: ImageRequestTarget): Promise<RequestImageAttachment> {
        return Promise.resolve({
          variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`), attachment: value, data: Uint8Array.of(1), mediaType: value.mediaType,
          bytes: 1, width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: true,
        })
      }
    }
    class MappedFileSystem extends Service {
      constructor(ctx: Context) { super(ctx, 'fs') }
      processPathFromHostPath(hostPath: string): string | undefined { return hostPath === '/host/image' ? '/model/image' : undefined }
    }
    const ctx = await mount(
      { baseURL: `${server.url}/v1`, models: [{ id: 'vision', input: ['text', 'image'] }] },
      { aiScope: 'scope', getAccessToken: () => Promise.resolve('token') },
    )
    await ctx.plugin(Attachments)
    await ctx.plugin(MappedFileSystem)
    let reason: FinishReason | undefined
    const messages = [{ role: 'user' as const, content: [{ type: 'image' as const, attachment: ref }] }]
    for await (const chunk of ctx.llm.stream({ provider: Route.PROVIDER, model: 'vision', messages })) {
      if (chunk.type === 'finish') reason = chunk.reason
    }
    expect(reason?.kind).toBe('error')
    expect(JSON.stringify(server.requests[0])).toContain('/model/image')
  })
})
