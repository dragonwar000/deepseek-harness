/**
 * Which stored sign-ins may authenticate this harness's own model requests, and
 * which route set that produces.
 *
 * A sign-in writes one credential record at `llm-pi-ai/<provider id>`. Whether
 * the harness may then send that credential as its own is not a deployment
 * choice: it follows from what the vendor issued. Two kinds are sanctioned —
 * an API key the account holder minted in the vendor's console, and an OAuth
 * grant the vendor issues to third-party clients — because both identify this
 * harness as itself. A consumer subscription grant is not: it is issued to the
 * vendor's own assistant client, and sending it from here would mean claiming
 * to be that client. Those accounts stay reachable only by launching the
 * vendor's product, which is what `dsh-ai-account` does.
 *
 * The classification is derived from the installed catalog rather than listed
 * per provider, so a pi-ai upgrade that adds a subscription login is withheld
 * the moment it lands instead of waiting for someone to notice it.
 *
 * @module dsh-llm-pi-ai/sign-in
 */

import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { catalogProvider, catalogProviderIds } from './catalog.ts'

/** What this harness may do with one stored credential. */
export type SignInClass =
  /** Register a model route it authenticates: the vendor issued it for use by clients like this one. */
  | 'sanctioned'
  /** Never a route here: a consumer subscription grant, usable only by launching the vendor's own client. */
  | 'delegated-only'
  /** Never a route here: no installed provider can turn this stored grant into request auth. */
  | 'unknown-grant'

/**
 * One stored sign-in, classified. `reason` is product copy: a settings surface
 * shows it verbatim to explain an absent model route, so it names what the
 * vendor issued rather than which check rejected it.
 */
export interface SignInClassification {
  /** pi-ai provider id, which is also the harness route key and the record id. */
  readonly provider: string
  /** Which stored record kind this classifies; the two kinds of one provider can differ. */
  readonly credential: CredentialRecord['kind']
  /** What the harness may do with it. */
  readonly signInClass: SignInClass
  /** Why, in terms of what the vendor issued. */
  readonly reason: string
  /**
   * The provider whose API-key sign-in reaches the main model instead. Present
   * only on a classification that yields no route, and only when some
   * installed provider offers that key.
   */
  readonly keyAlternative?: string
}

/**
 * One stored credential, as the record half of the credential seam lists it.
 * Neither field is a secret: this is the whole input the route decision needs.
 */
export interface StoredSignIn {
  /** The record's id half, which is the pi-ai provider id. */
  readonly provider: string
  /** The record's kind, which is what the seam reports without reading a value. */
  readonly credential: CredentialRecord['kind']
}

/** What the route set is resolved from. */
export interface SignInRouteRequest {
  /** Every credential record stored under this plugin's scope. */
  readonly stored: readonly StoredSignIn[]
  /** Whether this deployment lets a sign-in activate a route at all. */
  readonly activateRoutes: boolean
}

/** The route set one {@link SignInRouteRequest} resolves to. */
export interface SignInRouteSpec {
  /**
   * Providers whose stored credential may authenticate a route of their own,
   * in installed-catalog order so the route set does not depend on the order
   * records happen to come back in. A route the settings document declares
   * still appears here; precedence belongs to whoever assembles the route set,
   * because only that caller knows the current profiles.
   */
  readonly activate: readonly string[]
  /**
   * Stored sign-ins this harness will not send as its own, each carrying the
   * reason. A sanctioned credential that merely has no route — the deployment
   * disabled activation, or nothing ships the provider and no profile declares
   * it — is not here: what it lacks is configuration, not permission.
   */
  readonly withheld: readonly SignInClassification[]
}

/**
 * The provider whose API-key sign-in reaches the main model in place of a
 * grant this harness will not send. Only a provider that ships no API-key
 * method of its own needs an entry; for every other one the alternative is its
 * own API-key sign-in, under the same record id, which
 * {@link classifySignIn} finds from the installed catalog.
 *
 * `openai-codex` is the one installed provider in that position: it is the
 * Codex subscription endpoint and offers no key at all, so the key that
 * replaces it belongs to the OpenAI platform route.
 */
export const KEY_SIGN_IN_SUBSTITUTE: Readonly<Record<string, string>> = {
  'openai-codex': 'openai',
}

/**
 * The provider whose API-key sign-in stands in for one withheld grant.
 *
 * Every {@link KEY_SIGN_IN_SUBSTITUTE} value must name an installed provider
 * that ships an API-key method, or this points the account holder at a sign-in
 * the product does not offer. That is checked once against the installed
 * catalog by this module's tests rather than per call, because the map is
 * fixed source and the answer cannot differ between two calls in one build.
 * @param provider - the provider whose grant is withheld.
 * @returns that provider id, a substitute, or `undefined` when no key replaces it.
 */
function keyAlternative(provider: string): string | undefined {
  if (catalogProvider(provider)?.auth.apiKey !== undefined) return provider
  return KEY_SIGN_IN_SUBSTITUTE[provider]
}

/**
 * Classify one stored credential.
 * @param provider - pi-ai provider id, which is the record's id half.
 * @param credential - the stored record's kind.
 * @returns the classification, with the reason a surface may show.
 */
export function classifySignIn(
  provider: string,
  credential: CredentialRecord['kind'],
): SignInClassification {
  switch (credential) {
    case 'api-key':
      return {
        provider,
        credential,
        signInClass: 'sanctioned',
        // An API key names the account it bills and nothing else, so sending
        // it claims only that this harness holds it.
        reason: 'an API key issued to the account holder in the vendor\'s own console',
      }
    case 'grant': {
      const oauth = catalogProvider(provider)?.auth.oauth
      const alternative = keyAlternative(provider)
      const withheld = alternative === undefined ? {} : { keyAlternative: alternative }
      if (oauth === undefined) {
        return {
          provider,
          credential,
          signInClass: 'unknown-grant',
          reason: 'no installed provider defines an OAuth method for this route, so nothing here can'
            + ' derive request auth from the stored grant',
          ...withheld,
        }
      }
      if (oauth.isSubscription === true) {
        return {
          provider,
          credential,
          signInClass: 'delegated-only',
          reason: `a consumer subscription grant (${oauth.name}) issued to the vendor's own assistant client;`
            + ' sending it from here would mean identifying this harness as that client',
          ...withheld,
        }
      }
      return {
        provider,
        credential,
        signInClass: 'sanctioned',
        reason: `an OAuth grant the vendor issues to third-party clients (${oauth.name})`,
      }
    }
    default:
      return assertNever(credential, 'llm-pi-ai stored credential kind')
  }
}

/**
 * Every sign-in the installed catalog offers, classified. This is the whole
 * offer rather than what is stored, which is what makes it the drift gate: a
 * pi-ai upgrade that adds a subscription login changes this table, and the
 * test that pins it says so.
 * @returns one classification per provider and offered credential kind, in installed-catalog order.
 */
export function signInClassifications(): readonly SignInClassification[] {
  const classifications: SignInClassification[] = []
  for (const provider of catalogProviderIds()) {
    const auth = catalogProvider(provider)?.auth
    /* v8 ignore next 3 -- every id here names an installed provider, so the
       lookup cannot miss; the guard keeps a future upstream inconsistency
       between the id list and the provider index from throwing. */
    if (auth === undefined) continue
    if (auth.apiKey?.login !== undefined) classifications.push(classifySignIn(provider, 'api-key'))
    if (auth.oauth !== undefined) classifications.push(classifySignIn(provider, 'grant'))
  }
  return classifications
}

/**
 * Resolve which stored sign-ins may authenticate a route of their own.
 *
 * This answers permission and catalog membership only. Precedence over a
 * declared profile is the caller's, because a profile is the deployment's own
 * statement about endpoint, catalog, and credential and a sign-in beneath it
 * only supplies auth — so activation adds routes and never replaces one, which
 * is what keeps the settings contract unchanged.
 * @param request - the stored records and the deployment's choice.
 * @returns the activatable providers, and the stored sign-ins this harness will not send.
 */
export function resolveSignInRoutes(request: SignInRouteRequest): SignInRouteSpec {
  const activate: string[] = []
  const withheld: SignInClassification[] = []
  // Catalog order, not stored order; a record naming a provider the catalog
  // does not ship sorts last, since it can only ever be withheld or inert.
  const catalogOrder = new Map(catalogProviderIds().map((provider, index) => [provider, index]))
  const ordered = [...request.stored].sort((left, right) =>
    (catalogOrder.get(left.provider) ?? catalogOrder.size) - (catalogOrder.get(right.provider) ?? catalogOrder.size))
  for (const { provider, credential } of ordered) {
    const classification = classifySignIn(provider, credential)
    if (classification.signInClass !== 'sanctioned') {
      withheld.push(classification)
      continue
    }
    if (!request.activateRoutes) continue
    // Everything an activated route needs but the credential — endpoint,
    // protocol, models — comes from the installed catalog entry, so a provider
    // the catalog does not ship can only be reached by declaring a profile.
    if (!catalogOrder.has(provider)) continue
    activate.push(provider)
  }
  return { activate, withheld }
}
