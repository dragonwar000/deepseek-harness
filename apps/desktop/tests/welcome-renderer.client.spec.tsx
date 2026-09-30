// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Welcome } from '../src/client/WelcomePage.tsx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { CotecconsSsoSignInId, CotecconsSsoView } from '@deepseek-ai/dsh-coteccons-sso/types'
import type { WelcomeSaveResult, WelcomeNotice } from '../src/welcome-api.ts'

const html = readFileSync(join(import.meta.dirname, '../renderer/welcome.html'), 'utf8')
afterEach(cleanup)

const SIGNED_OUT: CotecconsSsoView = { status: 'signed-out' }
const LINK = 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize'
const attemptId = (value: string) => value as CotecconsSsoSignInId
const signingIn = (id: string, url: string | null = LINK): CotecconsSsoView => ({ status: 'signing-in', attemptId: attemptId(id), url })

function mount(language = 'zh-CN', takeNotice = vi.fn<() => Promise<WelcomeNotice | undefined>>().mockResolvedValue(undefined)) {
  cleanup()
  const stopSso = vi.fn()
  const api = {
    takeNotice,
    onSsoState: vi.fn((_listener: (state: CotecconsSsoView) => void) => stopSso),
    startSignIn: vi.fn(async (): Promise<CotecconsSsoView> => signingIn('started', null)),
    cancelSignIn: vi.fn(async (): Promise<CotecconsSsoView> => SIGNED_OUT),
    copySignInLink: vi.fn(async () => undefined),
    ...resolveDesktopLocale(language),
    saveApiKey: vi.fn<(settingsNs: string, value: string) => Promise<WelcomeSaveResult>>().mockResolvedValue({ ok: true }),
    skip: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getWritableProviders: vi.fn<() => Promise<readonly string[]>>().mockResolvedValue(['llm-deepseek']),
  }
  const mounted = render(<Welcome api={api} />)
  const input = document.querySelector('input')!
  const button = (id: string) => document.querySelector<HTMLButtonElement>(id)!
  const enterKey = (value: string) => {
    fireEvent.change(input, { target: { value } })
  }
  const submit = () => fireEvent.submit(document.querySelector('form')!)
  const receive = (state: CotecconsSsoView) => { act(() => { api.onSsoState.mock.calls[0]![0](state) }) }
  const copy = () => {
    const heading = document.querySelector('main')!.getAttribute('aria-labelledby')!
    return [
      document.title, document.querySelector('img')!.alt, document.getElementById(heading)!.textContent,
      ...heading === 'welcome-heading' ? [document.querySelector('#welcome-description')!.textContent] : [],
      ...heading === 'key-title' ? [document.querySelector('#key-description')!.textContent, `${input.placeholder} [password]`] : [],
      ...[...document.querySelectorAll('button')].filter(item => item.closest('[hidden]') === null && !item.hidden)
        .map(item => `${item.textContent || item.getAttribute('aria-label')}${item.disabled ? ' [disabled]' : ''}`),
      '',
    ].join('\n')
  }
  return { document, api, input, button, enterKey, submit, copy, receive, unmount: mounted.unmount, stopSso }
}

describe('desktop welcome presentation', () => {
  it.each(['zh-CN', 'en'])('renders the %s entry and API-key step', async (language) => {
    const view = mount(language)
    expect(view.document.documentElement.lang).toBe(language)
    expect(view.document.querySelector('img')!.getAttribute('src')).toBe('assets/welcome-brand.svg')
    await expect(view.copy()).toMatchFileSnapshot(`./expected/welcome/${language}.expected.txt`)
    fireEvent.click(view.button('#api-key'))
    expect(view.document.activeElement).toBe(view.input)
    expect(view.input.type).toBe('password')
    await expect(view.copy()).toMatchFileSnapshot(`./expected/welcome/${language}-api-key.expected.txt`)
  })

  it('sends one trimmed key, prevents competing actions, and clears it after saving', async () => {
    const view = mount()
    await act(async () => {})
    const saved = Promise.withResolvers<WelcomeSaveResult>()
    view.api.saveApiKey.mockReturnValue(saved.promise)
    fireEvent.click(view.button('#api-key'))
    view.enterKey('  sk-desktop-example  ')
    view.submit()
    view.submit()
    fireEvent.click(view.button('#skip-key'))
    fireEvent.click(view.button('#back-to-login'))
    expect(view.api.saveApiKey).toHaveBeenCalledExactlyOnceWith('llm-deepseek', 'sk-desktop-example')
    expect(view.api.skip).not.toHaveBeenCalled()
    expect(view.button('#save-key').disabled).toBe(true)
    expect(view.button('#save-key').textContent).toBe(view.api.messages.welcomeKeySave)
    expect(view.button('#back-to-login').disabled).toBe(true)
    expect(view.document.querySelector<HTMLElement>('#key-form')!.hidden).toBe(false)
    saved.resolve({ ok: true })
    await vi.waitFor(() => { expect(view.input.value).toBe('') })
    expect(view.document.body.textContent).not.toContain('sk-desktop-example')
  })

  it.each(['', 'bad key', '密钥', 'DEEPSEEK_API_KEY=sk-example', '"sk-example"', '`sk-example`'])(
    'rejects invalid input before sending it: %s', (value) => {
      const view = mount()
      fireEvent.click(view.button('#api-key'))
      view.enterKey(value)
      view.submit()
      expect(view.api.saveApiKey).not.toHaveBeenCalled()
      expect(view.document.querySelector<HTMLElement>('#key-error')!.hidden).toBe(false)
      expect(view.input.getAttribute('aria-invalid')).toBe('true')
    },
  )

  it('retains an unsaved draft and allows retry after a refused save', async () => {
    const view = mount()
    view.api.saveApiKey.mockResolvedValue({ ok: false })
    fireEvent.click(view.button('#api-key'))
    view.enterKey('sk-retry')
    view.submit()
    await vi.waitFor(() => { expect(view.button('#save-key').disabled).toBe(false) })
    expect(view.input.value).toBe('sk-retry')
    expect(view.document.querySelector('#key-error')!.textContent).toBe(view.api.messages.welcomeKeyFailed)
    view.api.saveApiKey.mockResolvedValue({ ok: true })
    view.submit()
    await vi.waitFor(() => { expect(view.input.value).toBe('') })
  })

  it('skips without saving and starts a fresh renderer at the entry again', async () => {
    const view = mount()
    const skipped = Promise.withResolvers<undefined>()
    view.api.skip.mockReturnValue(skipped.promise)
    fireEvent.click(view.button('#api-key'))
    view.enterKey('sk-not-saved')
    fireEvent.click(view.button('#skip-key'))
    try {
      expect(view.button('#save-key').textContent).toBe(view.api.messages.welcomeKeySave)
      expect(view.button('#skip-key').textContent).toBe(view.api.messages.welcomeKeyLater)
      expect(view.button('#save-key').disabled).toBe(true)
      expect(view.button('#skip-key').disabled).toBe(true)
      expect(view.button('#back-to-login').disabled).toBe(true)
      fireEvent.click(view.button('#skip-key'))
      view.submit()
      expect(view.api.skip).toHaveBeenCalledOnce()
      expect(view.api.saveApiKey).not.toHaveBeenCalled()
    } finally {
      skipped.resolve(undefined)
    }
    await vi.waitFor(() => { expect(view.input.value).toBe('') })
    expect(view.api.skip).toHaveBeenCalledOnce()
    expect(view.api.saveApiKey).not.toHaveBeenCalled()
    expect(mount().document.querySelector<HTMLElement>('#key-form')!.hidden).toBe(true)
  })

  it('returns to the entry without saving and clears the draft and validation error', () => {
    const view = mount()
    fireEvent.click(view.button('#api-key'))
    view.enterKey('invalid key')
    view.submit()
    fireEvent.click(view.button('#back-to-login'))
    expect(view.document.querySelector<HTMLElement>('#key-form')!.hidden).toBe(true)
    expect(view.document.activeElement).toBe(view.button('#api-key'))
    expect(view.input.value).toBe('')
    expect(view.api.saveApiKey).not.toHaveBeenCalled()
    expect(view.api.skip).not.toHaveBeenCalled()
    fireEvent.click(view.button('#api-key'))
    expect(view.input.value).toBe('')
    expect(view.document.querySelector<HTMLElement>('#key-error')!.hidden).toBe(true)
    expect(view.button('#save-key').disabled).toBe(true)
  })

  it('keeps visible copy in the shell dictionaries and denies network access', () => {
    expect([...html.matchAll(/>([^<]*\p{L}[^<]*)</gu)]).toEqual([])
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("form-action 'none'")
  })
})

it.each(['zh-CN', 'en'])('offers Coteccons SSO, starts the Host sign-in, and shows the %s browser fallback link', async (language) => {
  const view = mount(language)
  await act(async () => {})
  fireEvent.click(view.button('#sign-in'))
  expect(view.api.startSignIn).toHaveBeenCalledOnce()
  await vi.waitFor(() => { expect(view.button('#auth-cancel').disabled).toBe(false) })
  expect(view.document.querySelector('#auth-status')!.textContent).toBe(view.api.messages.welcomeAuthStarting)
  view.receive(signingIn('started'))
  await expect(view.copy() + view.document.querySelector('#auth-description')!.textContent + '\n')
    .toMatchFileSnapshot(`./expected/welcome/${language}-waiting.expected.txt`)
  fireEvent.click(view.button('#auth-copy'))
  await vi.waitFor(() => { expect(view.button('#auth-copy').textContent).toBe(view.api.messages.welcomeAuthCopied) })
  expect(view.api.copySignInLink).toHaveBeenCalledWith('started')
  await vi.waitFor(() => { expect(view.button('#auth-copy').disabled).toBe(false) }, { timeout: 3000 })
  view.api.copySignInLink.mockRejectedValueOnce(new Error('clipboard unavailable'))
  fireEvent.click(view.button('#auth-copy'))
  await vi.waitFor(() => { expect(view.button('#auth-copy').textContent).toBe(view.api.messages.welcomeAuthCopyFailed) })
  view.receive({ status: 'signed-in', account: { name: null, username: 'a@coteccons.vn', tenantId: 't' } })
  expect(view.button('#auth-copy').hidden).toBe(true)
  expect(view.button('#auth-loading').hidden).toBe(false)
  expect(view.document.querySelector('#auth-status')!.textContent).toBe(view.api.messages.welcomeAuthExchanging)
  expect(view.document.querySelector('main')!.classList.contains('waiting-page')).toBe(false)
})

it.each(['zh-CN', 'en'])('renders %s timeout with manual retry and API-key alternative', async (language) => {
  const view = mount(language)
  fireEvent.click(view.button('#sign-in'))
  await act(async () => {})
  view.receive({ status: 'error', errorCode: 'timeout' })
  expect(view.button('#auth-retry').hidden).toBe(false)
  expect(view.button('#auth-api-key').hidden).toBe(false)
  await expect(view.copy() + view.document.querySelector('#auth-description')!.textContent + '\n')
    .toMatchFileSnapshot(`./expected/welcome/${language}-timeout.expected.txt`)
  fireEvent.click(view.button('#auth-retry'))
  expect(view.api.startSignIn).toHaveBeenCalledTimes(2)
  view.receive({ status: 'error', errorCode: 'domain-not-allowed' })
  expect(view.document.querySelector('#auth-status')!.textContent).toBe(view.api.messages.welcomeAuthDomain)
  view.receive({ status: 'error', errorCode: 'sign-in-failed' })
  expect(view.document.querySelector('#auth-status')!.textContent).toBe(view.api.messages.welcomeAuthFailed)
  fireEvent.click(view.button('#auth-api-key'))
  expect(view.document.querySelector('#auth-page')!.hasAttribute('hidden')).toBe(true)
  expect(view.document.querySelector('#key-form')!.hasAttribute('hidden')).toBe(false)
})

it('reports a refused start as a failed sign-in', async () => {
  const view = mount('en')
  view.api.startSignIn.mockRejectedValueOnce(new Error('Host unavailable'))
  fireEvent.click(view.button('#sign-in'))
  await vi.waitFor(() => { expect(view.document.querySelector('#auth-status')!.textContent).toBe(view.api.messages.welcomeAuthFailed) })
  expect(view.button('#auth-retry').hidden).toBe(false)
})

it('cancels the current attempt and returns to the entry page', async () => {
  const view = mount('en')
  fireEvent.click(view.button('#sign-in'))
  await act(async () => {})
  view.receive(signingIn('current'))
  const cancelled = Promise.withResolvers<CotecconsSsoView>()
  view.api.cancelSignIn.mockReturnValueOnce(cancelled.promise)
  fireEvent.click(view.button('#auth-cancel'))
  fireEvent.click(view.button('#auth-cancel'))
  expect(view.api.cancelSignIn).toHaveBeenCalledExactlyOnceWith('current')
  await act(async () => { cancelled.resolve(SIGNED_OUT); await cancelled.promise })
  expect(view.document.querySelector<HTMLElement>('#auth-page')!.hidden).toBe(true)
  expect(view.button('#sign-in').closest('[hidden]')).toBeNull()
  fireEvent.click(view.button('#sign-in'))
  await act(async () => {})
  view.receive(signingIn('retry'))
  view.api.cancelSignIn.mockRejectedValueOnce(new Error('closed'))
  fireEvent.click(view.button('#auth-cancel'))
  await vi.waitFor(() => { expect(view.button('#auth-cancel').disabled).toBe(false) })
  expect(view.document.querySelector<HTMLElement>('#auth-page')!.hidden).toBe(false)
})

it('disables Coteccons SSO with a note while it is not configured and keeps API key and skip usable', async () => {
  const view = mount('en')
  view.receive({ status: 'not-configured', missing: ['tenantId', 'clientId'] })
  expect(view.button('#sign-in').disabled).toBe(true)
  expect(view.document.querySelector<HTMLElement>('#sso-note')!.hidden).toBe(false)
  expect(view.document.querySelector('#sso-note')!.textContent).toBe(view.api.messages.welcomeSsoNotConfigured)
  expect(view.button('#api-key').disabled).toBe(false)
  fireEvent.click(view.button('#skip-entry'))
  await vi.waitFor(() => { expect(view.api.skip).toHaveBeenCalledOnce() })
})

it('keeps a newer sign-in notification when the start response arrives late', async () => {
  const view = mount()
  const started = Promise.withResolvers<CotecconsSsoView>()
  view.api.startSignIn.mockReturnValueOnce(started.promise)
  fireEvent.click(view.button('#sign-in'))
  expect(view.button('#auth-cancel').disabled).toBe(true)
  view.receive({ status: 'error', errorCode: 'timeout' })
  await act(async () => { started.resolve(signingIn('late')); await started.promise })
  expect(view.document.querySelector('#auth-status')!.textContent).toBe(view.api.messages.welcomeAuthExpired)
  expect(view.button('#auth-retry').hidden).toBe(false)
})

it('does not restore a copied-link status after leaving the waiting phase', async () => {
  const view = mount()
  const copied = Promise.withResolvers<undefined>()
  view.api.copySignInLink.mockReturnValueOnce(copied.promise)
  fireEvent.click(view.button('#sign-in'))
  await act(async () => {})
  view.receive(signingIn('attempt'))
  fireEvent.click(view.button('#auth-copy'))
  expect(view.button('#auth-copy').disabled).toBe(true)
  view.receive({ status: 'signed-in', account: { name: 'A', username: 'a@coteccons.vn', tenantId: 't' } })
  await act(async () => { copied.resolve(undefined); await copied.promise })
  expect(view.button('#auth-copy').hidden).toBe(true)
  expect(view.button('#auth-copy').textContent).toBe(view.api.messages.welcomeAuthCopyLink)
})

it('keeps the key draft while sign-in notifications arrive and releases the subscription on unmount', () => {
  const view = mount()
  fireEvent.click(view.button('#api-key'))
  view.enterKey('sk-draft')
  view.receive({ status: 'error', errorCode: 'timeout' })
  expect(view.document.querySelector<HTMLElement>('#key-form')!.hidden).toBe(false)
  expect(view.input.value).toBe('sk-draft')
  view.unmount()
  expect(view.stopSso).toHaveBeenCalledOnce()
})

it.each(['copied', 'failed'] as const)('restores the copy action after %s feedback and cleans up on unmount', async (result) => {
  vi.useFakeTimers()
  try {
    const view = mount('en')
    if (result === 'failed') view.api.copySignInLink.mockRejectedValue(new Error('clipboard unavailable'))
    fireEvent.click(view.button('#sign-in'))
    await act(async () => {})
    view.receive(signingIn('waiting'))
    const feedback = result === 'copied' ? view.api.messages.welcomeAuthCopied : view.api.messages.welcomeAuthCopyFailed
    const copy = async () => { await act(async () => { fireEvent.click(view.button('#auth-copy')) }) }
    await copy()
    expect(view.button('#auth-copy').textContent).toBe(feedback)
    expect(view.button('#auth-copy').disabled).toBe(result === 'copied')
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    await copy()
    expect(view.api.copySignInLink).toHaveBeenCalledTimes(result === 'copied' ? 1 : 2)
    await act(async () => { await vi.advanceTimersByTimeAsync(result === 'copied' ? 499 : 1999) })
    expect(view.button('#auth-copy').textContent).toBe(feedback)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(view.button('#auth-copy').textContent).toBe(view.api.messages.welcomeAuthCopyLink)
    expect(view.button('#auth-copy').disabled).toBe(false)
    await copy()
    expect(view.api.copySignInLink).toHaveBeenCalledTimes(result === 'copied' ? 2 : 3)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

it.each(['zh-CN', 'en'])('keeps the expiry notice visible after returning to Welcome: %s', async (language) => {
  vi.useFakeTimers()
  try {
    const takeNotice = vi.fn<() => Promise<WelcomeNotice | undefined>>().mockResolvedValue(undefined).mockResolvedValueOnce('session-expired')
    const view = mount(language, takeNotice)
    await act(async () => {})
    const publish = view.api.onSsoState.mock.calls[0]![0]
    const expired: CotecconsSsoView = { status: 'error', errorCode: 'session-expired' }
    await act(async () => { publish(expired) })
    const notice = screen.getByRole('alert')
    expect(notice.textContent).toBe(view.api.messages.welcomeSessionExpired)
    await expect(`${notice.textContent}\n`).toMatchFileSnapshot(`./expected/welcome/${language}-expired.expected.txt`)
    expect(view.button('#sign-in').closest('[hidden]')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => { publish(expired) })
    expect(screen.queryByRole('alert')).toBeNull()
    view.unmount()
    mount(language, takeNotice)
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
  } finally { cleanup(); vi.useRealTimers() }
})

it('does not infer a notification from a retained expired sign-in snapshot', async () => {
  const view = mount()
  await act(async () => { view.api.onSsoState.mock.calls[0]![0]({ status: 'error', errorCode: 'session-expired' }) })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('keeps the entry usable when notification IPC fails', async () => {
  const view = mount('en', vi.fn<() => Promise<WelcomeNotice | undefined>>().mockRejectedValue(new Error('closed')))
  await act(async () => {})
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(view.button('#api-key'))
  expect(view.input.closest('[hidden]')).toBeNull()
})

it('ignores a notification received after its renderer unmounts', async () => {
  const pending = Promise.withResolvers<WelcomeNotice | undefined>()
  const view = mount('en', vi.fn<() => Promise<WelcomeNotice | undefined>>().mockReturnValue(pending.promise))
  view.unmount()
  mount('en')
  await act(async () => { pending.resolve('session-expired') })
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['zh-CN', 'en'])('returns from a completed sign-in to the entry page after sign-out: %s', async (language) => {
  const view = mount(language)
  fireEvent.click(view.button('#sign-in'))
  await act(async () => {})
  view.receive({ status: 'signed-in', account: { name: 'A', username: 'a@coteccons.vn', tenantId: 't' } })
  expect(view.document.querySelector<HTMLElement>('#auth-page')!.hidden).toBe(false)
  view.receive(SIGNED_OUT)
  expect(view.button('#sign-in').closest('[hidden]')).toBeNull()
  expect(view.document.querySelector<HTMLElement>('#auth-page')!.hidden).toBe(true)
  await expect(view.copy()).toMatchFileSnapshot(`./expected/welcome/${language}.expected.txt`)
})
