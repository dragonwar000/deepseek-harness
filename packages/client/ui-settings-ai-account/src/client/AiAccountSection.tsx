/** AI Account settings section: contributed account groups, then official-CLI accounts by kind with defaults, removal, and sign-in. */
import { Button, Tag, usePendingAction } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AiAccountId, AiAccountKind, AiAccountSignInError, AiAccountSignInId, AiAccountSignInView, AiAccountView, AiAccountsView,
} from '@deepseek-ai/dsh-ai-account/types'
import type { HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AiAccountLocaleKey } from './locales.ts'
import type {} from './slot-contract.ts'
import css from './AiAccountSection.module.css'

/** Latest Host account state as the section sees it. */
export interface AiAccountSnapshot {
  /** Latest Host snapshot; `null` until the account stream delivers one. */
  readonly view: AiAccountsView | null
  /** Whether the account stream stopped; `view` then keeps the last delivered snapshot. */
  readonly failed: boolean
}

/** Account snapshot and commands supplied by the plugin's apply closure. */
export interface AiAccountSectionInjected {
  hooks: { accounts: HostObservable<AiAccountSnapshot> }
  /** Start or join the official-CLI sign-in for one kind. */
  startSignIn: (kind: AiAccountKind) => Promise<void>
  /** Cancel the named sign-in attempt. */
  cancelSignIn: (id: AiAccountSignInId) => Promise<void>
  /** Make one account the default of its kind. */
  setDefault: (id: AiAccountId) => Promise<void>
  /** Sign one account out and forget it. */
  remove: (id: AiAccountId) => Promise<void>
}

/** Props bound by the settings-section renderer. */
export type AiAccountSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.aiAccount'>
  & PropsRenderSlots<'settings.ai-account.group'>
  & InjectFace<AiAccountSectionInjected>

const KINDS: readonly AiAccountKind[] = ['claude', 'chatgpt']
const ACTIVE_PHASES: ReadonlySet<AiAccountSignInView['phase']> = new Set(['starting', 'waiting-browser', 'waiting-device-code', 'verifying'])

/**
 * Render the AI Account settings page: contributed groups (Coteccons SSO) first, then the official-CLI groups.
 * @param props - locale, contributed-group renderer, account stream, and account commands.
 * @returns the section content.
 */
export function AiAccountSection(props: AiAccountSectionProps) {
  const { t, useAccounts, renderSlot } = props
  const { view, failed } = useAccounts(value => value)
  const { pending, failed: actionFailed, run } = usePendingAction()

  if (view === null) {
    return (
      <section className={css.section}>
        <h3 className={css.heading}>{t('title')}</h3>
        <p className={css.hint}>{t('intro')}</p>
        {renderSlot('settings.ai-account.group', {})}
        {failed ? <p className={css.error} role="alert">{t('unavailable')}</p> : <p className={css.hint}>{t('loading')}</p>}
      </section>
    )
  }
  const signIn = view.signIn
  const signingIn = signIn !== null && ACTIVE_PHASES.has(signIn.phase)

  return (
    <section className={css.section}>
      <h3 className={css.heading}>{t('title')}</h3>
      <p className={css.hint}>{t('intro')}</p>
      {renderSlot('settings.ai-account.group', {})}
      {failed && <p className={css.error} role="alert">{t('unavailable')}</p>}
      {signIn !== null && signingIn && (
        <SignInCard signIn={signIn} t={t} onCancel={() => { run(() => props.cancelSignIn(signIn.id)) }} />
      )}
      {signIn?.phase === 'failed' && <p className={css.error} role="alert">{t(failureKey(signIn))}</p>}
      {actionFailed && <p className={css.error} role="alert">{t('errorAction')}</p>}
      {KINDS.map((kind) => {
        const accounts = view.accounts.filter(account => account.kind === kind)
        return (
          <div className={css.group} key={kind} data-kind={kind}>
            <div className={css.groupHeader}>
              <h4 className={css.groupTitle}>{t(kind === 'claude' ? 'claudeGroup' : 'chatgptGroup')}</h4>
              <Button variant="outline" size="sm" disabled={pending || signingIn} onClick={() => { run(() => props.startSignIn(kind)) }}>
                {t(kind === 'claude' ? 'addClaude' : 'addChatgpt')}
              </Button>
            </div>
            {accounts.length === 0
              ? <p className={css.hint}>{t('empty')}</p>
              : (
                <ul className={css.list}>
                  {accounts.map(account => (
                    <AccountRow
                      key={account.id}
                      account={account}
                      t={t}
                      disabled={pending}
                      onSetDefault={() => { run(() => props.setDefault(account.id)) }}
                      onRemove={() => { run(() => props.remove(account.id)) }}
                    />
                  ))}
                </ul>
              )}
          </div>
        )
      })}
    </section>
  )
}

const FAILURE_KEYS: Readonly<Record<Exclude<AiAccountSignInError, 'executable-missing'>, AiAccountLocaleKey>> = {
  'login-failed': 'errorLoginFailed',
  timeout: 'errorTimeout',
  'identity-unavailable': 'errorIdentity',
}

/**
 * Select the failure message for a failed attempt.
 * @param signIn - failed attempt.
 * @returns the dictionary key for its error code.
 */
function failureKey(signIn: AiAccountSignInView): AiAccountLocaleKey {
  if (signIn.errorCode === 'executable-missing') return signIn.kind === 'claude' ? 'errorExecutableClaude' : 'errorExecutableChatgpt'
  return FAILURE_KEYS[signIn.errorCode ?? 'login-failed']
}

/** One registered account with its default badge and commands. */
function AccountRow({ account, t, disabled, onSetDefault, onRemove }: {
  account: AiAccountView
  t: AiAccountSectionProps['t']
  disabled: boolean
  onSetDefault: () => void
  onRemove: () => void
}) {
  return (
    <li className={css.row} data-account={account.id}>
      <div className={css.identity}>
        <span className={css.email}>{account.email ?? t('unnamedAccount')}</span>
        {account.plan !== null && <Tag tone="neutral">{account.plan}</Tag>}
        {account.isDefault && <Tag tone="success">{t('defaultBadge')}</Tag>}
      </div>
      <div className={css.actions}>
        {!account.isDefault && <Button size="sm" disabled={disabled} onClick={onSetDefault}>{t('setDefault')}</Button>}
        <Button size="sm" disabled={disabled} onClick={onRemove}>{t('remove')}</Button>
      </div>
    </li>
  )
}

/** Progress of the active sign-in: the CLI's browser URL, or its device URL and one-time code. */
function SignInCard({ signIn, t, onCancel }: {
  signIn: AiAccountSignInView
  t: AiAccountSectionProps['t']
  onCancel: () => void
}) {
  return (
    <div className={css.card} role="status">
      <h4 className={css.groupTitle}>{t(signIn.kind === 'claude' ? 'signingInClaude' : 'signingInChatgpt')}</h4>
      {signIn.phase === 'starting' && <p className={css.hint}>{t('starting')}</p>}
      {signIn.phase === 'verifying' && <p className={css.hint}>{t('verifying')}</p>}
      {signIn.phase === 'waiting-browser' && <p className={css.hint}>{t('waitingBrowser')}</p>}
      {signIn.phase === 'waiting-device-code' && (
        <p className={css.hint}>{t(signIn.userCode === null ? 'waitingDeviceCodePending' : 'waitingDeviceCode')}</p>
      )}
      {(signIn.phase === 'waiting-browser' || signIn.phase === 'waiting-device-code') && signIn.url !== null && (
        <a className={css.link} href={signIn.url} target="_blank" rel="noreferrer noopener">{signIn.url}</a>
      )}
      {signIn.phase === 'waiting-device-code' && signIn.userCode !== null && (
        <div className={css.code}>
          <span className={css.hint}>{t('userCodeLabel')}</span>
          <code className={css.codeValue}>{signIn.userCode}</code>
        </div>
      )}
      <Button variant="outline" size="sm" className={css.cancel} onClick={onCancel}>{t('cancel')}</Button>
    </div>
  )
}
