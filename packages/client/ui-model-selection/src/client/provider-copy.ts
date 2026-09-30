/** Locale-owned display copy for the provider routes that need more than their adapter's own name. */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** What a provider group shows: its label, and a note it must state where the user picks it. */
export interface ProviderCopy {
  /** Localized group label, or `undefined` to use the route's own `LlmProviderInfo.name`. */
  readonly label: string | undefined
  /** A statement the route must make at the point of choice, or `undefined` when it needs none. */
  readonly note: string | undefined
}

/**
 * Resolve the localized copy for one provider route.
 *
 * Provider ids are matched literally because the catalog carries no capability flags: a route's
 * billing and transport are facts about that route id, and the picker is where a person needs them
 * stated. `claude-cli` says both because neither is guessable from a model name.
 * @param id - the provider route id from the catalog.
 * @param t - the `model` namespace translator.
 * @returns the label to show and the note to state, either of which may be absent.
 */
export function providerCopy(id: string, t: TranslateNS<'model'>): ProviderCopy {
  if (id === 'deepseek-account') return { label: t('provider.account'), note: undefined }
  if (id === 'claude-cli') return { label: t('provider.claudeCli'), note: t('provider.claudeCli.note') }
  return { label: undefined, note: undefined }
}
