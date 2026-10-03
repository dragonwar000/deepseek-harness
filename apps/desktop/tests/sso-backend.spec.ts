/** Native Coteccons SSO operations project token-free state and follow the Host stream. */
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { expect, it, onTestFinished, vi } from 'vitest'
import { desktopSsoBackend, ssoView } from '../src/sso-backend.ts'

it('projects only declared sign-in fields and refuses non-HTTPS sign-in links', () => {
  expect(ssoView({ status: 'signed-out', token: 'not-for-the-renderer' })).toEqual({ status: 'signed-out' })
  expect(ssoView({ status: 'not-configured', missing: ['tenantId'] })).toEqual({ status: 'not-configured', missing: ['tenantId'] })
  expect(ssoView({ status: 'signing-in', attemptId: 'a', url: null, verifier: 'private' })).toEqual({ status: 'signing-in', attemptId: 'a', url: null })
  expect(ssoView({ status: 'signing-in', attemptId: 'a', url: 'https://login.microsoftonline.com/t/authorize' }))
    .toEqual({ status: 'signing-in', attemptId: 'a', url: 'https://login.microsoftonline.com/t/authorize' })
  expect(ssoView({ status: 'signed-in', account: { name: null, username: 'a@coteccons.vn', tenantId: 't', idToken: 'private' } }))
    .toEqual({ status: 'signed-in', account: { name: null, username: 'a@coteccons.vn', tenantId: 't' } })
  expect(ssoView({ status: 'error', errorCode: 'session-expired' })).toEqual({ status: 'error', errorCode: 'session-expired' })
  for (const url of ['file:///tmp/example', 'javascript:alert(1)', 'http://login.microsoftonline.com/', 'https://user:pass@example.com/']) {
    expect(() => ssoView({ status: 'signing-in', attemptId: 'a', url })).toThrow()
  }
  for (const value of [null, [], { status: 'unknown' }, { status: 'not-configured', missing: ['secret'] }, { status: 'signing-in', attemptId: 1, url: null },
    { status: 'signed-in', account: { name: 1, username: 'a', tenantId: 't' } }, { status: 'signed-in' }, { status: 'error', errorCode: 'raw-server-message' }]) {
    expect(() => ssoView(value)).toThrow()
  }
})

it('uses cotecconsSso Remote commands and selects the Coteccons default model', async () => {
  const requests: unknown[] = []
  const backend = desktopSsoBackend('http://127.0.0.1:1234', (request) => {
    requests.push(request)
    return Promise.resolve({ status: 'signed-out', token: 'private' })
  }, () => Promise.resolve(''))
  expect(await backend.state()).toEqual({ status: 'signed-out' })
  expect(await backend.start()).toEqual({ status: 'signed-out' })
  expect(await backend.cancel('attempt' as never)).toEqual({ status: 'signed-out' })
  expect(await backend.signOut()).toEqual({ status: 'signed-out' })
  await backend.selectDefaultModel()
  expect(requests).toEqual([
    { namespace: 'cotecconsSso', method: 'getState', args: {} },
    { namespace: 'cotecconsSso', method: 'startSignIn', args: {} },
    { namespace: 'cotecconsSso', method: 'cancelSignIn', args: { attemptId: 'attempt' } },
    { namespace: 'cotecconsSso', method: 'signOut', args: {} },
    { namespace: 'session', method: 'initializeDefaultModel', args: { provider: 'coteccons' } },
  ])
})

it('follows the sign-in stream and reconnects after the socket closes', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  onTestFinished(async () => {
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('missing server address')
  const received: unknown[] = []
  const failed = vi.fn()
  const backend = desktopSsoBackend(`http://127.0.0.1:${address.port}`, () => Promise.resolve({}), () => Promise.resolve('session=1'))
  const connected = once(server, 'connection')
  const stop = backend.watch((value) => { received.push(value) }, failed)
  onTestFinished(stop)
  const [socket, request] = await connected as [import('ws').WebSocket, import('node:http').IncomingMessage]
  expect(request.headers.cookie).toBe('session=1')
  const [data] = await once(socket, 'message') as [Buffer]
  const frame = JSON.parse(data.toString('utf8')) as { endpoint: string; streamId: string }
  expect(frame.endpoint).toBe('cotecconsSso/watch')
  socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { status: 'signing-in', attemptId: 'a', url: null } }))
  await vi.waitFor(() => { expect(received).toEqual([{ status: 'signing-in', attemptId: 'a', url: null }]) })
  const reconnected = once(server, 'connection')
  socket.send(JSON.stringify({ type: 'item', streamId: 'other', value: { status: 'signed-out' } }))
  await vi.waitFor(() => { expect(failed).toHaveBeenCalledOnce() })
  const [next] = await reconnected as [import('ws').WebSocket]
  const [reopened] = await once(next, 'message') as [Buffer]
  const reframe = JSON.parse(reopened.toString('utf8')) as { streamId: string }
  next.send(JSON.stringify({ type: 'end', streamId: reframe.streamId }))
  await vi.waitFor(() => { expect(failed).toHaveBeenCalledTimes(2) })
  stop()
  expect(received).toHaveLength(1)
})

it('retries when the session cookie cannot be read and stops after disposal', async () => {
  vi.useFakeTimers()
  try {
    const cookies = vi.fn(() => Promise.reject(new Error('no cookie store')))
    const failed = vi.fn()
    const stop = desktopSsoBackend('http://127.0.0.1:9', () => Promise.resolve({}), cookies).watch(vi.fn(), failed)
    await vi.waitFor(() => { expect(failed).toHaveBeenCalledOnce() })
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => { expect(cookies).toHaveBeenCalledTimes(2) })
    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(cookies).toHaveBeenCalledTimes(2)
  } finally { vi.useRealTimers() }
})

it('carries the Desktop analytics collection policy beside the sign-in stream', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  onTestFinished(async () => {
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('missing server address')
  const connected = once(server, 'connection')
  const onAnalyticsEnabledChanged = vi.fn()
  const received = vi.fn()
  const backend = desktopSsoBackend(`http://127.0.0.1:${address.port}`, () => Promise.resolve({}), () => Promise.resolve(''))
  const stop = backend.watch(received, vi.fn(), onAnalyticsEnabledChanged)
  onTestFinished(stop)
  const [socket] = await connected as [import('ws').WebSocket]
  // Logical streams share the socket; observe both opening frames before sending data.
  const streams = new Map<string, string>()
  const opened = Promise.withResolvers<undefined>()
  socket.on('message', (data) => {
    if (!Buffer.isBuffer(data)) throw new Error('expected a Buffer WebSocket frame')
    const frame = JSON.parse(data.toString('utf8')) as { endpoint: string; streamId: string }
    streams.set(frame.endpoint, frame.streamId)
    if (streams.size === 2) opened.resolve(undefined)
  })
  await opened.promise
  socket.send(JSON.stringify({ type: 'item', streamId: streams.get('productAnalytics/watchPolicy'), value: true }))
  await vi.waitFor(() => { expect(onAnalyticsEnabledChanged).toHaveBeenLastCalledWith(true) })
  socket.send(JSON.stringify({ type: 'item', streamId: streams.get('productAnalytics/watchPolicy'), value: 'invalid policy' }))
  await vi.waitFor(() => { expect(onAnalyticsEnabledChanged).toHaveBeenLastCalledWith(false) })
  socket.send(JSON.stringify({ type: 'item', streamId: streams.get('cotecconsSso/watch'), value: { status: 'signed-out' } }))
  await vi.waitFor(() => { expect(received).toHaveBeenCalledWith({ status: 'signed-out' }) })
  onAnalyticsEnabledChanged.mockClear()
  stop()
  expect(onAnalyticsEnabledChanged).toHaveBeenCalledExactlyOnceWith(false)
})
