// @vitest-environment jsdom
/** AI Account settings registration, stream publication, and command results in the shipped client composition. */
import { expect, vi } from 'vitest'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createClientTest, type TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { AiAccountId, AiAccountSignInId, AiAccountsView } from '@deepseek-ai/dsh-ai-account/types'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { AiAccountSectionInjected } from '../src/client/AiAccountSection.tsx'
import * as host from '../src/index.ts'

const it = createClientTest({ roster: webApp })
const SELF = '@deepseek-ai/dsh-client-ui-settings-ai-account'
const empty: AiAccountsView = { accounts: [], signIn: null }
const added: AiAccountsView = {
  accounts: [{ id: 'a' as AiAccountId, kind: 'claude', email: 'me@example.com', plan: 'max', createdAt: 1, isDefault: true, status: { status: 'unknown', checkedAt: null, message: null } }],
  signIn: null,
}

function section(c: TestClient) {
  const entry = c.ctx.slots.entries('settings.section').find(candidate => candidate.options.id === 'ai-account')
  if (entry === undefined) throw new Error('AI Account section is not registered')
  const injected: object = entry.inject!()
  return { entry, operations: injected as AiAccountSectionInjected }
}

it('registers the AI Account section and publishes every stream snapshot', async ({ start }) => {
  const c = await start()
  const { entry, operations } = section(c)
  expect(resolveSlotLabel(entry.options.label)).toBe('AI Account')
  await vi.waitFor(() => { expect(operations.hooks.accounts.getSnapshot()).toEqual({ view: empty, failed: false }) })
  const listener = vi.fn()
  const off = operations.hooks.accounts.subscribe(listener)
  c.mock.streams.push('aiAccount/watch', added)
  await vi.waitFor(() => { expect(operations.hooks.accounts.getSnapshot().view).toEqual(added) })
  expect(listener).toHaveBeenCalled()
  off()
  await c.unload(SELF)
  expect(c.ctx.slots.entries('settings.section').some(candidate => candidate.options.id === 'ai-account')).toBe(false)
}, 60_000)

it('forwards commands to the Host, publishes their snapshots, and rejects refused calls', async ({ start, mock }) => {
  const c = await start()
  const { operations } = section(c)
  mock.remote.aiAccount.startSignIn.mockResolvedValue(ok(added))
  await operations.startSignIn('chatgpt')
  expect(mock.remote.aiAccount.startSignIn).toHaveBeenCalledWith('chatgpt')
  expect(operations.hooks.accounts.getSnapshot().view).toEqual(added)
  const attempt = 'attempt' as AiAccountSignInId
  mock.remote.aiAccount.cancelSignIn.mockResolvedValue(ok(empty))
  await operations.cancelSignIn(attempt)
  expect(mock.remote.aiAccount.cancelSignIn).toHaveBeenCalledWith(attempt)
  mock.remote.aiAccount.submitSignInCode.mockResolvedValue(ok(added))
  await operations.submitSignInCode(attempt, 'browser-code')
  expect(mock.remote.aiAccount.submitSignInCode).toHaveBeenCalledWith(attempt, 'browser-code')
  const account = 'a' as AiAccountId
  mock.remote.aiAccount.setDefault.mockResolvedValue(ok(added))
  await operations.setDefault(account)
  expect(mock.remote.aiAccount.setDefault).toHaveBeenCalledWith(account)
  mock.remote.aiAccount.removeAccount.mockResolvedValue(ok(empty))
  await operations.remove(account)
  expect(mock.remote.aiAccount.removeAccount).toHaveBeenCalledWith(account)
  expect(operations.hooks.accounts.getSnapshot().view).toEqual(empty)
  const failure = { ok: false as const, error: new RemoteError('gateway/internal', 'offline', {}) }
  mock.remote.aiAccount.removeAccount.mockResolvedValueOnce(failure)
  await expect(operations.remove(account)).rejects.toBe(failure.error)
  expect(operations.hooks.accounts.getSnapshot().view).toEqual(empty)
}, 60_000)

it('keeps the last snapshot and reports the loss when the Host ends the account stream; the Host half registers nothing', async ({ start }) => {
  // The Host half declares no services: `slots` and `locale` live in the browser,
  // so a Node-half injection would hold the Loader row PENDING for the whole run.
  expect(Object.keys(host)).toEqual(['apply'])
  expect(host.apply).not.toThrow()
  const c = await start()
  const { operations } = section(c)
  c.mock.streams.push('aiAccount/watch', added)
  await vi.waitFor(() => { expect(operations.hooks.accounts.getSnapshot().view).toEqual(added) })
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  c.mock.streams.end('aiAccount/watch')
  await vi.waitFor(() => { expect(operations.hooks.accounts.getSnapshot()).toEqual({ view: added, failed: true }) })
  expect(info).toHaveBeenCalledWith('[ai-account] account stream stopped', expect.objectContaining({ message: 'ai account stream ended' }))
  info.mockRestore()
}, 60_000)
