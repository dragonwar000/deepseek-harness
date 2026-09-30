// @vitest-environment jsdom
/** Coteccons SSO group registration, stream publication, commands, and default-model selection in the shipped client composition. */
import { expect, vi } from 'vitest'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createClientTest, type TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { CotecconsSsoSignInId, CotecconsSsoView } from '@deepseek-ai/dsh-coteccons-sso/types'
import type { CotecconsSsoGroupInjected } from '../src/client/CotecconsSsoGroup.tsx'
import { apply as hostApply, inject as hostInject } from '../src/index.ts'

const it = createClientTest({ roster: webApp })
const SELF = '@deepseek-ai/dsh-client-ui-settings-coteccons-sso'
const attemptId = 'attempt' as CotecconsSsoSignInId
const signedOut: CotecconsSsoView = { status: 'signed-out' }
const signingIn: CotecconsSsoView = { status: 'signing-in', attemptId, url: 'https://login.microsoftonline.com/authorize' }
const signedIn: CotecconsSsoView = { status: 'signed-in', account: { name: 'A', username: 'a@coteccons.vn', tenantId: 't' } }

function group(c: TestClient) {
  const entry = c.ctx.slots.entries('settings.ai-account.group').find(candidate => candidate.options.id === 'coteccons')
  if (entry === undefined) throw new Error('Coteccons SSO group is not registered')
  const injected: object = entry.inject!()
  return { entry, operations: injected as CotecconsSsoGroupInjected }
}

it('registers the group first on the AI Account page and publishes every stream snapshot', async ({ start }) => {
  const c = await start()
  const { entry, operations } = group(c)
  expect(entry.options.order).toBe(0)
  await vi.waitFor(() => { expect(operations.hooks.sso.getSnapshot()).toEqual({ view: signedOut, failed: false }) })
  const listener = vi.fn()
  const off = operations.hooks.sso.subscribe(listener)
  c.mock.streams.push('cotecconsSso/watch', { status: 'not-configured', missing: ['clientId'] })
  await vi.waitFor(() => { expect(operations.hooks.sso.getSnapshot().view).toEqual({ status: 'not-configured', missing: ['clientId'] }) })
  expect(listener).toHaveBeenCalled()
  off()
  await c.unload(SELF)
  expect(c.ctx.slots.entries('settings.ai-account.group').some(candidate => candidate.options.id === 'coteccons')).toBe(false)
}, 60_000)

it('forwards commands, publishes their snapshots, and selects the Coteccons default model after a completed sign-in', async ({ start, mock }) => {
  const c = await start()
  const { operations } = group(c)
  await vi.waitFor(() => { expect(operations.hooks.sso.getSnapshot().view).toEqual(signedOut) })
  mock.remote.cotecconsSso.startSignIn.mockResolvedValue(ok(signingIn))
  await operations.startSignIn()
  expect(operations.hooks.sso.getSnapshot().view).toEqual(signingIn)
  mock.remote.session.initializeDefaultModel.mockResolvedValue(ok(undefined))
  c.mock.streams.push('cotecconsSso/watch', signedIn)
  await vi.waitFor(() => { expect(mock.remote.session.initializeDefaultModel).toHaveBeenCalledExactlyOnceWith('coteccons') })
  mock.remote.cotecconsSso.signOut.mockResolvedValue(ok(signedOut))
  await operations.signOut()
  expect(operations.hooks.sso.getSnapshot().view).toEqual(signedOut)
  mock.remote.cotecconsSso.cancelSignIn.mockResolvedValue(ok(signedOut))
  await operations.cancelSignIn(attemptId)
  expect(mock.remote.cotecconsSso.cancelSignIn).toHaveBeenCalledWith(attemptId)
  const failure = { ok: false as const, error: new RemoteError('gateway/internal', 'offline', {}) }
  mock.remote.cotecconsSso.signOut.mockResolvedValueOnce(failure)
  await expect(operations.signOut()).rejects.toBe(failure.error)
  expect(mock.remote.session.initializeDefaultModel).toHaveBeenCalledOnce()
}, 60_000)

it('logs a refused or failed default-model selection without failing the sign-in', async ({ start, mock }) => {
  const c = await start()
  const { operations } = group(c)
  await vi.waitFor(() => { expect(operations.hooks.sso.getSnapshot().view).toEqual(signedOut) })
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  mock.remote.cotecconsSso.startSignIn.mockResolvedValue(ok(signingIn))
  mock.remote.session.initializeDefaultModel
    .mockResolvedValueOnce({ ok: false, error: new RemoteError('session/provider-models-unavailable', 'none', { provider: 'coteccons' }) })
    .mockRejectedValueOnce(new Error('socket closed'))
  await operations.startSignIn()
  c.mock.streams.push('cotecconsSso/watch', signedIn)
  await vi.waitFor(() => {
    expect(info).toHaveBeenCalledWith('[coteccons-sso] default model selection failed', { reason: 'session/provider-models-unavailable' })
  })
  await operations.startSignIn()
  c.mock.streams.push('cotecconsSso/watch', signedIn)
  await vi.waitFor(() => { expect(info).toHaveBeenCalledWith('[coteccons-sso] default model selection failed', { reason: 'gateway/internal' }) })
  expect(operations.hooks.sso.getSnapshot().view).toEqual(signedIn)
  info.mockRestore()
}, 60_000)

it('keeps the last snapshot and reports the loss when the Host ends the stream; the Host half registers nothing', async ({ start }) => {
  expect(hostInject).toEqual(['slots', 'locale'])
  expect(hostApply).not.toThrow()
  const c = await start()
  const { operations } = group(c)
  c.mock.streams.push('cotecconsSso/watch', signedIn)
  await vi.waitFor(() => { expect(operations.hooks.sso.getSnapshot().view).toEqual(signedIn) })
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  c.mock.streams.end('cotecconsSso/watch')
  await vi.waitFor(() => { expect(operations.hooks.sso.getSnapshot()).toEqual({ view: signedIn, failed: true }) })
  expect(info).toHaveBeenCalledWith('[coteccons-sso] sign-in stream stopped', expect.objectContaining({ message: 'coteccons sso stream ended' }))
  info.mockRestore()
}, 60_000)
