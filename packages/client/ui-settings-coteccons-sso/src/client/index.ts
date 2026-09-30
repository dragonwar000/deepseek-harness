/** Coteccons SSO group on the AI Account page, fed from the Host sign-in stream; a completed sign-in selects the Coteccons model. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-ai-account/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { CotecconsSsoView } from '@deepseek-ai/dsh-coteccons-sso/types'
import { CotecconsSsoGroup, type CotecconsSsoGroupInjected, type CotecconsSsoSnapshot } from './CotecconsSsoGroup.tsx'
import { en, zh, type CotecconsSsoLocaleKey } from './locales.ts'

export type { CotecconsSsoGroupInjected, CotecconsSsoGroupProps, CotecconsSsoSnapshot } from './CotecconsSsoGroup.tsx'
export type { CotecconsSsoLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Coteccons SSO group copy. */
    'settings.cotecconsSso': CotecconsSsoLocaleKey
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
}
