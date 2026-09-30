/**
 * MSAL process edges shared by the main sign-in and the Microsoft 365 connectors: cancellation, loopback release,
 * error labels, and snapshot streams.
 */
import type {
  AccountInfo, AuthenticationResult, InteractiveRequest, SilentFlowRequest,
} from '@azure/msal-node'

/** The MSAL operations this provider uses; tests substitute a fake. */
export interface MsalClient {
  acquireTokenInteractive(request: InteractiveRequest): Promise<AuthenticationResult>
  acquireTokenSilent(request: SilentFlowRequest): Promise<AuthenticationResult>
  getAllAccounts(): Promise<AccountInfo[]>
  getTokenCache(): { removeAccount(account: AccountInfo): Promise<void> }
}

/**
 * Describe a caught failure for the Host log without its payload.
 * @param error - caught value.
 * @returns the error name and code, never token material.
 */
export function failureLabel(error: unknown): string {
  if (!(error instanceof Error)) return typeof error
  const code = (error as { errorCode?: unknown }).errorCode
  return typeof code === 'string' ? `${error.name}: ${code}` : error.name
}

/**
 * Race an operation against caller cancellation.
 * @param operation - pending operation.
 * @param signal - caller cancellation.
 * @returns the operation's result.
 */
export async function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation
  signal.throwIfAborted()
  let stop: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => { reject(signal.reason as Error) }
    signal.addEventListener('abort', stop, { once: true })
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    signal.removeEventListener('abort', stop as () => void)
  }
}

/**
 * Deliver an OAuth error to MSAL's loopback listener so an abandoned interactive request settles and closes it.
 * @param redirectUri - loopback redirect URI of the pending request.
 */
export async function releaseLoopback(redirectUri: string): Promise<void> {
  const target = new URL(redirectUri)
  if (target.hostname === 'localhost') target.hostname = '127.0.0.1'
  target.pathname = '/'
  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'error=access_denied&error_description=cancelled',
    })
    await response.body?.cancel()
  } catch (error) {
    console.info('[coteccons-sso] loopback release failed', { error: failureLabel(error) })
  }
}

/**
 * Yield complete snapshots, starting with the current one, until the subscriber leaves or the source closes.
 * @param listeners - change listeners the source calls after every commit.
 * @param closed - whether the source has been disposed.
 * @param snapshot - current snapshot.
 * @param signal - subscription lifetime.
 * @returns snapshots as the state changes.
 */
/* jscpd:ignore-start -- the coalescing snapshot stream follows the account providers' shared watch semantics
   (one snapshot per burst of changes, ended by close or abort) that each provider's listener set owns. */
export async function* watchSnapshots<T>(
  listeners: Set<() => void>, closed: () => boolean, snapshot: () => T, signal: AbortSignal,
): AsyncIterable<T> {
  let dirty = true
  let wake: (() => void) | undefined
  const changed = (): void => { dirty = true; wake?.() }
  listeners.add(changed)
  signal.addEventListener('abort', changed, { once: true })
  try {
    while (!closed() && !signal.aborted) {
      if (dirty) {
        dirty = false
        yield snapshot()
        continue
      }
      await new Promise<void>((resolve) => { wake = resolve })
    }
  } finally {
    listeners.delete(changed)
    signal.removeEventListener('abort', changed)
  }
}
/* jscpd:ignore-end */
