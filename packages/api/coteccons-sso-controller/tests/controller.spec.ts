/** Coteccons SSO Remote delegation preserves provider results, failures, and stream lifetime, and never exposes tokens. */
import { Context } from '@deepseek-ai/cordis'
import type { CotecconsSso } from '@deepseek-ai/dsh-coteccons-sso'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, vi } from 'vitest'
import type { CotecconsSsoSignInId, CotecconsSsoView } from '../src/types.ts'
import CotecconsSsoController from '../src/index.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })
const state: CotecconsSsoView = { status: 'signed-out' }

function fixture() {
  const ctx = new Context()
  roots.push(ctx)
  const provider = {
    getState: vi.fn<CotecconsSso['getState']>().mockResolvedValue(state),
    startSignIn: vi.fn<CotecconsSso['startSignIn']>().mockResolvedValue(state),
    cancelSignIn: vi.fn<CotecconsSso['cancelSignIn']>().mockResolvedValue(state),
    signOut: vi.fn<CotecconsSso['signOut']>().mockResolvedValue(state),
    watch: vi.fn<CotecconsSso['watch']>(),
  }
  ctx.provide('cotecconsSso', provider as never)
  return { provider, controller: new CotecconsSsoController(ctx) }
}

it('delegates every command to the provider and returns its snapshot', async () => {
  const { provider, controller } = fixture()
  const attempt = 'attempt' as CotecconsSsoSignInId
  expect(await controller.getState()).toBe(state)
  expect(await controller.startSignIn()).toBe(state)
  expect(provider.startSignIn).toHaveBeenCalledOnce()
  expect(await controller.cancelSignIn(attempt)).toBe(state)
  expect(provider.cancelSignIn).toHaveBeenCalledExactlyOnceWith(attempt)
  const failure = new Error('coteccons-sso: store locked')
  provider.signOut.mockRejectedValueOnce(failure)
  await expect(controller.signOut()).rejects.toBe(failure)
  expect(await controller.signOut()).toBe(state)
})

it('passes the subscriber lifetime to the provider and returns its stream', () => {
  const { provider, controller } = fixture()
  const lifetime = new AbortController()
  const stream: AsyncIterable<CotecconsSsoView> = { async *[Symbol.asyncIterator]() { yield state } }
  provider.watch.mockReturnValue(stream)
  expect(controller.watch(lifetime.signal)).toBe(stream)
  expect(provider.watch).toHaveBeenCalledExactlyOnceWith(lifetime.signal)
})

it('publishes no token operation', () => {
  const { controller } = fixture()
  expect(controller.typertRemote.namespace).toBe('cotecconsSso')
  expect(remoteMethods(controller).map(marker => marker.method).sort()).toEqual(['cancelSignIn', 'getState', 'signOut', 'startSignIn', 'watch'])
})
