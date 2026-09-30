/** Which stored sign-ins may authenticate a route, and which routes that produces. */

import { describe, expect, it } from 'vitest'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { catalogProvider, catalogProviderIds } from '../src/catalog.ts'
import {
  classifySignIn,
  KEY_SIGN_IN_SUBSTITUTE,
  resolveSignInRoutes,
  signInClassifications,
} from '../src/sign-in.ts'

/** The installed providers whose OAuth login pi-ai marks as a subscription. */
function subscriptionProviders(): readonly string[] {
  return catalogProviderIds().filter(provider => catalogProvider(provider)?.auth.oauth?.isSubscription === true)
}

describe('sign-in classification', () => {
  it('withholds exactly the installed consumer-subscription grants', () => {
    // The pinned set, not a derived one: a pi-ai upgrade that adds a
    // subscription login must fail here and be reviewed, because every entry
    // is an account the product now has to explain rather than route.
    expect(subscriptionProviders()).toEqual([
      'anthropic',
      'github-copilot',
      'kimi-coding',
      'meta',
      'openai-codex',
      'xai',
    ])

    const withheld = signInClassifications()
      .filter(entry => entry.signInClass !== 'sanctioned')
      .map(entry => `${entry.provider}/${entry.credential}`)
    expect(withheld).toEqual(subscriptionProviders().map(provider => `${provider}/grant`))
  })

  it('sanctions every API-key sign-in the catalog offers, and the third-party grants', () => {
    const sanctioned = signInClassifications().filter(entry => entry.signInClass === 'sanctioned')

    // Every offered key is sanctioned: a key names only the account that
    // issued it, so sending it claims nothing about which client this is.
    expect(sanctioned.filter(entry => entry.credential === 'api-key')).toHaveLength(
      catalogProviderIds().filter(provider => catalogProvider(provider)?.auth.apiKey?.login !== undefined).length)

    // The grants a vendor documents for third-party clients: OpenRouter's
    // PKCE exchange and pi-ai's own gateway, neither marked a subscription.
    expect(sanctioned.filter(entry => entry.credential === 'grant').map(entry => entry.provider))
      .toEqual(['openrouter', 'radius'])
  })

  it('states why a subscription grant is withheld, and which key replaces it', () => {
    const anthropic = classifySignIn('anthropic', 'grant')
    expect(anthropic.signInClass).toBe('delegated-only')
    expect(anthropic.reason).toContain('consumer subscription grant')
    expect(anthropic.reason).toContain('Claude Pro/Max')
    // Anthropic ships its own key sign-in, so the alternative is the same
    // record id under the other method.
    expect(anthropic.keyAlternative).toBe('anthropic')

    // Codex ships no key at all; the substitute is the platform route.
    const codex = classifySignIn('openai-codex', 'grant')
    expect(codex.signInClass).toBe('delegated-only')
    expect(codex.keyAlternative).toBe('openai')
  })

  it('points every declared substitute at an installed API-key sign-in', () => {
    for (const [withheldProvider, substitute] of Object.entries(KEY_SIGN_IN_SUBSTITUTE)) {
      // The withheld provider must be one that genuinely ships no key, or the
      // substitute is hiding its own sign-in.
      expect(catalogProvider(withheldProvider)?.auth.apiKey).toBeUndefined()
      expect(catalogProvider(substitute)?.auth.apiKey?.login).toBeTypeOf('function')
    }
  })

  it('sanctions an API key and a third-party grant, naming what the vendor issued', () => {
    const key = classifySignIn('deepseek', 'api-key')
    expect(key).toEqual({
      provider: 'deepseek',
      credential: 'api-key',
      signInClass: 'sanctioned',
      reason: 'an API key issued to the account holder in the vendor\'s own console',
    })

    const grant = classifySignIn('openrouter', 'grant')
    expect(grant.signInClass).toBe('sanctioned')
    expect(grant.reason).toContain('third-party clients')
    // A sanctioned classification needs no alternative: it is the route.
    expect(grant.keyAlternative).toBeUndefined()
  })

  it('refuses a grant no installed provider can turn into request auth', () => {
    // A provider the catalog ships, but with no OAuth method: a grant stored
    // for it survived an upgrade that removed the login.
    const keyOnly = classifySignIn('deepseek', 'grant')
    expect(keyOnly.signInClass).toBe('unknown-grant')
    expect(keyOnly.reason).toContain('no installed provider defines an OAuth method')
    expect(keyOnly.keyAlternative).toBe('deepseek')

    // A route pi-ai never shipped: nothing names a key for it either.
    const unshipped = classifySignIn('acme-gateway', 'grant')
    expect(unshipped.signInClass).toBe('unknown-grant')
    expect(unshipped.keyAlternative).toBeUndefined()
  })

  it('refuses a stored record kind it does not know', () => {
    expect(() => classifySignIn('deepseek', 'passkey' as CredentialRecord['kind']))
      .toThrow(/unreachable variant in llm-pi-ai stored credential kind/)
  })
})

describe('sign-in route resolution', () => {
  it('activates sanctioned sign-ins in installed-catalog order', () => {
    const spec = resolveSignInRoutes({
      stored: [
        { provider: 'openrouter', credential: 'grant' },
        { provider: 'deepseek', credential: 'api-key' },
        { provider: 'anthropic', credential: 'api-key' },
      ],
      activateRoutes: true,
    })
    // Catalog order, not stored order, so two deployments holding the same
    // records register the same route set.
    expect(spec.activate).toEqual(['anthropic', 'deepseek', 'openrouter'])
    expect(spec.withheld).toEqual([])
  })

  it('withholds a subscription grant while activating the sanctioned records beside it', () => {
    const spec = resolveSignInRoutes({
      stored: [
        { provider: 'openai-codex', credential: 'grant' },
        { provider: 'deepseek', credential: 'api-key' },
      ],
      activateRoutes: true,
    })
    expect(spec.activate).toEqual(['deepseek'])
    expect(spec.withheld.map(entry => entry.provider)).toEqual(['openai-codex'])
  })

  it('activates nothing when the deployment pins its routes, and still explains the withheld', () => {
    const spec = resolveSignInRoutes({
      stored: [
        { provider: 'deepseek', credential: 'api-key' },
        { provider: 'anthropic', credential: 'grant' },
      ],
      activateRoutes: false,
    })
    expect(spec.activate).toEqual([])
    // A withheld sign-in is withheld for a reason the deployment did not
    // choose, so disabling activation does not silence it.
    expect(spec.withheld.map(entry => entry.provider)).toEqual(['anthropic'])
  })

  it('leaves a sanctioned key for a provider the catalog does not ship inert', () => {
    const spec = resolveSignInRoutes({
      stored: [{ provider: 'acme-gateway', credential: 'api-key' }],
      activateRoutes: true,
    })
    // Nothing supplies its endpoint, protocol, or models, so only a declared
    // profile can turn this key into a route — and nothing was withheld,
    // because the key itself is one this harness may send.
    expect(spec).toEqual({ activate: [], withheld: [] })
  })

  it('orders around records the catalog does not ship, wherever they sit', () => {
    // Unshipped ids on both sides of a comparison, so the ordering does not
    // depend on which side the sort happens to put them.
    const spec = resolveSignInRoutes({
      stored: [
        { provider: 'openrouter', credential: 'api-key' },
        { provider: 'zz-private', credential: 'api-key' },
        { provider: 'deepseek', credential: 'api-key' },
        { provider: 'aa-private', credential: 'api-key' },
        { provider: 'anthropic', credential: 'api-key' },
      ],
      activateRoutes: true,
    })
    expect(spec.activate).toEqual(['anthropic', 'deepseek', 'openrouter'])
  })

  it('resolves an empty store to no routes', () => {
    expect(resolveSignInRoutes({ stored: [], activateRoutes: true })).toEqual({ activate: [], withheld: [] })
  })
})
