/** Forwards AI Account sign-outs to the Electron shell, which owns the operating-system notification. */
import type { Context } from '@deepseek-ai/cordis'
import type { AiAccountKind } from '@deepseek-ai/dsh-ai-account/types'

/**
 * Publish each transition of a registered AI Account into `signedOut`.
 * A check that confirms an already signed-out account emits no event, and a transition into
 * `signedIn` or `unknown` is not forwarded, so the shell receives one message per sign-out.
 * @param ctx - Booted Desktop profile context; its disposal removes the listener.
 * @param publish - Synchronous private IPC delivery of the signed-out account's kind.
 */
export function installAiAccountSignedOutPublisher(ctx: Context, publish: (kind: AiAccountKind) => void): void {
  ctx.on('ai-account/status-changed', (change) => {
    if (change.current.status === 'signedOut' && change.previous !== 'signedOut') publish(change.kind)
  })
}
