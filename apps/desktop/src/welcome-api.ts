/** Operations available to the isolated native welcome renderer. */

import type { CotecconsSsoSignInId, CotecconsSsoView } from '@deepseek-ai/dsh-coteccons-sso/types'
import type { ProductEventMap } from '@deepseek-ai/dsh-client-product-analytics/types'
import type { DesktopLocale } from './locale.ts'

/** Private native welcome channels, installed only while its window exists. */
export const WELCOME_IPC = {
  saveApiKey: 'dsh-welcome:save-api-key',
  analytics: 'dsh-welcome:analytics',
  analyticsEnabled: 'dsh-welcome:analytics-enabled',
  skip: 'dsh-welcome:skip',
  start: 'dsh-welcome:start',
  cancel: 'dsh-welcome:cancel',
  copyLink: 'dsh-welcome:copy-link',
  state: 'dsh-welcome:state',
  takeNotice: 'dsh-welcome:take-notice',
  providers: 'dsh-welcome:providers',
} as const

/** Credential writes return a safe outcome without exposing Host diagnostics. */
export type WelcomeSaveResult = { readonly ok: true } | { readonly ok: false }

/** One-time notification retained by the main process until Welcome receives it: the Coteccons SSO sign-in expired. */
export type WelcomeNotice = 'session-expired'

type WelcomeEventName = 'auth_page_view' | 'auth_page_click' | 'api_key_save_click'
/**
 * A writable provider identity the welcome page can offer in the provider selector.
 * The `settingsNs` is passed back to `saveApiKey` to target the right credential.
 */
export interface WritableProvider {
  /** Settings namespace used to write the key (e.g. `llm-deepseek`, `llm-pi-ai`). */
  readonly settingsNs: string
  /** Human-readable name shown in the provider dropdown. */
  readonly displayName: string
}

/** Host-owned operations used by the welcome window. */
export interface WelcomeOperations {
  /** @param eventName - allowed welcome event. @param attributes - approved fields without credentials. */
  analytics?<K extends WelcomeEventName>(eventName: K, attributes: ProductEventMap[K]): Promise<void>
  /** @returns the Host's current effective collection policy. */
  analyticsEnabled(): Promise<boolean>
  /** @returns the pending notification, clearing it before another renderer can receive it. */
  takeNotice(): Promise<WelcomeNotice | undefined>
  /** @returns Coteccons SSO state after starting a browser sign-in. */
  startSignIn(): Promise<CotecconsSsoView>
  /** @param id - attempt to cancel. @returns the settled state. */
  cancelSignIn(id: CotecconsSsoSignInId): Promise<CotecconsSsoView>
  /** @param id - current attempt whose Microsoft sign-in URL is copied to the system clipboard. */
  copySignInLink(id: CotecconsSsoSignInId): Promise<void>

  /**
   * Store a provider's API key before entering the workspace.
   * @param settingsNs - Provider settings namespace (e.g. `llm-deepseek`, `llm-pi-ai`).
   * @param value - Validated, trimmed API key.
   * @returns whether the write completed, without private error details.
   */
  saveApiKey(settingsNs: string, value: string): Promise<WelcomeSaveResult>
  /**
   * Enter the workspace without writing an onboarding-completion setting.
   * @returns completion after the workspace opens.
   */
  skip(): Promise<void>
  /** @returns writable provider settings namespaces known at this launch. */
  getWritableProviders(): Promise<readonly string[]>
}

/** The renderer receives localized copy, sign-in operations, and token-free Coteccons SSO snapshots. */
export type WelcomeApi = DesktopLocale & WelcomeOperations & {
  /** @param listener - token-free Coteccons SSO snapshot recipient. @returns subscription disposer. */
  onSsoState(listener: (state: CotecconsSsoView) => void): () => void
}

/** Authentication facts supplied at cold start or after a completed sign-out. */
export interface WelcomeAuthentication {
  /** Whether a Coteccons SSO account is signed in. */
  readonly loggedIn: boolean
  readonly hasApiKey: boolean
  /** Provider namespaces with writable credentials, sorted for display. */
  readonly writableProviders: readonly string[]
}

/**
 * Decide whether a startup or sign-out requires the welcome entry.
 * @param authentication - current account and independently stored API-key facts.
 * @returns true only when neither authentication route is configured.
 */
export function needsWelcome(authentication: WelcomeAuthentication): boolean {
  return !authentication.loggedIn && !authentication.hasApiKey
}
