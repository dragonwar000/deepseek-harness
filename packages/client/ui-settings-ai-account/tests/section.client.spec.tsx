// @vitest-environment jsdom
/** AI Account section rendering: grouped accounts, defaults, sign-in progress, and failures. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { AiAccountId, AiAccountSignInId, AiAccountSignInView, AiAccountsView } from '@deepseek-ai/dsh-ai-account/types'
import { AiAccountSection, type AiAccountSectionInjected, type AiAccountSectionProps } from '../src/client/AiAccountSection.tsx'
import type {} from '../src/client/index.ts'
import { en, zh, type AiAccountLocaleKey } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const claudeDefault = { id: 'c1' as AiAccountId, kind: 'claude' as const, email: 'me@example.com', plan: 'max', createdAt: 1, isDefault: true }
const claudeOther = { id: 'c2' as AiAccountId, kind: 'claude' as const, email: 'work@example.com', plan: null, createdAt: 2, isDefault: false }
const chatgpt = { id: 'g1' as AiAccountId, kind: 'chatgpt' as const, email: null, plan: null, createdAt: 3, isDefault: true }

function attempt(value: Partial<AiAccountSignInView>): AiAccountSignInView {
  return { id: 'attempt' as AiAccountSignInId, kind: 'claude', phase: 'starting', url: null, userCode: null, errorCode: null, ...value }
}

function mount(view: AiAccountsView | null, copy: Record<AiAccountLocaleKey, string> = en, failed = false) {
  const operations = {
    startSignIn: vi.fn<AiAccountSectionInjected['startSignIn']>(() => Promise.resolve()),
    cancelSignIn: vi.fn<AiAccountSectionInjected['cancelSignIn']>(() => Promise.resolve()),
    setDefault: vi.fn<AiAccountSectionInjected['setDefault']>(() => Promise.resolve()),
    remove: vi.fn<AiAccountSectionInjected['remove']>(() => Promise.resolve()),
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
