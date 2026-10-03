// @vitest-environment jsdom
/** Microsoft 365 group rendering for every connector state, in English and Chinese. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { M365ConnectAttemptId, M365ConnectorError, M365ConnectorView } from '@deepseek-ai/dsh-coteccons-sso/types'
import { M365Group, type M365GroupInjected } from '../src/client/M365Group.tsx'
import type {} from '../src/client/index.ts'
import { m365En, m365Zh, type M365LocaleKey } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

function mount(connectors: readonly M365ConnectorView[] | null, copy: Record<M365LocaleKey, string> = m365En, failed = false) {
  const operations = {
    connect: vi.fn<M365GroupInjected['connect']>(() => Promise.resolve()),
    connectAll: vi.fn<M365GroupInjected['connectAll']>(() => Promise.resolve()),
    cancel: vi.fn<M365GroupInjected['cancel']>(() => Promise.resolve()),
    disconnect: vi.fn<M365GroupInjected['disconnect']>(() => Promise.resolve()),
  }
  const snapshot = { connectors, failed }
  render(
    <M365Group {...({} as GlobalStandardProps)} {...operations}
      useM365={selector => selector(snapshot)} t={makeTranslate(copy)} />,
  )
  return operations
}

it('shows loading before the first snapshot and the stream failure', () => {
  mount(null)
  expect(screen.getByRole('heading').textContent).toBe(m365En.title)
  expect(screen.getByText(m365En.loading)).toBeTruthy()
  cleanup()
  mount(null, m365Zh, true)
  expect(screen.getByRole('alert').textContent).toBe(m365Zh.unavailable)
})

it('connects, cancels, and disconnects the named connector', async () => {
  const attemptId = 'attempt' as M365ConnectAttemptId
  const operations = mount([
    { id: 'mail', status: 'disconnected' },
    { id: 'chat', status: 'connecting', attemptId, url: 'https://login.microsoftonline.com/authorize' },
    { id: 'files', status: 'connected', username: 'a@coteccons.vn' },
  ])
  expect(screen.getByRole('link').getAttribute('href')).toBe('https://login.microsoftonline.com/authorize')
  expect(screen.getByText('Connected as a@coteccons.vn.')).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: `${m365En.connect} — ${m365En.mail}` })) })
  expect(operations.connect).toHaveBeenCalledExactlyOnceWith('mail')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: `${m365En.cancel} — ${m365En.chat}` })) })
  expect(operations.cancel).toHaveBeenCalledExactlyOnceWith('chat', attemptId)
  operations.disconnect.mockRejectedValueOnce(new Error('offline'))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: `${m365En.disconnect} — ${m365En.files}` })) })
  expect(operations.disconnect).toHaveBeenCalledExactlyOnceWith('files')
  expect(screen.getByRole('alert').textContent).toBe(m365En.errorAction)
})

it('offers no action for an unconfigured connector and prepares the sign-in link', () => {
  mount([{ id: 'mail', status: 'not-configured' }, { id: 'chat', status: 'connecting', attemptId: 'a' as M365ConnectAttemptId, url: null }])
  expect(screen.getByText(m365En.notConfigured)).toBeTruthy()
  expect(screen.getByText(m365En.preparing)).toBeTruthy()
  expect(screen.queryByRole('link')).toBeNull()
  expect(screen.getAllByRole('button')).toHaveLength(1)
})

it.each([
  ['not-assigned', 'errorNotAssigned'],
  ['disabled-by-admin', 'errorDisabled'],
  ['consent-required', 'errorConsent'],
  ['revoked', 'errorRevoked'],
  ['failed', 'errorFailed'],
] as const satisfies ReadonlyArray<readonly [M365ConnectorError, M365LocaleKey]>)('explains the %s refusal and offers connect again', (errorCode, key) => {
  mount([{ id: 'mail', status: 'blocked', errorCode }])
  expect(screen.getByRole('alert').textContent).toBe(m365En[key])
  expect(screen.getByRole('button', { name: `${m365En.connect} — ${m365En.mail}` })).toBeTruthy()
})
