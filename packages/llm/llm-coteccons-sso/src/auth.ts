/** pi-ai auth for a route whose every request carries an explicit bearer token. */
import type { PiAiAuthInjection } from '@deepseek-ai/dsh-llm-pi-ai'

/**
 * Empty credential store and ambient context. Every Coteccons request passes the SSO token as pi-ai's
 * highest-priority `apiKey` override, so pi-ai's stored logins and environment discovery must answer nothing.
 */
export const TOKEN_ONLY_AUTH: PiAiAuthInjection = {
  credentials: {
    read: () => Promise.resolve(undefined),
    list: () => Promise.resolve([]),
    modify: (_provider, mutate) => mutate(undefined),
    delete: () => Promise.resolve(),
  },
  authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) },
}
