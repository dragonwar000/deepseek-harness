/**
 * AI Account page extension slot. The AI Account section declares it at
 * runtime and renders its entries above the Claude and ChatGPT groups, so an
 * account feature that owns its own service and copy (Coteccons SSO) adds its
 * group to this page without the page depending on it. The type lives with its
 * declarer, the same way `settings.models.sign-in` does.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * One account group per list entry, rendered in `order` before the
     * official-CLI groups. Options: `id` (group key) and `order`. An entry
     * draws its own heading, copy, state, and commands; without a registrant
     * the area renders nothing.
     */
    'settings.ai-account.group': { kind: 'list'; scope: 'root'; owner: AiAccountGroupOwnerProps }
  }
}

/** Owner share of an AI Account group (the page supplies nothing). */
export interface AiAccountGroupOwnerProps {
  /** Marker field: group owner props are intentionally empty. */
  children?: never
}
