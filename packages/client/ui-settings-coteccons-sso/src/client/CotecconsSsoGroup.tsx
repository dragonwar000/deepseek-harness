/** Coteccons SSO group: configuration hint, sign-in with the browser link, the signed-in account, and sign-out. */
import { useState } from 'react'
import { Button, CtdMark } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CotecconsSsoError, CotecconsSsoSignInId, CotecconsSsoView } from '@deepseek-ai/dsh-coteccons-sso/types'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-ai-account/client'
import type { CotecconsSsoLocaleKey } from './locales.ts'
import css from './CotecconsSsoGroup.module.css'

/** Latest Host sign-in state as the group sees it. */
export interface CotecconsSsoSnapshot {
  /** Latest Host snapshot; `null` until the stream delivers one. */
  readonly view: CotecconsSsoView | null
  /** Whether the stream stopped; `view` then keeps the last delivered snapshot. */
  readonly failed: boolean
}

/** Sign-in state and commands supplied by the plugin's apply closure. */
export interface CotecconsSsoGroupInjected {
  hooks: { sso: HostObservable<CotecconsSsoSnapshot> }
  /** Start or join the browser sign-in. */
  startSignIn: () => Promise<void>
  /** Cancel the named attempt. */
  cancelSignIn: (id: CotecconsSsoSignInId) => Promise<void>
  /** Sign out and forget the stored tokens. */
  signOut: () => Promise<void>
}

/** Props bound by the AI Account group renderer. */
export type CotecconsSsoGroupProps =
  PropsRuntime<'settings.ai-account.group'> & PropsLocale<'settings.cotecconsSso'> & InjectFace<CotecconsSsoGroupInjected>

const ERROR_KEYS: Readonly<Record<CotecconsSsoError, CotecconsSsoLocaleKey>> = {
  'sign-in-failed': 'errorSignInFailed',
  timeout: 'errorTimeout',
  'domain-not-allowed': 'errorDomain',
  'session-expired': 'errorExpired',
}

/**
 * Render the Coteccons SSO group at the top of the AI Account page.
 * @param props - locale, sign-in stream, and commands.
 * @returns the group for the current sign-in state.
 */
export function CotecconsSsoGroup(props: CotecconsSsoGroupProps) {
  const { t, useSso } = props
  const { view, failed } = useSso(value => value)
  const [pending, setPending] = useState(false)
  const [actionFailed, setActionFailed] = useState(false)
  const run = (action: () => Promise<void>) => {
    setPending(true)
    setActionFailed(false)
    void action().then(
      () => { setPending(false) },
      () => { setPending(false); setActionFailed(true) },
    )
  }
  const signInButton = (
    <Button variant="outline" size="sm" disabled={pending} onClick={() => { run(props.startSignIn) }}>{t('signIn')}</Button>
  )
  let body
  switch (view?.status) {
    case undefined:
      body = <p className={css.hint}>{t('loading')}</p>
      break
    case 'not-configured':
      body = <p className={css.hint}>{t('notConfigured', { settings: view.missing.join(', ') })}</p>
      break
    case 'signed-out':
      body = <div className={css.row}><p className={css.hint}>{t('signedOut')}</p>{signInButton}</div>
      break
    case 'error':
      body = (
        <div className={css.row}>
          <p className={css.error} role="alert">{t(ERROR_KEYS[view.errorCode])}</p>
          {signInButton}
        </div>
      )
      break
    case 'signing-in':
      body = (
        <div className={css.progress} role="status">
          <p className={css.hint}>{t(view.url === null ? 'preparing' : 'signingIn')}</p>
          {view.url !== null && <a className={css.link} href={view.url} target="_blank" rel="noreferrer noopener">{view.url}</a>}
          <Button variant="outline" size="sm" className={css.cancel} disabled={pending}
            onClick={() => { run(() => props.cancelSignIn(view.attemptId)) }}>{t('cancel')}</Button>
        </div>
      )
      break
    case 'signed-in':
      body = (
        <div className={css.row}>
          <dl className={css.identity}>
            <dt className={css.label}>{t('signedInAs')}</dt>
            <dd className={css.value}>
              {view.account.name === null ? view.account.username : `${view.account.name} (${view.account.username})`}
            </dd>
            <dt className={css.label}>{t('tenant')}</dt>
            <dd className={css.value}>{view.account.tenantId}</dd>
          </dl>
          <Button size="sm" disabled={pending} onClick={() => { run(props.signOut) }}>{t('signOut')}</Button>
        </div>
      )
      break
  }
  return (
    <div className={css.group} data-kind="coteccons">
      <div className={css.header}>
        <CtdMark size={20} className={css.mark} />
        <h4 className={css.title}>{t('title')}</h4>
      </div>
      <p className={css.hint}>{t('description')}</p>
      {body}
      {failed && <p className={css.error} role="alert">{t('unavailable')}</p>}
      {actionFailed && <p className={css.error} role="alert">{t('errorAction')}</p>}
    </div>
  )
}
