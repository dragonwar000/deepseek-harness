/** Refreshes the vendor CLI's OAuth document while retaining fields owned by that CLI. */
import { z } from 'zod'
import type { AiAccountKind } from '@deepseek-ai/dsh-ai-account'

const ENDPOINTS = {
  claude: { url: 'https://platform.claude.com/v1/oauth/token', client: '9d1c250a-e61b-44d9-88ed-5944d1962f5e' },
  chatgpt: { url: 'https://auth.openai.com/oauth/token', client: 'app_EMoamEEZ73f0CkXaXp7hrann' },
}
const token = z.string().min(1)
const claudeDocument = z.looseObject({
  claudeAiOauth: z.looseObject({ accessToken: token, refreshToken: token, expiresAt: z.number().finite().optional() }),
})
const codexDocument = z.looseObject({
  tokens: z.looseObject({ access_token: token, refresh_token: token, id_token: token.optional() }),
  last_refresh: z.string().optional(),
})
const response = z.object({
  access_token: token,
  refresh_token: token.optional(),
  id_token: token.optional(),
  expires_in: z.number().finite().positive().optional(),
  scope: z.string().optional(),
})

/** An OAuth rejection that requires user authorization again; contains no response body or tokens. */
export class OAuthAuthorizationRequired extends Error {
  constructor() { super('The account authorization expired or was revoked. Sign in again.') }
}

/** Validated CLI credential document and its refresh decision. */
export interface OAuthDocument {
  readonly refreshToken: string
  readonly expiresAt: number | undefined
  /** Retains the complete CLI document and replaces only returned token fields. */
  replace(value: z.infer<typeof response>, now: number): string
}

/**
 * Read refreshable subscription credentials from a CLI document.
 * @param kind - product that owns the document.
 * @param text - credential JSON read from the account's own storage.
 * @returns the validated OAuth data, or `undefined` for another authentication mode.
 * @throws for invalid JSON; messages never contain the credential document.
 */
export function readOAuthDocument(kind: AiAccountKind, text: string): OAuthDocument | undefined {
  let raw: unknown
  try { raw = JSON.parse(text) } catch (_invalidJson) { throw new Error('Invalid CLI credential JSON') }
  if (kind === 'claude') {
    const parsed = claudeDocument.safeParse(raw)
    if (!parsed.success) return undefined
    const document = parsed.data
    return {
      refreshToken: document.claudeAiOauth.refreshToken,
      expiresAt: document.claudeAiOauth.expiresAt,
      replace(value, now) {
        if (value.expires_in === undefined) throw new Error('OAuth refresh response omitted the token lifetime')
        return JSON.stringify({ ...document, claudeAiOauth: {
          ...document.claudeAiOauth,
          accessToken: value.access_token,
          refreshToken: value.refresh_token ?? document.claudeAiOauth.refreshToken,
          expiresAt: now + value.expires_in * 1_000,
          ...value.scope === undefined ? {} : { scopes: value.scope.split(' ').filter(Boolean) },
        } })
      },
    }
  }
  const parsed = codexDocument.safeParse(raw)
  if (!parsed.success) return undefined
  const document = parsed.data
  let expiresAt: number | undefined
  try {
    const payload: unknown = JSON.parse(Buffer.from(document.tokens.access_token.split('.')[1] ?? '', 'base64url').toString('utf8'))
    const claims = z.object({ exp: z.number().finite().positive() }).safeParse(payload)
    if (claims.success) expiresAt = claims.data.exp * 1_000
  } catch (_opaqueAccessToken) {
    // Codex also supports opaque access tokens; their refresh age comes from last_refresh.
  }
  if (expiresAt === undefined && document.last_refresh !== undefined) {
    const refreshed = Date.parse(document.last_refresh)
    if (Number.isFinite(refreshed)) expiresAt = refreshed + 8 * 86_400_000
  }
  return {
    refreshToken: document.tokens.refresh_token,
    expiresAt,
    replace(value, now) {
      return JSON.stringify({ ...document, tokens: {
        ...document.tokens,
        access_token: value.access_token,
        refresh_token: value.refresh_token ?? document.tokens.refresh_token,
        ...value.id_token === undefined ? {} : { id_token: value.id_token },
      }, last_refresh: new Date(now).toISOString() })
    },
  }
}

/**
 * Exchange a registered account's refresh token using its CLI's OAuth protocol.
 * @param kind - subscription product.
 * @param document - validated credential document to update.
 * @param signal - request deadline and provider lifetime.
 * @returns the complete replacement CLI credential JSON.
 * @throws {@link OAuthAuthorizationRequired} for a rejected grant; other failures remain retryable.
 */
export async function refreshOAuthDocument(kind: AiAccountKind, document: OAuthDocument, signal: AbortSignal): Promise<string> {
  const endpoint = ENDPOINTS[kind]
  const fields = { grant_type: 'refresh_token', refresh_token: document.refreshToken, client_id: endpoint.client }
  let result: Response
  try {
    result = await fetch(endpoint.url, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': kind === 'claude' ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: kind === 'claude' ? new URLSearchParams(fields).toString() : JSON.stringify(fields),
    })
  } catch (_requestFailed) {
    signal.throwIfAborted()
    throw new Error('OAuth token endpoint could not be reached')
  }
  if (!result.ok) {
    await result.body?.cancel()
    if (result.status === 400 || result.status === 401 || result.status === 403) throw new OAuthAuthorizationRequired()
    throw new Error(`OAuth token endpoint returned HTTP ${result.status}`)
  }
  let raw: unknown
  try { raw = await result.json() } catch (_invalidJson) { throw new Error('OAuth token endpoint returned invalid JSON') }
  const parsed = response.safeParse(raw)
  if (!parsed.success) throw new Error('OAuth token endpoint returned invalid token fields')
  signal.throwIfAborted()
  return document.replace(parsed.data, Date.now())
}
