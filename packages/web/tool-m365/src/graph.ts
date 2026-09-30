/**
 * Microsoft Graph requests made with one Microsoft 365 connector's delegated token. Graph trims every answer to
 * what the signed-in user may read, so this module adds no permission logic of its own. Credential-bearing
 * requests refuse redirects; a file download follows Graph's redirect to its pre-authenticated URL without the
 * `Authorization` header.
 */
import type { M365ConnectorId } from '@deepseek-ai/dsh-coteccons-sso'

/** Graph v1.0 endpoint; a protocol constant, not a deployment choice. */
export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0'

/** A Graph request that failed with an HTTP status the model can act on. */
export class GraphError extends Error {
  /**
   * @param status - HTTP status Graph returned.
   * @param code - Graph error code, when the body names one.
   * @param message - human-readable reason.
   */
  constructor(readonly status: number, readonly code: string | undefined, message: string) {
    super(message)
    this.name = 'GraphError'
  }
}

/** Settings and token source one Graph call needs. */
export interface GraphRequester {
  /** Return a current bearer token for the connector. */
  token(connector: M365ConnectorId, signal: AbortSignal): Promise<string>
  /** Retries for 429 and 503 responses, honoring `Retry-After`. */
  readonly maxRetries: number
  /** Replaceable fetch; tests substitute a fake server. */
  readonly fetch: typeof fetch
}

/**
 * Wait for `ms` milliseconds or reject when the signal aborts.
 * @param ms - delay.
 * @param signal - caller cancellation.
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const stop = (): void => { clearTimeout(timer); reject(signal.reason as Error) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    signal.addEventListener('abort', stop, { once: true })
  })
}

/**
 * Read the retry delay Graph asked for.
 * @param response - throttled response.
 * @param attempt - zero-based retry number.
 * @returns milliseconds to wait, capped at 30 seconds.
 */
function retryAfterMs(response: Response, attempt: number): number {
  const header = Number(response.headers.get('retry-after'))
  const seconds = Number.isFinite(header) && header > 0 ? header : 2 ** attempt
  return Math.min(seconds, 30) * 1000
}

/**
 * Build a {@link GraphError} from a failed response without echoing request data.
 * @param response - failed response.
 * @returns the error to throw.
 */
async function failure(response: Response): Promise<GraphError> {
  let code: string | undefined
  let message = `Microsoft Graph returned HTTP ${response.status}`
  try {
    const body = await response.json() as { error?: { code?: unknown; message?: unknown } }
    if (typeof body.error?.code === 'string') code = body.error.code
    if (typeof body.error?.message === 'string' && body.error.message.length > 0) message = `${message}: ${body.error.message}`
  } catch (_unparsable: unknown) {
    // A non-JSON error body carries no Graph code; the status alone describes the failure.
  }
  if (response.status === 403) message = `You do not have permission to read this item in Microsoft 365 (${message}).`
  if (response.status === 404) message = `The item was not found or you cannot access it (${message}).`
  return new GraphError(response.status, code, message)
}

/**
 * Send one authorized Graph request, retrying throttling responses.
 * @param requester - token source, retry budget, and fetch.
 * @param connector - connector whose token authorizes the request.
 * @param path - path below {@link GRAPH_BASE_URL}, with query.
 * @param init - method, body, and extra headers.
 * @param signal - caller cancellation.
 * @returns the successful response; a 3xx response is returned only when `init.redirect` is `manual`.
 */
export async function graphRequest(
  requester: GraphRequester, connector: M365ConnectorId, path: string,
  init: { method?: string; body?: string; headers?: Record<string, string>; redirect?: 'manual' }, signal: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const token = await requester.token(connector, signal)
    const response = await requester.fetch(`${GRAPH_BASE_URL}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...init.body === undefined ? {} : { 'content-type': 'application/json' },
        ...init.headers,
      },
      ...init.body === undefined ? {} : { body: init.body },
      redirect: init.redirect ?? 'error',
      signal,
    })
    if ((response.status === 429 || response.status === 503) && attempt < requester.maxRetries) {
      await response.body?.cancel()
      await delay(retryAfterMs(response, attempt), signal)
      continue
    }
    if (response.ok || (init.redirect === 'manual' && response.status >= 300 && response.status < 400)) return response
    throw await failure(response)
  }
}

/**
 * Send one Graph request and parse its JSON body.
 * @param requester - token source, retry budget, and fetch.
 * @param connector - connector whose token authorizes the request.
 * @param path - path below {@link GRAPH_BASE_URL}, with query.
 * @param signal - caller cancellation.
 * @param init - method, JSON body, and extra headers.
 * @returns the parsed body.
 */
export async function graphJson(
  requester: GraphRequester, connector: M365ConnectorId, path: string, signal: AbortSignal,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<unknown> {
  const response = await graphRequest(requester, connector, path, {
    ...init.method === undefined ? {} : { method: init.method },
    ...init.body === undefined ? {} : { body: JSON.stringify(init.body) },
    ...init.headers === undefined ? {} : { headers: init.headers },
  }, signal)
  return response.json() as Promise<unknown>
}

/**
 * Download a drive item's bytes, up to a byte cap. Graph answers `/content` with a redirect to a
 * pre-authenticated URL, which is fetched without the bearer token.
 * @param requester - token source, retry budget, and fetch.
 * @param path - `/drives/{drive}/items/{item}/content` path.
 * @param maxBytes - largest download accepted.
 * @param signal - caller cancellation.
 * @returns the bytes, or `undefined` when the file exceeds `maxBytes`.
 */
export async function graphDownload(
  requester: GraphRequester, path: string, maxBytes: number, signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  let response = await graphRequest(requester, 'files', path, { redirect: 'manual' }, signal)
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (location === null || !location.startsWith('https://')) throw new GraphError(response.status, undefined, 'Microsoft Graph returned an unusable download location.')
    response = await requester.fetch(location, { redirect: 'follow', signal })
    if (!response.ok) throw await failure(response)
  }
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel()
    return undefined
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  return bytes.byteLength > maxBytes ? undefined : bytes
}
