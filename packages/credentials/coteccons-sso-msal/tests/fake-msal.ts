/** MSAL double for Coteccons SSO specs: accounts persist only through the configured cache plugin, and no request reaches Microsoft. */
import {
  TokenCacheContext, type AccountInfo, type AuthenticationResult, type Configuration, type ICachePlugin, type InteractiveRequest,
  type SilentFlowRequest,
} from '@azure/msal-node'
import { vi } from 'vitest'
import type { MsalClient } from '../src/index.ts'

export const TENANT = 'afc21379-100b-463d-8325-cd1686ae94ca'
export const CLIENT = '149471d2-fb7e-4a8c-a4d0-a81b00e36a4b'
export const REDIRECT = 'http://localhost:53123'
export const AUTHORIZE = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?redirect_uri=${encodeURIComponent(REDIRECT)}`

/** @returns one Entra ID account. */
export function account(username: string, name: string | null = 'Nguyen Van A'): AccountInfo {
  return {
    homeAccountId: `${username}.${TENANT}`, environment: 'login.microsoftonline.com', tenantId: TENANT, username,
    localAccountId: username, ...name === null ? {} : { name },
  }
}

/** @returns an authentication result carrying one access token. */
export function result(signedIn: AccountInfo | null, accessToken: string): AuthenticationResult {
  return {
    authority: `https://login.microsoftonline.com/${TENANT}`, uniqueId: 'unique', tenantId: TENANT, scopes: [], account: signedIn,
    idToken: 'id-token', idTokenClaims: {}, accessToken, fromCache: false, expiresOn: null, tokenType: 'Bearer', correlationId: 'c',
  }
}

/** MSAL double: an in-memory account list persisted only through the configured cache plugin. */
export class FakeMsal implements MsalClient {
  accounts: AccountInfo[] = []
  authorizeUrl = AUTHORIZE
  interactive: { request: InteractiveRequest; resolve: (value: AuthenticationResult) => void; reject: (error: unknown) => void } | undefined
  readonly silent = vi.fn<(request: SilentFlowRequest) => Promise<AuthenticationResult>>(
    request => Promise.resolve(result(request.account, `access:${request.scopes.join(' ')}`)),
  )

  constructor(readonly configuration: Configuration) {}

  private plugin(): ICachePlugin {
    const plugin = this.configuration.cache?.cachePlugin
    if (plugin === undefined) throw new Error('fake msal: no cache plugin')
    return plugin
  }

  private context(changed: boolean): TokenCacheContext {
    return new TokenCacheContext({
      deserialize: (text: string) => { this.accounts = (JSON.parse(text) as { accounts: AccountInfo[] }).accounts },
      serialize: () => JSON.stringify({ accounts: this.accounts }),
    }, changed)
  }

  private async read(): Promise<void> { await this.plugin().beforeCacheAccess(this.context(false)) }
  private async write(): Promise<void> { await this.plugin().afterCacheAccess(this.context(true)) }

  async getAllAccounts(): Promise<AccountInfo[]> {
    await this.read()
    return [...this.accounts]
  }

  acquireTokenInteractive(request: InteractiveRequest): Promise<AuthenticationResult> {
    return new Promise((resolve, reject) => {
      this.interactive = { request, resolve, reject }
      void request.openBrowser(this.authorizeUrl)
    })
  }

  async finish(signedIn: AccountInfo | null): Promise<void> {
    await this.read()
    if (signedIn !== null) this.accounts = [...this.accounts, signedIn]
    await this.write()
    this.interactive?.resolve(result(signedIn, 'interactive-token'))
  }

  acquireTokenSilent(request: SilentFlowRequest): Promise<AuthenticationResult> { return this.silent(request) }

  getTokenCache() {
    return {
      removeAccount: async (removed: AccountInfo) => {
        await this.read()
        this.accounts = this.accounts.filter(candidate => candidate.homeAccountId !== removed.homeAccountId)
        await this.write()
      },
    }
  }
}
