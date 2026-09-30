/**
 * Generic pi-ai-backed LLM adapter plugin. One plugin instance owns a dict of
 * provider routes; a route naming an installed pi-ai provider inherits that
 * provider's endpoint, protocol, and model catalog as defaults, and a route
 * pi-ai does not ship is declared outright. Profile facts resolve per request
 * over the optional `llm-pi-ai` user-settings section and the optional
 * credential seam, so a changed key, endpoint, model, or knob reaches the next
 * request without a restart; a changed *route set* (or a route's
 * registration-captured retry policy) re-registers the same adapter instance
 * in place.
 *
 * ```yaml
 * - id: llm
 *   name: '@deepseek-ai/dsh-llm-pi-ai'
 *   config:
 *     providers:
 *       # Catalog route: everything but the credential comes from pi-ai.
 *       openai:
 *         apiKeyEnv: OPENAI_API_KEY
 *         retryPolicy:
 *           mode: normal
 *           maxRetries: 2
 *       # Catalog route with the catalog narrowed and one capacity corrected.
 *       anthropic:
 *         apiKeyEnv: ANTHROPIC_API_KEY
 *         models:
 *           - id: claude-sonnet-4-5
 *             contextWindow: 200000
 *       # Hand-declared route: pi-ai ships nothing under this key.
 *       acme-gateway:
 *         displayName: Acme Gateway
 *         apiKeyEnv: ACME_GATEWAY_API_KEY
 *         api: openai-completions
 *         baseURL: https://gateway.acme.example/v1
 *         # Reasoning dialect for a URL pi-ai cannot recognize.
 *         compat:
 *           thinkingFormat: deepseek
 *         models:
 *           - id: acme-large
 *             name: Acme Large
 *             contextWindow: 65536
 *             maxTokens: 4096
 *           - id: acme-think
 *             name: Acme Think
 *             contextWindow: 262144
 *             maxTokens: 32768
 *             # key = selectable level, value = wire spelling; only off may
 *             # leave the value empty (supported, send nothing).
 *             reasoningEfforts:
 *               off:
 *               high: high
 *               max: ultra
 * ```
 *
 * @module @deepseek-ai/dsh-llm-pi-ai
 */
import type {} from '@deepseek-ai/dsh-settings'

import type {} from '@deepseek-ai/cordis-plugin-loader'

import type { Context } from '@deepseek-ai/cordis'
import { FiberState } from '@deepseek-ai/cordis'
import { credentialKeyId, credentialKeyScope } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle, LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-fs'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { PiAiAdapter } from './adapter.ts'
import { authContextFrom, credentialStoreFrom, RECORD_SCOPE } from './auth.ts'
import { catalogProviderIds } from './catalog.ts'
import { assertServiceable, Config, resolveProfiles } from './config.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { discoverModels } from './discovery.ts'
import type { StoredModelDiscoveryProfile } from './discovery.ts'
import { registerPiAiFlows } from './login.ts'
import { resolveSignInRoutes } from './sign-in.ts'
import type { SignInClassification, StoredSignIn } from './sign-in.ts'

export { PiAiAdapter } from './adapter.ts'
export type { PiAiAdapterOptions, PiAiAuthInjection } from './adapter.ts'
export { Config, PiAiModelProfileSchema, resolveProfiles } from './config.ts'
export type {
  Options,
  PiAiCompatProfile,
  PiAiModality,
  PiAiModelOverride,
  PiAiModelProfile,
  PiAiProviderProfile,
  PiAiReasoningEfforts,
  PiAiThinkingFormat,
  ResolvedPiAiProviderProfile,
} from './config.ts'
export { recordKeyFor } from './auth.ts'
export { supportedProtocols } from './provider.ts'
export { classifySignIn, resolveSignInRoutes, signInClassifications } from './sign-in.ts'
export type {
  SignInClass,
  SignInClassification,
  SignInRouteRequest,
  SignInRouteSpec,
  StoredSignIn,
} from './sign-in.ts'

export const name = 'llm-pi-ai'
export const inject = ['llm']

const NS = 'llm-pi-ai'

/**
 * The registry captures these per route; a change here must re-register.
 * Sorted by provider so a settings document that merely reorders its keys is
 * not mistaken for a route change.
 */
function registrationFacts(profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>): unknown {
  return [...profiles.entries()]
    // `displayName` rides along because the registry hands it to every selector
    // through `providerInfo()`: a rename that did not re-register would leave
    // the old label showing until some unrelated fact happened to change.
    .map(([provider, profile]) => ({
      provider,
      displayName: profile.displayName,
      retryPolicy: profile.retryPolicy,
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

/**
 * The configurable-provider directory: every installed catalog route, plus
 * every route the current profiles declare. A hand-declared route has no
 * catalog entry, so without this union it would have no settings address and
 * configuration surfaces could neither show nor edit it.
 * @param profiles - the currently resolved provider profiles.
 * @returns the directory entries in catalog order, declared routes last.
 */
function directoryEntries(
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  settingsNs: string,
): LlmConfigurableProvider[] {
  const catalog = new Set(catalogProviderIds())
  const entries = new Map<string, LlmConfigurableProvider>()
  const declare = (provider: string, displayName: string, error?: string): void => {
    entries.set(provider, {
      provider,
      displayName,
      settingsNs,
      settingsPath: ['providers', provider],
      // Membership of the installed catalog, not of the settings document:
      // narrowing a shipped provider's models stores a profile too, and that
      // route is still one pi-ai knows.
      declared: !catalog.has(provider),
      ...error === undefined ? {} : { error },
    })
  }
  for (const provider of catalog) declare(provider, provider)
  for (const [provider, profile] of profiles) declare(provider, profile.displayName, profile.catalogError)
  return [...entries.values()]
}

/** Register one generic pi-ai adapter for all configured provider routes. */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const settingsNs = ctx.fiber.entry?.options.id ?? NS
  let lastRaw: ReturnType<Config['providers']['get']> | undefined
  let memoized: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  /**
   * The resolved profiles for the current configuration, memoized by the raw
   * snapshot's identity — which is also what makes the adapter's own snapshot
   * stable across operations that observe no change.
   *
   * Catalog diagnostics stay in the snapshot beside serviceable models, so
   * stored configuration remains visible after an installed catalog changes.
   * Scalar configuration errors still reject resolution.
   */
  const declaredProfiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const raw = config.providers.get()
    if (raw === lastRaw && memoized !== undefined) return memoized
    const next = resolveProfiles(structuredClone(raw) as import('./config.ts').Options['providers'], 'deferred')
    lastRaw = raw
    memoized = next
    return next
  }
  declaredProfiles()

  /**
   * Providers whose stored credential currently activates a route of its own,
   * in installed-catalog order. It is read from the credential seam and never
   * from configuration, which is what lets signing in and out move the route
   * set without writing a settings document.
   */
  let activated: readonly string[] = []
  let routeDeclared: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  let routeActivated: readonly string[] | undefined
  let memoizedRoutes: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  /**
   * Every route this instance serves: the settings profiles, plus one
   * catalog-default profile per activated sign-in. A declared profile always
   * wins — it is the deployment's own statement about the route, and the
   * sign-in beneath it already authenticates it — so activation only ever adds
   * a provider the document is silent about.
   *
   * Memoized on both inputs' identities for the same reason the profiles are:
   * the adapter captures this map per operation, so a request must not observe
   * a new one while neither input moved.
   */
  const routes = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const declared = declaredProfiles()
    if (declared === routeDeclared && activated === routeActivated && memoizedRoutes !== undefined) {
      return memoizedRoutes
    }
    // An activated route is exactly the empty profile for its provider: the
    // installed catalog supplies endpoint, protocol, and models, and naming no
    // `apiKeyEnv` is what sends pi-ai to the stored record for its auth.
    const adopted = Object.fromEntries(activated.filter(provider => !declared.has(provider)).map(provider => [provider, {}]))
    const merged = new Map([...declared, ...resolveProfiles(adopted, 'deferred')])
    routeDeclared = declared
    routeActivated = activated
    memoizedRoutes = merged
    return merged
  }
  ctx.on('internal/config', function (this: import('@deepseek-ai/cordis').Fiber, _raw, next) {
    const raw: unknown = next()
    if (this !== ctx.fiber) return raw
    const candidate = Config(raw as import('./config.ts').Options)
    assertServiceable(
      { providers: structuredClone(candidate.providers.get()) } as import('./config.ts').Options,
      { providers: structuredClone(config.providers.get()) } as import('./config.ts').Options,
    )
    return raw
  })

  const resolveApiKey = async (
    provider: string,
    profile: ResolvedPiAiProviderProfile,
  ): Promise<string | undefined> => {
    const ref = profile.apiKeyEnv
    // Only a profile that names no credential at all defers to pi-ai's
    // provider-native discovery. Once one is named, a miss must fail loud:
    // handing pi-ai `undefined` would let it pick up an unrelated ambient key
    // (OPENAI_API_KEY and friends), billing another tenant for a request the
    // deployment meant to authenticate differently.
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      // Without the seam the environment is the whole credential plane.
      : launchEnvironmentOf(ctx).get(ref)?.value
    if (hit !== undefined && hit.length > 0) return assertUsableApiKey(hit, 'llm-pi-ai', ref)
    throw new LlmError(
      `llm-pi-ai: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not`
      + ` set — store ${ref} through the credentials service (the web Models page writes it) or export it,`
      + ' and remove apiKeyEnv only if this provider should authenticate from pi-ai\'s own environment discovery',
      'MISSING_CREDENTIAL',
    )
  }

  // One store and one ambient context for the whole plugin instance: both read
  // through `ctx` per call, so they stay correct across the collection rebuilds
  // a configuration change causes, and a sign-in survives one.
  const auth = { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) }
  const adapter = new PiAiAdapter({
    profiles: routes,
    resolveApiKey,
    auth,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(
        `llm-pi-ai: unusable replay state on assistant history for route "${provider}/${model}";`
        + ` sending that message as provider-neutral content (${reason})`,
      )
    },
  })
  // Independent of the route set: signing in is what makes a route worth
  // adding, so the flows are offered before any profile names their provider.
  // Scoped to the authorization seam rather than injected outright, because a
  // composition without it (headless, ACP) simply has no surface to sign in
  // from, while everything else this plugin does still works.
  ctx.inject(['authorization'], (authorized) => { registerPiAiFlows(authorized, auth) })
  // The full installed catalog is configurable from the moment the plugin
  // mounts — dormant or not — so configuration surfaces can offer every
  // pi-ai provider before any route exists. Hand-declared routes join it as
  // profiles appear, and leave with them.
  let directory: DirectoryRegistrationHandle | undefined
  let directoryFacts: unknown
  const ensureDirectory = (): void => {
    const entries = directoryEntries(routes(), settingsNs)
    if (deepEqualJson(entries, directoryFacts)) return
    // Atomic replace, never dispose-then-register: a route another adapter
    // family already declares (a profile keyed `deepseek-official`) would
    // otherwise leave this plugin's whole directory withdrawn and the Models
    // page empty. The candidate set is validated first, so a collision keeps
    // the previous entries serving and only costs a diagnostic.
    if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
    directoryFacts = entries
  }
  ensureDirectory()
  /** Host-owned request inputs for discovery of one configured route. */
  const storedDiscoveryProfile = (
    provider: string | undefined,
  ): StoredModelDiscoveryProfile | undefined => {
    if (provider === undefined) return undefined
    const profile = routes().get(provider)
    if (profile === undefined) return undefined
    return {
      headers: profile.headers,
      resolveApiKey: () => resolveApiKey(provider, profile),
    }
  }
  // Interrogating an endpoint is a configuration-time action over a draft, so
  // it is offered for the whole namespace rather than per route: the provider
  // a surface is adding does not exist yet. The draft is the whole request
  // except the stored credential and deployment-owned headers: the curated UI
  // accepts neither, so an already-configured route supplies both inside the
  // Host rather than widening the discovery request.
  ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => discoverModels(
    { ...request, ...signal === undefined ? {} : { signal } },
    () => storedDiscoveryProfile(request.provider),
  ))
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below. A bare
  // mount (zero routes) is the dormant posture: nothing registers until a
  // settings section supplies profiles, and routes drop when it empties.
  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts: unknown
  const ensureRegistrationFacts = (): void => {
    const facts = registrationFacts(routes())
    if (deepEqualJson(facts, registeredFacts)) return
    // The registry captures the route set and each route's retry policy at
    // registration, so a change to either must re-register. The swap is
    // atomic (same adapter instance, validated before anything moves): a
    // conflicting route leaves the previous routes serving requests, and
    // `registeredFacts` only advances once the registry actually holds the
    // new set — so returning to a working configuration always re-applies.
    const routeKeys = [...routes().keys()]
    if (registration === undefined) {
      // Dormant bare mount: nothing is registered until a section supplies
      // profiles, and an empty section keeps it that way.
      if (routeKeys.length === 0) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter(routeKeys, adapter)
    } else {
      registration.replace(routeKeys)
    }
    registeredFacts = facts
  }
  ensureRegistrationFacts()

  /** The records this plugin owns, reduced to what the route decision reads. */
  const storedSignIns = async (): Promise<readonly StoredSignIn[]> => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return []
    const stored = await credentials.listRecords()
    return stored
      .filter(entry => credentialKeyScope(entry.key) === RECORD_SCOPE)
      .map(entry => ({ provider: credentialKeyId(entry.key), credential: entry.kind }))
  }

  // One diagnostic per withheld sign-in, not one per refresh: an OAuth refresh
  // rewrites the record on a timer, and a line repeated on every write would
  // bury the one that says why a signed-in account drives no model.
  const reportedWithheld = new Set<string>()
  const reportWithheld = (withheld: readonly SignInClassification[]): void => {
    for (const entry of withheld) {
      const seen = `${entry.provider}/${entry.credential}/${entry.signInClass}`
      if (reportedWithheld.has(seen)) continue
      reportedWithheld.add(seen)
      ctx.logger.info(
        'llm-pi-ai: the stored sign-in for "%s" drives no model route because it is %s%s',
        entry.provider,
        entry.reason,
        entry.keyAlternative === undefined
          ? ''
          : `; sign in to "${entry.keyAlternative}" with an API key to reach the main model`,
      )
    }
  }

  /**
   * Re-read the stored sign-ins and move the route set if they changed.
   *
   * Coalesced rather than queued per event: sign-in, sign-out, and an OAuth
   * refresh all commit through the same record and each one emits, so a burst
   * must end in exactly one re-registration whose input is the last read.
   */
  let refreshing: Promise<void> | undefined
  let requested = 0
  let served = 0
  const applySignInRoutes = async (): Promise<void> => {
    const spec = resolveSignInRoutes({
      stored: await storedSignIns(),
      activateRoutes: config.signInRoutes.get(),
    })
    // The fiber can be disposed across that read. Registering afterwards would
    // put routes in the registry whose disposer has already run, leaving them
    // serving requests for a plugin that is gone.
    if (ctx.fiber.state !== FiberState.ACTIVE) return
    reportWithheld(spec.withheld)
    if (deepEqualJson(spec.activate, activated)) return
    activated = spec.activate
    ensureRegistrationFacts()
    ensureDirectory()
  }
  const refreshSignInRoutes = (): void => {
    // A request counter against a served watermark, rather than a queued flag:
    // the pass in flight reads the store once for every request up to the one
    // it started with, and a request arriving after that still leaves the two
    // unequal, so nothing is coalesced away.
    requested += 1
    if (refreshing !== undefined) return
    refreshing = (async () => {
      try {
        while (served !== requested) {
          served = requested
          try { await applySignInRoutes() }
          catch (error) {
            // The route set stays as it is: a store that cannot be read says
            // nothing about which sign-ins exist, and dropping live routes on a
            // transient read failure would end sessions mid-turn.
            ctx.logger.warn('llm-pi-ai: could not resolve the routes stored sign-ins activate')
            ctx.logger.warn(error)
          }
        }
      }
      // Released here rather than from a `.finally()` on the promise, so the
      // slot reopens in the same step the loop ends: a request landing between
      // the two would otherwise find a pass that can no longer serve it.
      finally { refreshing = undefined }
    })()
  }

  // Scoped to the credential seam rather than injected outright: a composition
  // with no credential plane stores no sign-in, so it has none to activate,
  // while everything else this plugin does still works. The scope is also what
  // makes a seam mounted after this plugin reach the route set, and what drops
  // the activated routes again when it leaves — a route whose credential store
  // is gone could not authenticate the next request.
  ctx.inject(['credentials'], (stored) => {
    stored.on('credentials/record-updated', (key) => {
      // Records another plugin owns say nothing about this one's routes.
      if (credentialKeyScope(key) !== RECORD_SCOPE) return
      refreshSignInRoutes()
    })
    stored.effect(() => () => {
      if (ctx.fiber.state !== FiberState.ACTIVE || activated.length === 0) return
      activated = []
      ensureRegistrationFacts()
      ensureDirectory()
    })
    refreshSignInRoutes()
  })

  ctx.on('loader/volatile-update', () => {
    try { ensureRegistrationFacts(); ensureDirectory() }
    catch (error) {
      ctx.logger.error('llm-pi-ai: configuration conflicts with an existing provider route')
      ctx.logger.error(error)
    }
    // `signInRoutes` and the profiles both moved in that update: a route the
    // document has just stopped declaring may now be activated by its stored
    // sign-in, and one it has just claimed must stop being.
    refreshSignInRoutes()
  })
}
