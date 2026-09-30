// @vitest-environment jsdom
/** Coteccons SSO group rendering in every sign-in state, in English and Chinese. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { CotecconsSsoError, CotecconsSsoSignInId, CotecconsSsoView } from '@deepseek-ai/dsh-coteccons-sso/types'
import { CotecconsSsoGroup, type CotecconsSsoGroupInjected } from '../src/client/CotecconsSsoGroup.tsx'
import type {} from '../src/client/index.ts'
import { en, zh, type CotecconsSsoLocaleKey } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

function mount(view: CotecconsSsoView | null, copy: Record<CotecconsSsoLocaleKey, string> = en, failed = false) {
  const operations = {
    startSignIn: vi.fn<CotecconsSsoGroupInjected['startSignIn']>(() => Promise.resolve()),
    cancelSignIn: vi.fn<CotecconsSsoGroupInjected['cancelSignIn']>(() => Promise.resolve()),
    signOut: vi.fn<CotecconsSsoGroupInjected['signOut']>(() => Promise.resolve()),
  }
  const snapshot = { view, failed }
  render(
    <CotecconsSsoGroup {...({} as GlobalStandardProps)} {...operations}
      useSso={selector => selector(snapshot)} t={makeTranslate(copy)} />,
  )
  return operations
}

it('titles the group with the Coteccons mark and shows loading before the first snapshot', () => {
  mount(null)
  expect(screen.getByRole('heading').textContent).toBe('Coteccons SSO — used for the main model')
  expect(document.querySelector('[data-kind="coteccons"] svg')).not.toBeNull()
  expect(screen.getByText(en.loading)).toBeTruthy()
  cleanup()
  mount(null, zh, true)
  expect(screen.getByRole('heading').textContent).toBe('Coteccons SSO — 用于主模型')
  expect(screen.getByRole('alert').textContent).toBe(zh.unavailable)
})

it('names the missing settings when the Host is not configured and offers no sign-in', () => {
  mount({ status: 'not-configured', missing: ['tenantId', 'clientId'] })
  expect(screen.getByText(/tenantId, clientId/).textContent).toBe(
    'Coteccons SSO is not configured on this Host. Set tenantId, clientId on the coteccons-sso row of the composition (cordis.patch.yml), then restart.',
  )
  expect(screen.queryByRole('button')).toBeNull()
})

it('starts sign-in while signed out and reports a refused request', async () => {
  const operations = mount({ status: 'signed-out' })
  expect(screen.getByText(en.signedOut)).toBeTruthy()
  operations.startSignIn.mockRejectedValueOnce(new Error('offline'))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.signIn })) })
  expect(operations.startSignIn).toHaveBeenCalledOnce()
  expect(screen.getByRole('alert').textContent).toBe(en.errorAction)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.signIn })) })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('shows the browser link and cancels the named attempt while signing in', async () => {
  const attemptId = 'attempt' as CotecconsSsoSignInId
  const operations = mount({ status: 'signing-in', attemptId, url: null })
  expect(screen.getByText(en.preparing)).toBeTruthy()
  expect(screen.queryByRole('link')).toBeNull()
  cleanup()
  const url = 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?client_id=x'
  const again = mount({ status: 'signing-in', attemptId, url }, zh)
  expect(screen.getByText(zh.signingIn)).toBeTruthy()
  expect(screen.getByRole('link').getAttribute('href')).toBe(url)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.cancel })) })
  expect(again.cancelSignIn).toHaveBeenCalledExactlyOnceWith(attemptId)
  expect(operations.cancelSignIn).not.toHaveBeenCalled()
})

it('shows the signed-in account and tenant and signs out', async () => {
  const operations = mount({ status: 'signed-in', account: { name: 'Nguyen Van A', username: 'a.nguyen@coteccons.vn', tenantId: 'tenant-id' } })
  expect(screen.getByText('Nguyen Van A (a.nguyen@coteccons.vn)')).toBeTruthy()
  expect(screen.getByText('tenant-id')).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.signOut })) })
  expect(operations.signOut).toHaveBeenCalledOnce()
  cleanup()
  mount({ status: 'signed-in', account: { name: null, username: 'b@coteccons.vn', tenantId: 't' } }, zh)
  expect(screen.getByText('b@coteccons.vn')).toBeTruthy()
  expect(screen.getByText(zh.signedInAs)).toBeTruthy()
})

it.each([
  ['sign-in-failed', 'errorSignInFailed'],
  ['timeout', 'errorTimeout'],
  ['domain-not-allowed', 'errorDomain'],
  ['session-expired', 'errorExpired'],
] as const satisfies ReadonlyArray<readonly [CotecconsSsoError, CotecconsSsoLocaleKey]>)('explains the %s failure and offers sign-in again', (errorCode, key) => {
  mount({ status: 'error', errorCode })
  expect(screen.getByRole('alert').textContent).toBe(en[key])
  expect(screen.getByRole('button', { name: en.signIn })).toBeTruthy()
})
