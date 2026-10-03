/**
 * MSAL token cache persisted as one grant record in the Harness credential store. The serialized cache holds
 * refresh, access, and ID tokens, so it is written only through `ctx.credentials` and never to a plain file or a log.
 */
import type { ICachePlugin, TokenCacheContext } from '@azure/msal-node'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'

/** Grant payload owned by this provider. A record written for another app registration or authority is ignored. */
export interface TokenCachePayload {
  readonly version: 1
  /** Application (client) id whose tokens the cache holds. */
  readonly clientId: string
  /** Authority the tokens were issued by. */
  readonly authority: string
  /** MSAL's serialized cache JSON. */
  readonly cache: string
}

/** App registration a stored cache must belong to. */
export interface TokenCacheOwner {
  readonly clientId: string
  readonly authority: string
}

/**
 * Read the cache JSON stored for one app registration.
 * @param record - stored credential record, if any.
 * @param owner - app registration the cache must belong to.
 * @returns the serialized cache, or `undefined` when nothing usable is stored.
 */
export function storedCache(record: CredentialRecord | undefined, owner: TokenCacheOwner): string | undefined {
  if (record?.kind !== 'grant') return undefined
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null) return undefined
  const { version, clientId, authority, cache } = payload as Partial<Record<keyof TokenCachePayload, unknown>>
  if (version !== 1 || clientId !== owner.clientId || authority !== owner.authority || typeof cache !== 'string') return undefined
  return cache
}

/**
 * Build the MSAL cache plugin over one credential record.
 * @param credentials - Harness credential store.
 * @param key - record holding the cache.
 * @param owner - app registration the cache belongs to.
 * @param onWriteFailure - receives a failed store write; the in-memory cache keeps serving this process.
 * @returns the plugin MSAL calls around every cache access.
 */
export function credentialCachePlugin(
  credentials: CredentialProvider,
  key: CredentialKey,
  owner: TokenCacheOwner,
  onWriteFailure: (error: unknown) => void,
): ICachePlugin {
  return {
    async beforeCacheAccess(context: TokenCacheContext) {
      const cache = storedCache(await credentials.readRecord(key), owner)
      if (cache !== undefined) context.tokenCache.deserialize(cache)
    },
    async afterCacheAccess(context: TokenCacheContext) {
      if (!context.cacheHasChanged) return
      const payload: TokenCachePayload = { version: 1, ...owner, cache: context.tokenCache.serialize() }
      try {
        await credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload }))
      } catch (error) {
        onWriteFailure(error)
      }
    },
  }
}
