/**
 * The `coteccons` model route: an OpenAI-compatible Azure OpenAI / Foundry endpoint called with the signed-in
 * Coteccons user's own Entra ID access token (`Authorization: Bearer`), so Azure RBAC authorizes each user and no
 * API key exists. The token comes from `ctx.cotecconsSso` at every model request.
 *
 * ```yaml
 * - id: llm-coteccons-sso
 *   name: '@deepseek-ai/dsh-llm-coteccons-sso'
 *   config:
 *     baseURL: https://ctd-opus-resource.openai.azure.com/openai/v1
 *     models:
 *       - id: DeepSeek-V4-Pro
 *         contextWindow: 131072
 *         reasoningEfforts: false
 *       - id: gpt-5.6-terra
 * ```
 *
 * @module @deepseek-ai/dsh-llm-coteccons-sso
 */
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import { CotecconsSsoTokenUnavailableError, type CotecconsSsoTokenUnavailableReason } from '@deepseek-ai/dsh-coteccons-sso'
import { PiAiAdapter, PiAiModelProfileSchema, resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiModelProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { TOKEN_ONLY_AUTH } from './auth.ts'

export const name = 'llm-coteccons-sso'
export const inject = ['llm']

/** Harness route key of the Coteccons models. */
export const PROVIDER = 'coteccons'

/** HTTPS endpoints, or plain HTTP only to a loopback address, because every request carries a user's bearer token. */
const ENDPOINT = /^(?:https:\/\/[^\s/?#]+|http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?)(?:\/[^\s?#]*)?$/

/** Deployment choices for the endpoint and its model catalog. */
export interface Config {
  /** Name shown in model selectors. */
  displayName?: string
  /** OpenAI-compatible v1 endpoint of the Azure OpenAI or Foundry resource. */
  baseURL?: string
  /** Deployments served on the endpoint; each `id` is sent as the request's `model`. */
  models?: PiAiModelProfile[]
}

/** Deployment choices with every default applied. */
type ValidConfig = Required<Config>

/** Validated deployment choices with every default applied. */
export const Config: z<Config, ValidConfig> = z.object({
  displayName: z.string().min(1).default('Coteccons'),
  baseURL: z.string().pattern(ENDPOINT).default('https://ctd-opus-resource.openai.azure.com/openai/v1'),
  models: z.array(PiAiModelProfileSchema).default([
    { id: 'DeepSeek-V4-Pro', contextWindow: 131_072, reasoningEfforts: false },
    { id: 'gpt-5.6-terra' },
  ]),
})

const SIGN_IN: Readonly<Record<CotecconsSsoTokenUnavailableReason, string>> = {
  'not-configured': 'Coteccons SSO is not configured: set tenantId and clientId on the coteccons-sso composition row, then sign in with Coteccons SSO in Settings → AI Account.',
  'signed-out': 'Sign in with Coteccons SSO in Settings → AI Account to use the Coteccons models.',
  'session-expired': 'Your Coteccons SSO sign-in expired. Sign in with Coteccons SSO in Settings → AI Account again.',
}

/**
 * Register the `coteccons` route. Its models are listed whether or not anyone is signed in; a request while
 * signed out fails with `LlmError` code `MISSING_CREDENTIAL` naming where to sign in.
 * @param ctx - plugin context with the LLM registry.
 * @param config - endpoint and model catalog.
 * @throws when the model catalog is invalid.
 */
export function apply(ctx: Context, config: ValidConfig): void {
  const profiles = resolveProfiles({
    [PROVIDER]: { displayName: config.displayName, api: 'openai-completions', baseURL: config.baseURL, models: config.models },
  })
  const resolveApiKey = async (): Promise<string> => {
    const sso = ctx.get('cotecconsSso')
    if (sso === undefined) throw new LlmError(SIGN_IN['not-configured'], 'MISSING_CREDENTIAL')
    try {
      return await sso.getAccessToken(sso.aiScope)
    } catch (error) {
      if (error instanceof CotecconsSsoTokenUnavailableError) throw new LlmError(SIGN_IN[error.reason], 'MISSING_CREDENTIAL', { cause: error })
      throw error
    }
  }
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey,
    auth: TOKEN_ONLY_AUTH,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: config.displayName, settingsNs: ctx.fiber.entry?.options.id ?? name, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)
}
