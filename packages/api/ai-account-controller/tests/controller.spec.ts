/** AI Account Remote delegation preserves provider results, failures, and stream lifetime. */
import { Context } from '@deepseek-ai/cordis'
import type { AiAccount } from '@deepseek-ai/dsh-ai-account'
import { afterEach, expect, it, vi } from 'vitest'
import type { AiAccountId, AiAccountSignInId, AiAccountStatus, AiAccountStatusChange, AiAccountsView } from '../src/types.ts'
import AiAccountController from '../src/index.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })
const state: AiAccountsView = { accounts: [], signIn: null }

function fixture() {
  const ctx = new Context()
  roots.push(ctx)
  const provider = {
    getState: vi.fn<AiAccount['getState']>().mockResolvedValue(state),
    startSignIn: vi.fn<AiAccount['startSignIn']>().mockResolvedValue(state),
    cancelSignIn: vi.fn<AiAccount['cancelSignIn']>().mockResolvedValue(state),
    submitSignInCode: vi.fn<AiAccount['submitSignInCode']>().mockResolvedValue(state),
    setDefault: vi.fn<AiAccount['setDefault']>().mockResolvedValue(state),
    remove: vi.fn<AiAccount['remove']>().mockResolvedValue(state),
    checkStatus: vi.fn<AiAccount['checkStatus']>().mockResolvedValue(state),
    watch: vi.fn<AiAccount['watch']>(),
  }
  ctx.provide('aiAccount', provider as never)
  return { provider, controller: new AiAccountController(ctx) }
}

it('delegates every command to the provider and returns its snapshot', async () => {
  const { provider, controller } = fixture()
  const account = 'account' as AiAccountId
  const attempt = 'attempt' as AiAccountSignInId
  expect(await controller.getState()).toBe(state)
  expect(await controller.startSignIn('chatgpt')).toBe(state)
  expect(provider.startSignIn).toHaveBeenCalledExactlyOnceWith('chatgpt')
  expect(await controller.checkStatus()).toBe(state)
  expect(provider.checkStatus).toHaveBeenCalledOnce()
  expect(await controller.cancelSignIn(attempt)).toBe(state)
  expect(provider.cancelSignIn).toHaveBeenCalledExactlyOnceWith(attempt)
  expect(await controller.submitSignInCode(attempt, 'browser-code')).toBe(state)
  expect(provider.submitSignInCode).toHaveBeenCalledExactlyOnceWith(attempt, 'browser-code')
  expect(await controller.setDefault(account)).toBe(state)
  expect(provider.setDefault).toHaveBeenCalledExactlyOnceWith(account)
  expect(await controller.removeAccount(account)).toBe(state)
  expect(provider.remove).toHaveBeenCalledExactlyOnceWith(account)
  const failure = new Error('ai-account: no account account')
  provider.remove.mockRejectedValueOnce(failure)
  await expect(controller.removeAccount(account)).rejects.toBe(failure)
})

it('passes the subscriber lifetime to the provider and returns its stream', async () => {
  const { provider, controller } = fixture()
  const lifetime = new AbortController()
  const stream: AsyncIterable<AiAccountsView> = { async *[Symbol.asyncIterator]() { yield state } }
  provider.watch.mockReturnValue(stream)
  expect(controller.watch(lifetime.signal)).toBe(stream)
  expect(provider.watch).toHaveBeenCalledExactlyOnceWith(lifetime.signal)
})

it('streams status transitions emitted while subscribed, in order, until the lifetime ends', async () => {
  const { controller } = fixture()
  const ctx = roots[0]!
  const change = (status: AiAccountStatus): AiAccountStatusChange => ({
    id: 'account' as AiAccountId, kind: 'claude', isDefault: true, previous: 'unknown',
    current: { status, checkedAt: 1, message: null },
  })
  ctx.emit('ai-account/status-changed', change('signedIn'))
  const lifetime = new AbortController()
  const stream = controller.watchStatusChanges(lifetime.signal)[Symbol.asyncIterator]()
  const first = stream.next()
  // The generator subscribes on its first pull, so the pre-subscription emission is never replayed.
  await Promise.resolve()
  ctx.emit('ai-account/status-changed', change('signedOut'))
  ctx.emit('ai-account/status-changed', change('signedIn'))
  expect((await first).value).toEqual(change('signedOut'))
  expect((await stream.next()).value).toEqual(change('signedIn'))
  const pending = stream.next()
  lifetime.abort()
  expect(await pending).toEqual({ done: true, value: undefined })
  ctx.emit('ai-account/status-changed', change('signedOut'))
})
