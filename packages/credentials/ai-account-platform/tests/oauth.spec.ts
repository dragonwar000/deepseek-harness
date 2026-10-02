/** Vendor refresh encoding, token rotation, and credential-free failures. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OAuthAuthorizationRequired, readOAuthDocument, refreshOAuthDocument } from '../src/oauth.ts'

afterEach(() => { vi.unstubAllGlobals() })
const signal = (): AbortSignal => new AbortController().signal
const claude = JSON.stringify({ owner: 'kept', claudeAiOauth: {
  accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1, subscriptionType: 'max', scopes: ['old'],
} })
const codex = JSON.stringify({ auth_mode: 'chatgpt', owner: 'kept', tokens: {
  access_token: 'opaque-access', refresh_token: 'old-refresh', id_token: 'old-id', account_id: 'account-kept',
}, last_refresh: '2026-01-01T00:00:00.000Z' })

describe('CLI OAuth documents', () => {
  it('keeps Claude metadata while replacing rotated tokens, expiry and scope', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: 'user:inference user:profile' }))
    vi.stubGlobal('fetch', fetch)
    const before = Date.now()
    const next: unknown = JSON.parse(await refreshOAuthDocument('claude', readOAuthDocument('claude', claude)!, signal()))
    expect(next).toMatchObject({ owner: 'kept', claudeAiOauth: {
      accessToken: 'new-access', refreshToken: 'new-refresh', subscriptionType: 'max', scopes: ['user:inference', 'user:profile'],
    } })
    expect(readOAuthDocument('claude', JSON.stringify(next))!.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://platform.claude.com/v1/oauth/token')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    expect(new URLSearchParams(init!.body as string).get('refresh_token')).toBe('old-refresh')
  })

  it('keeps Codex identity and account id and sends its JSON refresh grant', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', id_token: 'new-id' }))
    vi.stubGlobal('fetch', fetch)
    const next: unknown = JSON.parse(await refreshOAuthDocument('chatgpt', readOAuthDocument('chatgpt', codex)!, signal()))
    expect(next).toMatchObject({ auth_mode: 'chatgpt', owner: 'kept', tokens: {
      access_token: 'new-access', refresh_token: 'new-refresh', id_token: 'new-id', account_id: 'account-kept',
    } })
    expect(fetch.mock.calls[0]).toEqual(['https://auth.openai.com/oauth/token', expect.objectContaining({
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'old-refresh', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' }),
    })])
  })

  it('preserves tokens and fields omitted by a refresh response', () => {
    const next = readOAuthDocument('chatgpt', codex)!.replace({ access_token: 'new' }, 0)
    expect(JSON.parse(next)).toMatchObject({ tokens: { refresh_token: 'old-refresh', id_token: 'old-id' }, last_refresh: '1970-01-01T00:00:00.000Z' })
    expect(JSON.parse(readOAuthDocument('claude', claude)!.replace({ access_token: 'new', expires_in: 60 }, 0)))
      .toMatchObject({ claudeAiOauth: { refreshToken: 'old-refresh', scopes: ['old'], expiresAt: 60_000 } })
  })

  it('reads JWT expiration and uses the Codex refresh-age rule for opaque access tokens', () => {
    const access_token = `header.${Buffer.from(JSON.stringify({ exp: 100 })).toString('base64url')}.signature`
    expect(readOAuthDocument('chatgpt', JSON.stringify({ tokens: { access_token, refresh_token: 'refresh' } }))!.expiresAt).toBe(100_000)
    expect(readOAuthDocument('chatgpt', codex)!.expiresAt).toBe(Date.parse('2026-01-01') + 8 * 86_400_000)
    expect(readOAuthDocument('chatgpt', JSON.stringify({ tokens: { access_token: 'opaque', refresh_token: 'refresh' }, last_refresh: 'invalid' }))!.expiresAt).toBeUndefined()
  })

  it('leaves API-key and non-refreshable token documents to their CLI', () => {
    expect(readOAuthDocument('claude', '{}')).toBeUndefined()
    expect(readOAuthDocument('chatgpt', '{"OPENAI_API_KEY":"key"}')).toBeUndefined()
    expect(() => readOAuthDocument('claude', 'secret invalid json')).toThrow('Invalid CLI credential JSON')
    expect(() => readOAuthDocument('claude', claude)!.replace({ access_token: 'new' }, 0)).toThrow('omitted the token lifetime')
  })

  it.each([400, 401, 403])('reports an authorization rejection at HTTP %s without echoing the body', async (status) => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => new Response('secret error body', { status })))
    await expect(refreshOAuthDocument('claude', readOAuthDocument('claude', claude)!, signal())).rejects.toBeInstanceOf(OAuthAuthorizationRequired)
  })

  it.each([429, 500])('leaves HTTP %s failures retryable', async (status) => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => new Response('secret error body', { status })))
    await expect(refreshOAuthDocument('chatgpt', readOAuthDocument('chatgpt', codex)!, signal())).rejects.toThrow(`HTTP ${status}`)
  })

  it.each(['not json', '{}', '{"access_token":""}'])('refuses an invalid refresh response without exposing it', async (body) => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => new Response(body)))
    await expect(refreshOAuthDocument('claude', readOAuthDocument('claude', claude)!, signal())).rejects.toThrow(/invalid/)
  })

  it('sanitizes fetch failures and honors cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => { throw new Error('old-refresh secret failure') }))
    await expect(refreshOAuthDocument('claude', readOAuthDocument('claude', claude)!, signal())).rejects.toThrow('could not be reached')
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(refreshOAuthDocument('claude', readOAuthDocument('claude', claude)!, controller.signal)).rejects.toThrow('cancelled')
  })
})
