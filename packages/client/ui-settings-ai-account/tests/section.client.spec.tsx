// @vitest-environment jsdom
/** AI Account section rendering: grouped accounts, defaults, sign-in progress, and failures. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AiAccountId, AiAccountSignInId, AiAccountSignInView, AiAccountStatusView, AiAccountsView,
} from '@deepseek-ai/dsh-ai-account/types'
import { AiAccountSection, type AiAccountSectionInjected, type AiAccountSectionProps } from '../src/client/AiAccountSection.tsx'
import type {} from '../src/client/index.ts'
import { en, zh, type AiAccountLocaleKey } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const unknown: AiAccountStatusView = { status: 'unknown', checkedAt: null, message: null }
const claudeDefault = { id: 'c1' as AiAccountId, kind: 'claude' as const, email: 'me@example.com', plan: 'max', createdAt: 1, isDefault: true, status: unknown }
const claudeOther = { id: 'c2' as AiAccountId, kind: 'claude' as const, email: 'work@example.com', plan: null, createdAt: 2, isDefault: false, status: unknown }
const chatgpt = { id: 'g1' as AiAccountId, kind: 'chatgpt' as const, email: null, plan: null, createdAt: 3, isDefault: true, status: unknown }

function attempt(value: Partial<AiAccountSignInView>): AiAccountSignInView {
  return {
    id: 'attempt' as AiAccountSignInId, kind: 'claude', phase: 'starting', url: null, userCode: null,
    awaitingCode: false, errorCode: null, ...value,
  }
}

function mount(view: AiAccountsView | null, copy: Record<AiAccountLocaleKey, string> = en, failed = false) {
  const operations = {
    startSignIn: vi.fn<AiAccountSectionInjected['startSignIn']>(() => Promise.resolve()),
    cancelSignIn: vi.fn<AiAccountSectionInjected['cancelSignIn']>(() => Promise.resolve()),
    submitSignInCode: vi.fn<AiAccountSectionInjected['submitSignInCode']>(() => Promise.resolve()),
    setDefault: vi.fn<AiAccountSectionInjected['setDefault']>(() => Promise.resolve()),
    remove: vi.fn<AiAccountSectionInjected['remove']>(() => Promise.resolve()),
    checkStatus: vi.fn<AiAccountSectionInjected['checkStatus']>(() => Promise.resolve()),
  }
  const snapshot = { view, failed }
  // The Coteccons SSO plugin fills this seat in the application; the stand-in marks where the page renders it.
  const renderSlot = vi.fn<AiAccountSectionProps['renderSlot']>(() => <section data-kind="coteccons">Coteccons SSO group</section>)
  const rendered = render(
    <AiAccountSection {...({} as GlobalStandardProps)} {...operations}
      renderSlot={renderSlot}
      useAccounts={selector => selector(snapshot)} close={() => {}} t={key => key in copy ? copy[key as AiAccountLocaleKey] : key} />,
  )
  return { ...operations, renderSlot, rendered }
}

const group = (kind: 'claude' | 'chatgpt') => within(document.querySelector<HTMLElement>(`[data-kind="${kind}"]`)!)

it('shows a loading state before the first snapshot', () => {
  mount(null)
  expect(screen.getByText(en.loading)).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  cleanup()
  mount(null, en, true)
  expect(screen.getByRole('alert').textContent).toBe(en.unavailable)
  cleanup()
  mount({ accounts: [chatgpt], signIn: null }, en, true)
  expect(screen.getByRole('alert').textContent).toBe(en.unavailable)
  expect(screen.getByText(en.unnamedAccount)).toBeTruthy()
})

it('renders contributed groups first, before Claude and ChatGPT, in every account-list state', () => {
  const kinds = () => [...document.querySelectorAll('[data-kind]')].map(element => element.getAttribute('data-kind'))
  const { renderSlot } = mount({ accounts: [], signIn: null })
  expect(renderSlot).toHaveBeenCalledWith('settings.ai-account.group', {})
  expect(kinds()).toEqual(['coteccons', 'claude', 'chatgpt'])
  expect(screen.getByRole('heading', { name: en.claudeGroup }).textContent).toBe('Claude — used through Claude Code')
  expect(screen.getByRole('heading', { name: en.chatgptGroup }).textContent).toBe('ChatGPT — used through Codex')
  cleanup()
  // The Coteccons SSO group has its own stream, so its group stays usable while the CLI account list loads or is lost.
  mount(null)
  expect(kinds()).toEqual(['coteccons'])
  expect(screen.getByText(en.loading)).toBeTruthy()
  cleanup()
  mount(null, zh, true)
  expect(kinds()).toEqual(['coteccons'])
  expect(screen.getByRole('alert').textContent).toBe(zh.unavailable)
})

it('tells each group why it adds no chat model, and which API key does', () => {
  mount({ accounts: [claudeDefault, chatgpt], signIn: null })
  // Whose client the grant belongs to, and the key that replaces it — both
  // per group, because the vendor and the key differ between them.
  const claude = group('claude').getByText(en.claudeMainModel).textContent ?? ''
  expect(claude).toContain('Claude Code client')
  expect(claude).toContain('Anthropic API key')
  const chat = group('chatgpt').getByText(en.chatgptMainModel).textContent ?? ''
  expect(chat).toContain('Codex client')
  expect(chat).toContain('OpenAI API key')
  cleanup()
  // Stated in both shipped languages, so neither reader is left guessing.
  mount({ accounts: [], signIn: null }, zh)
  expect(group('claude').getByText(zh.claudeMainModel)).toBeTruthy()
  expect(group('chatgpt').getByText(zh.chatgptMainModel)).toBeTruthy()
})

it('groups accounts by kind with default badges and per-account commands', async () => {
  const operations = mount({ accounts: [claudeDefault, claudeOther, chatgpt], signIn: null })
  expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
  const claude = group('claude')
  expect(claude.getByText('me@example.com')).toBeTruthy()
  expect(claude.getByText('max')).toBeTruthy()
  expect(claude.getAllByText(en.defaultBadge)).toHaveLength(1)
  expect(claude.getAllByRole('button', { name: en.setDefault })).toHaveLength(1)
  const chat = group('chatgpt')
  expect(chat.getByText(en.unnamedAccount)).toBeTruthy()
  expect(chat.getByText(en.defaultBadge)).toBeTruthy()
  expect(chat.queryByRole('button', { name: en.setDefault })).toBeNull()

  await act(async () => { fireEvent.click(claude.getByRole('button', { name: en.setDefault })) })
  expect(operations.setDefault).toHaveBeenCalledWith('c2')
  await act(async () => { fireEvent.click(chat.getByRole('button', { name: en.remove })) })
  expect(operations.remove).toHaveBeenCalledWith('g1')
  await act(async () => { fireEvent.click(chat.getByRole('button', { name: en.addChatgpt })) })
  expect(operations.startSignIn).toHaveBeenCalledWith('chatgpt')
  await act(async () => { fireEvent.click(claude.getByRole('button', { name: en.addClaude })) })
  expect(operations.startSignIn).toHaveBeenCalledWith('claude')
  expect(screen.queryByRole('alert')).toBeNull()
})

it('shows empty groups in Chinese', () => {
  mount({ accounts: [], signIn: null }, zh)
  expect(screen.getAllByText(zh.empty)).toHaveLength(2)
  expect(screen.getByRole('button', { name: zh.addClaude })).toBeTruthy()
  expect(screen.getByRole('button', { name: zh.addChatgpt })).toBeTruthy()
})

it('shows the Claude browser link while waiting and cancels the attempt', async () => {
  const url = 'https://claude.ai/oauth/authorize?state=x'
  const operations = mount({ accounts: [], signIn: attempt({ phase: 'waiting-browser', url }) })
  const card = within(screen.getByRole('status'))
  expect(card.getByText(en.signingInClaude)).toBeTruthy()
  expect(card.getByText(en.waitingBrowser)).toBeTruthy()
  expect(card.getByRole('link', { name: url }).getAttribute('href')).toBe(url)
  expect(screen.getByRole('button', { name: en.addClaude }).hasAttribute('disabled')).toBe(true)
  await act(async () => { fireEvent.click(card.getByRole('button', { name: en.cancel })) })
  expect(operations.cancelSignIn).toHaveBeenCalledWith('attempt')
})

it('takes the authorization code the browser showed and hands it to the waiting login command', async () => {
  const url = 'https://claude.ai/oauth/authorize?state=x'
  const operations = mount({ accounts: [], signIn: attempt({ phase: 'waiting-browser', url, awaitingCode: true }) })
  const card = within(screen.getByRole('status'))
  expect(card.getByText(en.codeHint)).toBeTruthy()
  const field = card.getByRole('textbox', { name: en.codeLabel })
  // An empty or blank code is never sent: the CLI would consume the prompt and fail the sign-in.
  expect(card.getByRole('button', { name: en.codeSubmit }).hasAttribute('disabled')).toBe(true)
  await act(async () => { fireEvent.change(field, { target: { value: '   ' } }) })
  expect(card.getByRole('button', { name: en.codeSubmit }).hasAttribute('disabled')).toBe(true)
  await act(async () => { fireEvent.change(field, { target: { value: '  pasted-code  ' } }) })
  await act(async () => { fireEvent.click(card.getByRole('button', { name: en.codeSubmit })) })
  expect(operations.submitSignInCode).toHaveBeenCalledWith('attempt', 'pasted-code')
  expect((field as HTMLInputElement).value).toBe('')
  // Enter submits, because a pasted code ends in one.
  await act(async () => { fireEvent.change(field, { target: { value: 'second-code' } }) })
  await act(async () => { fireEvent.keyDown(field, { key: 'Enter' }) })
  expect(operations.submitSignInCode).toHaveBeenLastCalledWith('attempt', 'second-code')
  await act(async () => { fireEvent.keyDown(field, { key: 'Enter' }) })
  expect(operations.submitSignInCode).toHaveBeenCalledTimes(2)
  await act(async () => { fireEvent.change(field, { target: { value: 'third' } }) })
  await act(async () => { fireEvent.keyDown(field, { key: 'a' }) })
  expect(operations.submitSignInCode).toHaveBeenCalledTimes(2)
})

it('offers no code field to a ChatGPT attempt or a Claude attempt that reads none', () => {
  mount({ accounts: [], signIn: attempt({ kind: 'chatgpt', phase: 'waiting-device-code', userCode: 'ABCD-EFGHI' }) })
  expect(screen.queryByRole('textbox')).toBeNull()
  cleanup()
  mount({ accounts: [], signIn: attempt({ phase: 'verifying' }) }, zh)
  expect(screen.queryByRole('textbox')).toBeNull()
  cleanup()
  mount({ accounts: [], signIn: attempt({ phase: 'waiting-browser', awaitingCode: true }) }, zh)
  expect(screen.getByRole('textbox', { name: zh.codeLabel })).toBeTruthy()
  expect(screen.getByText(zh.codeHint)).toBeTruthy()
})

it('shows the ChatGPT verification link and one-time code, and progress phases without links', () => {
  const url = 'https://auth.openai.com/codex/device'
  const waiting = mount({ accounts: [], signIn: attempt({ kind: 'chatgpt', phase: 'waiting-device-code', url, userCode: null }) })
  expect(screen.getByText(en.signingInChatgpt)).toBeTruthy()
  expect(screen.getByText(en.waitingDeviceCodePending)).toBeTruthy()
  waiting.rendered.unmount()
  mount({ accounts: [], signIn: attempt({ kind: 'chatgpt', phase: 'waiting-device-code', url, userCode: 'ABCD-EFGHI' }) })
  expect(screen.getByText(en.waitingDeviceCode)).toBeTruthy()
  expect(screen.getByRole('link', { name: url })).toBeTruthy()
  expect(screen.getByText(en.userCodeLabel)).toBeTruthy()
  expect(screen.getByText('ABCD-EFGHI')).toBeTruthy()
  cleanup()
  mount({ accounts: [], signIn: attempt({ phase: 'starting' }) })
  expect(screen.getByText(en.starting)).toBeTruthy()
  expect(screen.queryByRole('link')).toBeNull()
  cleanup()
  mount({ accounts: [], signIn: attempt({ phase: 'verifying' }) })
  expect(screen.getByText(en.verifying)).toBeTruthy()
  cleanup()
  mount({ accounts: [], signIn: attempt({ phase: 'waiting-browser' }) })
  expect(screen.queryByRole('link')).toBeNull()
})

it('explains each sign-in failure and hides finished attempts', () => {
  const cases: Array<[Partial<AiAccountSignInView>, string]> = [
    [{ kind: 'claude', errorCode: 'executable-missing' }, en.errorExecutableClaude],
    [{ kind: 'chatgpt', errorCode: 'executable-missing' }, en.errorExecutableChatgpt],
    [{ errorCode: 'login-failed' }, en.errorLoginFailed],
    [{ errorCode: 'timeout' }, en.errorTimeout],
    [{ errorCode: 'identity-unavailable' }, en.errorIdentity],
    [{ errorCode: 'store-failed' }, en.errorStoreFailed],
    [{ errorCode: null }, en.errorLoginFailed],
  ]
  for (const [value, message] of cases) {
    mount({ accounts: [], signIn: attempt({ phase: 'failed', ...value }) })
    expect(screen.getByRole('alert').textContent).toBe(message)
    expect(screen.queryByRole('status')).toBeNull()
    cleanup()
  }
  mount({ accounts: [], signIn: attempt({ phase: 'succeeded' }) })
  mount({ accounts: [], signIn: attempt({ phase: 'cancelled' }) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
})

it('reports a refused command and clears the report on the next command', async () => {
  const operations = mount({ accounts: [claudeOther], signIn: null })
  operations.remove.mockRejectedValueOnce(new Error('offline'))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.remove })) })
  expect(screen.getByRole('alert').textContent).toBe(en.errorAction)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.setDefault })) })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('marks a signed-out account, shows the CLI message, and signs in again for its kind', async () => {
  const signedOut: AiAccountStatusView = { status: 'signedOut', checkedAt: 10, message: 'Not logged in · Please run /login' }
  const signedIn: AiAccountStatusView = { status: 'signedIn', checkedAt: 10, message: null }
  const accounts = [{ ...claudeDefault, status: signedOut }, { ...claudeOther, status: signedIn }, chatgpt]
  const operations = mount({ accounts, signIn: null })
  const row = within(document.querySelector<HTMLElement>('[data-account="c1"]')!)
  expect(document.querySelector('[data-account="c1"]')!.getAttribute('data-status')).toBe('signedOut')
  expect(row.getByText(en.signedOutBadge)).toBeTruthy()
  expect(row.getByText(en.signedOutHint)).toBeTruthy()
  expect(row.getByText('Not logged in · Please run /login')).toBeTruthy()
  expect(within(document.querySelector<HTMLElement>('[data-account="c2"]')!).queryByText(en.signedOutBadge)).toBeNull()
  expect(group('chatgpt').queryByRole('button', { name: en.signInAgain })).toBeNull()
  await act(async () => { fireEvent.click(row.getByRole('button', { name: en.signInAgain })) })
  expect(operations.startSignIn).toHaveBeenCalledWith('claude')
  cleanup()
  // A signed-out answer without output keeps the notice; an active attempt disables signing in again.
  mount({ accounts: [{ ...chatgpt, status: { ...signedOut, message: null } }], signIn: attempt({ kind: 'chatgpt' }) }, zh)
  const chatRow = within(document.querySelector<HTMLElement>('[data-account="g1"]')!)
  expect(chatRow.getByText(zh.signedOutHint)).toBeTruthy()
  expect(chatRow.getByRole('button', { name: zh.signInAgain }).hasAttribute('disabled')).toBe(true)
})

it('runs the status checks on request once accounts exist', async () => {
  mount({ accounts: [], signIn: null })
  expect(screen.queryByRole('button', { name: en.checkStatus })).toBeNull()
  cleanup()
  const operations = mount({ accounts: [chatgpt], signIn: null })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.checkStatus })) })
  expect(operations.checkStatus).toHaveBeenCalledOnce()
})
