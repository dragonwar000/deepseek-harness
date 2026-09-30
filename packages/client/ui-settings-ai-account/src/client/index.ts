/** AI Account settings: the contributed account group seat, official-CLI account lists, default selection, and sign-in progress. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { AiAccountsView } from '@deepseek-ai/dsh-ai-account/types'
import { AiAccountSection, type AiAccountSectionInjected, type AiAccountSnapshot } from './AiAccountSection.tsx'
import { en, zh, type AiAccountLocaleKey } from './locales.ts'
import type {} from './slot-contract.ts'

export type { AiAccountSectionInjected, AiAccountSectionProps, AiAccountSnapshot } from './AiAccountSection.tsx'
export type { AiAccountLocaleKey } from './locales.ts'
export type { AiAccountGroupOwnerProps } from './slot-contract.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** AI Account settings copy. */
    'settings.aiAccount': AiAccountLocaleKey
  }
}

/** Services required by the AI Account settings page. */
export const inject = ['slots', 'locale', 'remote', 'remote.aiAccount']

/**
 * Register the AI Account settings section and keep it fed from the Host account stream.
 * @param ctx - client plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('settings.aiAccount', { en, zh }), 'ai-account: dictionaries')
  const t = ctx.locale.bind('settings.aiAccount')
  let snapshot: AiAccountSnapshot = { view: null, failed: false }
  const listeners = new Set<() => void>()
  const publish = (value: AiAccountSnapshot) => {
    snapshot = value
    for (const listener of listeners) listener()
  }
  const stream = ctx.remote.$stream<AiAccountsView>({
    name: 'aiAccount', open: signal => ctx.remote.aiAccount.watch(signal), ended: () => new Error('ai account stream ended'),
  })
  // Disposal ends iteration without an error, so the failure handler runs only for a Host-side end or refusal.
  ctx.effect(() => () => stream.dispose(), 'ai-account: state stream')
  void (async () => {
    for await (const frame of stream) {
      publish({ view: frame.value, failed: false })
      frame.accept()
    }
  })().catch((error: unknown) => {
    console.info('[ai-account] account stream stopped', error)
    publish({ ...snapshot, failed: true })
  })

  /** Publish a command's resulting snapshot, or reject so the section reports the failure. */
  const settle = async (request: ReturnType<typeof ctx.remote.aiAccount.getState>) => {
    const result = await request
    if (!result.ok) throw result.error
    publish({ ...snapshot, view: result.value })
  }
  const operations: AiAccountSectionInjected = {
    hooks: {
      accounts: {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      },
    },
    startSignIn: kind => settle(ctx.remote.aiAccount.startSignIn(kind)),
    cancelSignIn: id => settle(ctx.remote.aiAccount.cancelSignIn(id)),
    submitSignInCode: (id, code) => settle(ctx.remote.aiAccount.submitSignInCode(id, code)),
    setDefault: id => settle(ctx.remote.aiAccount.setDefault(id)),
    remove: id => settle(ctx.remote.aiAccount.removeAccount(id)),
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'ai-account', order: 10, label: () => t('nav'),
    locale: 'settings.aiAccount', inject: () => operations,
    children: { 'settings.ai-account.group': { kind: 'list', scope: 'root' } },
  }, AiAccountSection))
}
