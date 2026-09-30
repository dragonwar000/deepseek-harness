/** Desktop welcome presentation; Coteccons SSO and credential operations stay in the preload. */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives/src/Toast.tsx'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives/src/StateDot.tsx'
import type { CotecconsSsoView } from '@deepseek-ai/dsh-coteccons-sso/types'
import type { WelcomeApi } from '../welcome-api.ts'

type Page = 'entry' | 'key' | 'sso'

/**
 * Human-readable label derived from the settings namespace.
 * Falls back to the raw namespace when there is no known provider.
 */
function providerLabel(ns: string): string {
  const KNOWN: Record<string, string> = {
    'llm-deepseek': 'DeepSeek',
    'llm-openai': 'OpenAI',
    'llm-anthropic': 'Anthropic',
    'llm-pi-ai': 'Pi AI',
    'llm-google': 'Google',
    'llm-xai': 'xAI',
  }
  return KNOWN[ns] ?? ns
}

/**
 * Render the standalone welcome flow using shell-owned operations and localized copy: Coteccons SSO sign-in,
 * a provider API key, or setting up later. A sign-in that ends as signed out returns to the entry page.
 * @param props.api - isolated preload API; no tokens or credentials reach the renderer.
 * @returns welcome pages with fixed bottom actions.
 */
export function Welcome({ api }: { api: WelcomeApi }) {
  const { messages: m } = api
  const [expiryNotice, setExpiryNotice] = useState(false)
  const [page, setPage] = useState<Page>('entry')
  const pageRef = useRef<Page>('entry')
  const [sso, setSso] = useState<CotecconsSsoView | null>(null)
  const ssoRef = useRef<CotecconsSsoView | null>(null)
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [copyFeedback, setCopyFeedback] = useState<{ status: 'idle' | 'busy' | 'copied' | 'failed' }>({ status: 'idle' })
  const copyState = copyFeedback.status
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const revision = useRef(0)
  const input = useRef<HTMLInputElement>(null)
  const apiKey = useRef<HTMLButtonElement>(null)
  const [providers, setProviders] = useState<readonly string[]>([])
  const [selectedProvider, setSelectedProvider] = useState('')

  function navigate(next: Page) {
    pageRef.current = next
    setPage(next)
  }
  function showSso(state: CotecconsSsoView) {
    const previous = ssoRef.current
    ssoRef.current = state
    setSso(state)
    if (state.status !== 'signing-in' || previous?.status !== 'signing-in' || previous.attemptId !== state.attemptId) {
      setCopyFeedback({ status: 'idle' })
    }
    if (pageRef.current !== 'sso') return
    setStarting(false)
    if (state.status === 'signed-out' || state.status === 'not-configured') navigate('entry')
  }

  useEffect(() => {
    mounted.current = true
    document.documentElement.lang = api.id
    document.title = m.welcomeTitle
    void api.getWritableProviders().then((list) => {
      if (!mounted.current) return
      const offered = list.length > 0 ? list : ['llm-deepseek']
      setProviders(offered)
      setSelectedProvider(offered[0] ?? 'llm-deepseek')
    }).catch(() => {
      if (!mounted.current) return
      setProviders(['llm-deepseek'])
      setSelectedProvider('llm-deepseek')
    })
    const takeNotice = (): void => {
      void api.takeNotice().then((notice) => {
        if (mounted.current && notice === 'session-expired') setExpiryNotice(true)
      }).catch((_closedChannel: unknown) => {
        // A closed Welcome IPC channel must not interrupt the entry page.
      })
    }
    takeNotice()
    const stop = api.onSsoState((state) => {
      revision.current++
      takeNotice()
      showSso(state)
    })
    return () => { mounted.current = false; stop() }
  }, [api, m.welcomeTitle])

  useEffect(() => {
    if (page === 'key') input.current?.focus()
  }, [page])

  useEffect(() => {
    if (copyState !== 'copied' && copyState !== 'failed') return
    const timer = setTimeout(() => { setCopyFeedback({ status: 'idle' }) }, 2000)
    return () => { clearTimeout(timer) }
  }, [copyFeedback])

  function openKey() {
    setError('')
    navigate('key')
  }
  function backToEntry() {
    if (busyRef.current) return
    setDraft('')
    setError('')
    navigate('entry')
    apiKey.current?.focus()
  }
  async function saveKey(event: FormEvent) {
    event.preventDefault()
    if (busyRef.current) return
    const value = draft.trim()
    if (!/^[\x21-\x7e]+$/.test(value) || /^[A-Z][A-Z0-9_]*=[^=]/.test(value)
      || ((value.startsWith('"') || value.startsWith("'") || value.charCodeAt(0) === 96) && value.at(-1) === value[0])) {
      setError(value === '' ? m.welcomeKeyBlank : m.welcomeKeyInvalid)
      input.current?.focus()
      return
    }
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const result = await api.saveApiKey(selectedProvider, value)
      if (!mounted.current) return
      if (result.ok) setDraft('')
      else setError(m.welcomeKeyFailed)
    } catch {
      if (mounted.current) setError(m.welcomeKeyFailed)
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function skip() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await api.skip()
      if (mounted.current) setDraft('')
    } catch {
      if (mounted.current) setError(m.welcomeContinueFailed)
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function start() {
    navigate('sso')
    setStarting(true)
    const current = ++revision.current
    try {
      const state = await api.startSignIn()
      if (mounted.current && revision.current === current) showSso(state)
    } catch {
      if (mounted.current && revision.current === current) {
        setStarting(false)
        showSso({ status: 'error', errorCode: 'sign-in-failed' })
      }
    }
  }
  async function cancel() {
    const current = ssoRef.current
    if (cancelling || current?.status !== 'signing-in') return
    setCancelling(true)
    const request = ++revision.current
    try {
      const state = await api.cancelSignIn(current.attemptId)
      if (mounted.current && revision.current === request) showSso(state)
    } catch {
      // The current attempt remains visible so cancellation can be retried.
    } finally {
      if (mounted.current) setCancelling(false)
    }
  }
  async function copyLink() {
    const current = ssoRef.current
    if (current?.status !== 'signing-in' || current.url === null || copyState === 'busy' || copyState === 'copied') return
    setCopyFeedback({ status: 'busy' })
    try {
      await api.copySignInLink(current.attemptId)
      if (mounted.current && ssoRef.current === current) setCopyFeedback({ status: 'copied' })
    } catch {
      if (mounted.current && ssoRef.current === current) setCopyFeedback({ status: 'failed' })
    }
  }

  const configured = sso?.status !== 'not-configured'
  const waiting = !starting && sso?.status === 'signing-in' && sso.url !== null
  const errorCode = !starting && sso?.status === 'error' ? sso.errorCode : undefined
  const failed = errorCode !== undefined
  const title = starting || (sso?.status === 'signing-in' && sso.url === null) ? m.welcomeAuthStarting
    : waiting ? m.welcomeAuthWaiting
      : errorCode === 'timeout' ? m.welcomeAuthExpired
        : errorCode === 'domain-not-allowed' ? m.welcomeAuthDomain
          : failed ? m.welcomeAuthFailed : m.welcomeAuthExchanging
  const heading = page === 'entry' ? 'welcome-heading' : page === 'key' ? 'key-title' : 'auth-status'
  const cancellable = !starting && sso?.status === 'signing-in'

  return <>
    {expiryNotice && <Toast text={m.welcomeSessionExpired} onDone={() => { setExpiryNotice(false) }} />}
    <div className="titlebar" aria-hidden="true" />
    <main className={`welcome${waiting && page === 'sso' ? ' waiting-page' : ''}`} aria-labelledby={heading}>
      <img className="brand" src="assets/welcome-brand.svg" alt={m.welcomeBrand} width="149" height="40" />
      <div id="tagline" className="tagline" hidden={page !== 'entry'}>
        <h1 id="welcome-heading"><span>{m.welcomeTaglineBefore}</span><em>{m.welcomeTaglineBrand}</em><span>{m.welcomeTaglineAfter}</span></h1>
        <p id="welcome-description">{m.welcomeDescription}</p>
        <p id="sso-note" hidden={configured}>{m.welcomeSsoNotConfigured}</p>
      </div>
      <form id="key-form" className="key-form" hidden={page !== 'key'} noValidate onSubmit={(event) => { void saveKey(event) }} aria-busy={busy}>
        <header className="key-heading"><h1 id="key-title">{m.welcomeKeyTitle}</h1><p id="key-description">{m.welcomeKeyDescription}</p></header>
        <div className="key-field">
          <label className="visually-hidden" htmlFor="provider-select">{m.welcomeProviderLabel}</label>
          <select id="provider-select" className="provider-select" value={selectedProvider}
            disabled={busy} onChange={(event) => { setSelectedProvider(event.target.value); setError('') }}>
            {providers.map(ns => (
              <option key={ns} value={ns}>{providerLabel(ns)}</option>
            ))}
          </select>
          <label className="visually-hidden" htmlFor="key-input">{m.welcomeKeyPlaceholder}</label>
          <input ref={input} id="key-input" type="password" autoComplete="new-password" autoCapitalize="off" spellCheck={false} required
            aria-describedby="key-description key-error" aria-invalid={error !== ''} placeholder={m.welcomeKeyPlaceholder}
            value={draft} disabled={busy} onChange={(event) => { setDraft(event.target.value); setError('') }} />
          <p id="key-error" className="key-error" role="alert" hidden={error === ''}>{error}</p>
        </div>
      </form>
      <section id="auth-page" className={`key-heading ${waiting ? 'auth-waiting' : failed ? 'auth-expired' : ''}`}
        hidden={page !== 'sso'} aria-live="polite">
        <h1 id="auth-status">{title}</h1>
        <p id="auth-description" hidden={!waiting && !failed}>{waiting ? m.welcomeAuthWaitingDescription : m.welcomeAuthExpiredDescription}</p>
        <button id="auth-copy" className="copy-link" type="button" hidden={!waiting} disabled={!waiting || copyState === 'busy' || copyState === 'copied'}
          onClick={() => { void copyLink() }}>
          {copyState === 'copied' ? m.welcomeAuthCopied : copyState === 'failed' ? m.welcomeAuthCopyFailed : m.welcomeAuthCopyLink}
        </button>
      </section>
      <div id="auth-actions" className="actions" hidden={page !== 'sso'}>
        <button id="auth-loading" className="primary" type="button" hidden={failed} disabled aria-label={m.welcomeAuthExchanging}>
          <StateDot state="ongoing" size={16} className="welcome-loading" />
        </button>
        <button id="auth-retry" className="primary" type="button" hidden={!failed} onClick={() => { void start() }}>{m.welcomeAuthRetry}</button>
        <button id="auth-api-key" className="secondary" type="button" hidden={!failed} onClick={openKey}>{m.welcomeApiKey}</button>
        <button id="auth-cancel" className="secondary" type="button" hidden={failed}
          disabled={cancelling || !cancellable} onClick={() => { void cancel() }}>{m.welcomeAuthCancel}</button>
      </div>
      <div id="key-actions" className="actions" hidden={page !== 'key'}>
        <button id="save-key" className="primary" type="submit" form="key-form"
          disabled={busy || draft.trim() === '' || selectedProvider === ''}>{m.welcomeKeySave}</button>
        <button id="skip-key" className="secondary" type="button" disabled={busy}
          onClick={() => { void skip() }}>{m.welcomeKeyLater}</button>
        <button id="back-to-login" className="back" type="button" disabled={busy} onClick={backToEntry}>{m.welcomeKeyBack}</button>
      </div>
      <div id="entry-actions" className="actions" hidden={page !== 'entry'}>
        <button id="sign-in" className="primary" type="button" disabled={busy || !configured}
          onClick={() => { void start() }}>{m.welcomeSignIn}</button>
        <button ref={apiKey} id="api-key" className="secondary" type="button" disabled={busy} onClick={openKey}>{m.welcomeApiKey}</button>
        <button id="skip-entry" className="back" type="button" disabled={busy}
          onClick={() => { void skip() }}>{m.welcomeKeyLater}</button>
      </div>
    </main>
  </>
}
