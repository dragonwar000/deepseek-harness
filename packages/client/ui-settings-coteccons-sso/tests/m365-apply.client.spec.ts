// @vitest-environment jsdom
/** Microsoft 365 group registration, stream publication, and connector commands in the shipped client composition. */
import { expect, vi } from 'vitest'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createClientTest, type TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { M365ConnectAttemptId, M365ConnectorView } from '@deepseek-ai/dsh-coteccons-sso/types'
import type { M365GroupInjected } from '../src/client/M365Group.tsx'

const it = createClientTest({ roster: webApp })
const SELF = '@deepseek-ai/dsh-client-ui-settings-coteccons-sso'
const attemptId = 'attempt' as M365ConnectAttemptId
const disconnected: readonly M365ConnectorView[] = [
  { id: 'mail', status: 'disconnected' }, { id: 'chat', status: 'disconnected' }, { id: 'files', status: 'disconnected' },
]
const connecting: readonly M365ConnectorView[] = [
  { id: 'mail', status: 'connecting', attemptId, url: 'https://login.microsoftonline.com/authorize' }, ...disconnected.slice(1),
]
const connected: readonly M365ConnectorView[] = [{ id: 'mail', status: 'connected', username: 'a@coteccons.vn' }, ...disconnected.slice(1)]

function group(c: TestClient) {
  const entry = c.ctx.slots.entries('settings.ai-account.group').find(candidate => candidate.options.id === 'coteccons-m365')
  if (entry === undefined) throw new Error('Microsoft 365 group is not registered')
  const injected: object = entry.inject!()
  return { entry, operations: injected as M365GroupInjected }
}

it('registers the group after the sign-in group and publishes every stream snapshot to subscribers', async ({ start }) => {
  const c = await start()
  const { entry, operations } = group(c)
  expect(entry.options.order).toBe(1)
  await vi.waitFor(() => { expect(operations.hooks.m365.getSnapshot()).toEqual({ connectors: disconnected, failed: false }) })
  const listener = vi.fn()
  const off = operations.hooks.m365.subscribe(listener)
  c.mock.streams.push('cotecconsSso/watchM365', connected)
  await vi.waitFor(() => { expect(operations.hooks.m365.getSnapshot().connectors).toEqual(connected) })
  expect(listener).toHaveBeenCalled()
  off()
  await c.unload(SELF)
  expect(c.ctx.slots.entries('settings.ai-account.group').some(candidate => candidate.options.id === 'coteccons-m365')).toBe(false)
}, 60_000)

it('forwards connector commands, publishes their snapshots, and rejects a refused command', async ({ start, mock }) => {
  const c = await start()
  const { operations } = group(c)
  await vi.waitFor(() => { expect(operations.hooks.m365.getSnapshot().connectors).toEqual(disconnected) })
  mock.remote.cotecconsSso.connectM365.mockResolvedValue(ok(connecting))
  await operations.connect('mail')
  expect(mock.remote.cotecconsSso.connectM365).toHaveBeenCalledWith('mail')
  expect(operations.hooks.m365.getSnapshot().connectors).toEqual(connecting)
  mock.remote.cotecconsSso.cancelM365Connect.mockResolvedValue(ok(disconnected))
  await operations.cancel('mail', attemptId)
  expect(mock.remote.cotecconsSso.cancelM365Connect).toHaveBeenCalledWith('mail', attemptId)
  expect(operations.hooks.m365.getSnapshot().connectors).toEqual(disconnected)
  const failure = { ok: false as const, error: new RemoteError('gateway/internal', 'offline', {}) }
  mock.remote.cotecconsSso.disconnectM365.mockResolvedValueOnce(failure)
  await expect(operations.disconnect('mail')).rejects.toBe(failure.error)
  mock.remote.cotecconsSso.disconnectM365.mockResolvedValueOnce(ok(disconnected))
  await operations.disconnect('mail')
  expect(mock.remote.cotecconsSso.disconnectM365).toHaveBeenLastCalledWith('mail')
}, 60_000)

it('keeps the last connector snapshot and reports the loss when the Host ends the stream', async ({ start }) => {
  const c = await start()
  const { operations } = group(c)
  c.mock.streams.push('cotecconsSso/watchM365', connected)
  await vi.waitFor(() => { expect(operations.hooks.m365.getSnapshot().connectors).toEqual(connected) })
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  c.mock.streams.end('cotecconsSso/watchM365')
  await vi.waitFor(() => { expect(operations.hooks.m365.getSnapshot()).toEqual({ connectors: connected, failed: true }) })
  expect(info).toHaveBeenCalledWith('[coteccons-sso] Microsoft 365 stream stopped', expect.objectContaining({ message: 'microsoft 365 stream ended' }))
  info.mockRestore()
}, 60_000)
