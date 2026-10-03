/** Coteccons SSO group on the AI Account page, fed from the Host sign-in stream; a completed sign-in selects the Coteccons model. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-ai-account/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { CotecconsSsoView, M365ConnectorView } from '@deepseek-ai/dsh-coteccons-sso/types'
import { CotecconsSsoGroup, type CotecconsSsoGroupInjected, type CotecconsSsoSnapshot } from './CotecconsSsoGroup.tsx'
import { M365Group, type M365GroupInjected, type M365Snapshot } from './M365Group.tsx'
import { en, m365En, m365Zh, zh, type CotecconsSsoLocaleKey, type M365LocaleKey } from './locales.ts'

export type { CotecconsSsoGroupInjected, CotecconsSsoGroupProps, CotecconsSsoSnapshot } from './CotecconsSsoGroup.tsx'
export type { M365GroupInjected, M365GroupProps, M365Snapshot } from './M365Group.tsx'
export type { CotecconsSsoLocaleKey, M365LocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Coteccons SSO group copy. */
    'settings.cotecconsSso': CotecconsSsoLocaleKey
    /** Microsoft 365 group copy. */
    'settings.cotecconsM365': M365LocaleKey
  }
}

/** Model route the Coteccons sign-in makes the Agent default. */
const COTECCONS_PROVIDER = 'coteccons'

/** Services required by the Coteccons SSO group. */
export const inject = ['slots', 'locale', 'remote', 'remote.cotecconsSso', 'remote.session']

/**
 * Register the Coteccons SSO group and keep it fed from the Host sign-in stream.
 * @param ctx - client plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('settings.cotecconsSso', { en, zh }), 'coteccons-sso: dictionaries')
  /** Make the first Coteccons model the Agent default once a sign-in completes in this page; Remote calls report failures as results. */
  const selectDefaultModel = async (): Promise<void> => {
    const result = await ctx.remote.session.initializeDefaultModel(COTECCONS_PROVIDER)
    if (!result.ok) console.info('[coteccons-sso] default model selection failed', { reason: result.error.code })
  }
  let snapshot: CotecconsSsoSnapshot = { view: null, failed: false }
  const listeners = new Set<() => void>()
  const publish = (value: CotecconsSsoSnapshot) => {
    const signedIn = value.view?.status === 'signed-in' && snapshot.view?.status === 'signing-in'
    snapshot = value
    for (const listener of listeners) listener()
    if (signedIn) void selectDefaultModel()
  }
  const stream = ctx.remote.$stream<CotecconsSsoView>({
    name: 'cotecconsSso', open: signal => ctx.remote.cotecconsSso.watch(signal), ended: () => new Error('coteccons sso stream ended'),
  })
  // Disposal ends iteration without an error, so the failure handler runs only for a Host-side end or refusal.
  ctx.effect(() => () => stream.dispose(), 'coteccons-sso: state stream')
  void (async () => {
    for await (const frame of stream) {
      publish({ view: frame.value, failed: false })
      frame.accept()
    }
  })().catch((error: unknown) => {
    console.info('[coteccons-sso] sign-in stream stopped', error)
    publish({ ...snapshot, failed: true })
  })

  /** Publish a command's resulting snapshot, or reject so the group reports the failure. */
  const settle = async (request: ReturnType<typeof ctx.remote.cotecconsSso.getState>) => {
    const result = await request
    if (!result.ok) throw result.error
    publish({ ...snapshot, view: result.value })
  }
  const operations: CotecconsSsoGroupInjected = {
    hooks: {
      sso: {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      },
    },
    startSignIn: () => settle(ctx.remote.cotecconsSso.startSignIn()),
    cancelSignIn: id => settle(ctx.remote.cotecconsSso.cancelSignIn(id)),
    signOut: () => settle(ctx.remote.cotecconsSso.signOut()),
  }
  ctx.slots.inject('settings.ai-account.group', () => ctx.slots.register({
    name: 'settings.ai-account.group', id: 'coteccons', order: 0, locale: 'settings.cotecconsSso', inject: () => operations,
  }, CotecconsSsoGroup))

  ctx.effect(() => ctx.locale.register('settings.cotecconsM365', { en: m365En, zh: m365Zh }), 'coteccons-sso: Microsoft 365 dictionaries')
  let m365: M365Snapshot = { connectors: null, failed: false }
  const m365Listeners = new Set<() => void>()
  const publishM365 = (value: M365Snapshot) => {
    m365 = value
    for (const listener of m365Listeners) listener()
  }
  const m365Stream = ctx.remote.$stream<readonly M365ConnectorView[]>({
    name: 'cotecconsSsoM365', open: signal => ctx.remote.cotecconsSso.watchM365(signal), ended: () => new Error('microsoft 365 stream ended'),
  })
  ctx.effect(() => () => m365Stream.dispose(), 'coteccons-sso: Microsoft 365 stream')
  void (async () => {
    for await (const frame of m365Stream) {
      publishM365({ connectors: frame.value, failed: false })
      frame.accept()
    }
  })().catch((error: unknown) => {
    console.info('[coteccons-sso] Microsoft 365 stream stopped', error)
    publishM365({ ...m365, failed: true })
  })
  /** Publish a command's resulting snapshot, or reject so the group reports the failure. */
  const settleM365 = async (request: ReturnType<typeof ctx.remote.cotecconsSso.getM365State>) => {
    const result = await request
    if (!result.ok) throw result.error
    publishM365({ ...m365, connectors: result.value })
  }
  const m365Operations: M365GroupInjected = {
    hooks: {
      m365: {
        getSnapshot: () => m365,
        subscribe: (listener) => { m365Listeners.add(listener); return () => { m365Listeners.delete(listener) } },
      },
    },
    connect: id => settleM365(ctx.remote.cotecconsSso.connectM365(id)),
    connectAll: () => settleM365(ctx.remote.cotecconsSso.connectAllM365()),
    cancel: (id, attemptId) => settleM365(ctx.remote.cotecconsSso.cancelM365Connect(id, attemptId)),
    disconnect: id => settleM365(ctx.remote.cotecconsSso.disconnectM365(id)),
  }
  ctx.slots.inject('settings.ai-account.group', () => ctx.slots.register({
    name: 'settings.ai-account.group', id: 'coteccons-m365', order: 1, locale: 'settings.cotecconsM365', inject: () => m365Operations,
  }, M365Group))
}
