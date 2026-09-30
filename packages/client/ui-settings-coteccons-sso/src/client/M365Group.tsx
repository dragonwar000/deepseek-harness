/** Microsoft 365 group: one row per data kind with its IT-controlled access state, connect, cancel, and disconnect. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { M365ConnectAttemptId, M365ConnectorError, M365ConnectorId, M365ConnectorView } from '@deepseek-ai/dsh-coteccons-sso/types'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-ai-account/client'
import type { M365LocaleKey } from './locales.ts'
import css from './CotecconsSsoGroup.module.css'

/** Latest Host connector state as the group sees it. */
export interface M365Snapshot {
  /** Latest Host snapshot; `null` until the stream delivers one. */
  readonly connectors: readonly M365ConnectorView[] | null
  /** Whether the stream stopped; `connectors` then keeps the last delivered snapshot. */
  readonly failed: boolean
}

/** Connector state and commands supplied by the plugin's apply closure. */
export interface M365GroupInjected {
  hooks: { m365: HostObservable<M365Snapshot> }
  /** Start or join a connector's browser sign-in. */
  connect: (id: M365ConnectorId) => Promise<void>
  /** Cancel the named connector attempt. */
  cancel: (id: M365ConnectorId, attemptId: M365ConnectAttemptId) => Promise<void>
  /** Forget a connector's stored sign-in on this Host. */
  disconnect: (id: M365ConnectorId) => Promise<void>
}

/** Props bound by the AI Account group renderer. */
export type M365GroupProps =
  PropsRuntime<'settings.ai-account.group'> & PropsLocale<'settings.cotecconsM365'> & InjectFace<M365GroupInjected>

const NAME_KEYS: Readonly<Record<M365ConnectorId, M365LocaleKey>> = { mail: 'mail', chat: 'chat', files: 'files' }

const ERROR_KEYS: Readonly<Record<M365ConnectorError, M365LocaleKey>> = {
  'not-assigned': 'errorNotAssigned',
  'disabled-by-admin': 'errorDisabled',
  'consent-required': 'errorConsent',
  revoked: 'errorRevoked',
  failed: 'errorFailed',
}

/**
 * Render the Microsoft 365 group below Coteccons SSO on the AI Account page.
 * @param props - locale, connector stream, and commands.
 * @returns one row per connector.
 */
export function M365Group(props: M365GroupProps) {
  const { t, useM365 } = props
  const { connectors, failed } = useM365(value => value)
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
  const row = (view: M365ConnectorView) => {
    const label = t(NAME_KEYS[view.id])
    const connect = (
      <Button variant="outline" size="sm" disabled={pending} aria-label={`${t('connect')} — ${label}`}
        onClick={() => { run(() => props.connect(view.id)) }}>{t('connect')}</Button>
    )
    let detail
    let action = null
    switch (view.status) {
      case 'not-configured':
        detail = <p className={css.hint}>{t('notConfigured')}</p>
        break
      case 'disconnected':
        detail = <p className={css.hint}>{t('disconnected')}</p>
        action = connect
        break
      case 'connecting':
        detail = (
          <div className={css.progress} role="status">
            <p className={css.hint}>{t(view.url === null ? 'preparing' : 'connecting')}</p>
            {view.url !== null && <a className={css.link} href={view.url} target="_blank" rel="noreferrer noopener">{view.url}</a>}
          </div>
        )
        action = (
          <Button variant="outline" size="sm" disabled={pending} aria-label={`${t('cancel')} — ${label}`}
            onClick={() => { run(() => props.cancel(view.id, view.attemptId)) }}>{t('cancel')}</Button>
        )
        break
      case 'connected':
        detail = <p className={css.hint}>{t('connected', { account: view.username })}</p>
        action = (
          <Button size="sm" disabled={pending} aria-label={`${t('disconnect')} — ${label}`}
            onClick={() => { run(() => props.disconnect(view.id)) }}>{t('disconnect')}</Button>
        )
        break
      case 'blocked':
        detail = <p className={css.error} role="alert">{t(ERROR_KEYS[view.errorCode])}</p>
        action = connect
        break
    }
    return (
      <div key={view.id} className={css.row} data-connector={view.id}>
        <div>
          <p className={css.value}>{label}</p>
          {detail}
        </div>
        {action}
      </div>
    )
  }
  return (
    <div className={css.group} data-kind="m365">
      <div className={css.header}>
        <h4 className={css.title}>{t('title')}</h4>
      </div>
      <p className={css.hint}>{t('description')}</p>
      {connectors === null ? <p className={css.hint}>{t('loading')}</p> : connectors.map(row)}
      {failed && <p className={css.error} role="alert">{t('unavailable')}</p>}
      {actionFailed && <p className={css.error} role="alert">{t('errorAction')}</p>}
    </div>
  )
}
