/** Native Coteccons SSO commands and Gateway state stream; no renderer receives tokens. */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { parseRemoteStreamServerMessage, REMOTE_STREAM_MUX_PATH } from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import type { CotecconsSsoError, CotecconsSsoSetting, CotecconsSsoSignInId, CotecconsSsoView } from '@deepseek-ai/dsh-coteccons-sso/types'

/** Authenticated unary caller shared with native onboarding. */
export type SsoInvoke = (request: { namespace: string; method: string; args: Record<string, unknown> }) => Promise<unknown>

const SETTINGS: readonly string[] = ['tenantId', 'clientId'] satisfies readonly CotecconsSsoSetting[]
const ERRORS: readonly string[] = ['sign-in-failed', 'timeout', 'domain-not-allowed', 'session-expired'] satisfies readonly CotecconsSsoError[]

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Only HTTPS destinations can leave the native app as a sign-in link. */
function validateBrowserDestination(value: string): void {
  const url = new URL(value)
  if (url.username || url.password || url.protocol !== 'https:') throw new Error('desktop sso: invalid browser destination')
}

/**
 * Decode the token-free sign-in state received across HTTP or WebSocket.
 * @param value - wire value.
 * @returns the sign-in projection with only its declared fields.
 */
export function ssoView(value: unknown): CotecconsSsoView {
  if (!record(value)) throw new Error('desktop sso: invalid state')
  switch (value.status) {
    case 'not-configured': {
      const missing = value.missing
      if (!Array.isArray(missing) || !missing.every(item => typeof item === 'string' && SETTINGS.includes(item))) {
        throw new Error('desktop sso: invalid missing settings')
      }
      return { status: 'not-configured', missing: missing as CotecconsSsoSetting[] }
    }
    case 'signed-out':
      return { status: 'signed-out' }
    case 'signing-in': {
      const { attemptId, url } = value
      if (typeof attemptId !== 'string' || (url !== null && typeof url !== 'string')) throw new Error('desktop sso: invalid attempt')
      if (url !== null) validateBrowserDestination(url)
      return { status: 'signing-in', attemptId: attemptId as CotecconsSsoSignInId, url }
    }
    case 'signed-in': {
      const account = value.account
      if (!record(account) || (account.name !== null && typeof account.name !== 'string')
        || typeof account.username !== 'string' || typeof account.tenantId !== 'string') {
        throw new Error('desktop sso: invalid account')
      }
      return { status: 'signed-in', account: { name: account.name, username: account.username, tenantId: account.tenantId } }
    }
    case 'error': {
      const errorCode = value.errorCode
      if (typeof errorCode !== 'string' || !ERRORS.includes(errorCode)) throw new Error('desktop sso: invalid error')
      return { status: 'error', errorCode: errorCode as CotecconsSsoError }
    }
    default:
      throw new Error('desktop sso: invalid state')
  }
}

/** Native Coteccons SSO operations and explicitly owned stream lifetime. */
export interface DesktopSsoBackend {
  /** @returns current sign-in snapshot. */
  state(): Promise<CotecconsSsoView>
  /** @returns the snapshot after a new or already-running sign-in attempt starts. */
  start(): Promise<CotecconsSsoView>
  /** @param id - attempt to cancel. @returns the snapshot after the attempt settles. */
  cancel(id: CotecconsSsoSignInId): Promise<CotecconsSsoView>
  /** @returns the signed-out snapshot. */
  signOut(): Promise<CotecconsSsoView>
  /** Make the first Coteccons model the Agent default after a completed sign-in. */
  selectDefaultModel(): Promise<void>
  /**
   * @param listener - state recipient.
   * @param failed - stream failure recipient; the stream reconnects after it.
   * @returns stream disposer.
   */
  watch(listener: (state: CotecconsSsoView) => void, failed: () => void): () => void
}

/**
 * Connect native Coteccons SSO operations to the standard authenticated Web backend.
 * @param origin - Host Web origin.
 * @param invoke - validated unary RPC caller.
 * @param cookies - Electron session cookie reader.
 * @returns sign-in operations; watch callers own their subscriptions.
 */
export function desktopSsoBackend(origin: string, invoke: SsoInvoke, cookies: () => Promise<string>): DesktopSsoBackend {
  const call = async (method: string, args: Record<string, unknown> = {}): Promise<CotecconsSsoView> =>
    ssoView(await invoke({ namespace: 'cotecconsSso', method, args }))
  return {
    state: () => call('getState'),
    start: () => call('startSignIn'),
    cancel: attemptId => call('cancelSignIn', { attemptId }),
    signOut: () => call('signOut'),
    async selectDefaultModel() {
      await invoke({ namespace: 'session', method: 'initializeDefaultModel', args: { provider: 'coteccons' } })
    },
    watch(listener, failed) {
      let closed = false
      let socket: WebSocket | undefined
      let retry: ReturnType<typeof setTimeout> | undefined
      const reconnect = (): void => { if (!closed) { failed(); retry = setTimeout(connect, 1000) } }
      function connect(): void {
        const streamId = randomUUID()
        void cookies().then((cookie) => {
          if (closed) return
          const url = new URL(REMOTE_STREAM_MUX_PATH, origin)
          url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
          socket = new WebSocket(url, { headers: { cookie, origin }, maxPayload: 65_536 })
          socket.on('open', () => {
            socket?.send(JSON.stringify({ type: 'open', streamId, endpoint: 'cotecconsSso/watch', payload: { args: {} } }))
          })
          socket.on('message', (data) => {
            try {
              const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
              const frame = parseRemoteStreamServerMessage(bytes.toString('utf8'))
              if (frame.streamId !== streamId) throw new Error('desktop sso: unexpected stream')
              if (frame.type === 'item') listener(ssoView(frame.value))
              else socket?.close()
            } catch { socket?.close() }
          })
          socket.on('error', () => { socket?.close() })
          socket.on('close', reconnect)
        }).catch(reconnect)
      }
      connect()
      return () => { closed = true; clearTimeout(retry); socket?.close() }
    },
  }
}
