/**
 * Which row of the shipped composition lets a user open Settings. The rebrand disabled
 * `ui-settings-account`, whose account menu used to carry the Settings item, and the
 * e2e helper kept clicking that menu on the Desktop face for a while afterwards. These
 * assertions pin the roster fact instead, so losing the remaining entry point fails here.
 */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { bundleRoster, WEB_PROFILE_BUNDLES } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/bundle-roster.ts'

/** The web-app bundle manifest the roster resolves its layers and plugin packages from. */
const ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The row that renders the sidebar-foot Settings trigger and registers the `settings.open` shortcut. */
const SETTINGS_TRIGGER = '@deepseek-ai/dsh-client-ui-settings-general'
/** The row that owns the account menu, and with it the only other Settings entry point. */
const ACCOUNT_MENU = '@deepseek-ai/dsh-client-ui-settings-account'
/** The row holding the settings surface the trigger opens. */
const SETTINGS_SURFACE = '@deepseek-ai/dsh-client-ui-settings'

/**
 * The shipped browser roster of one profile, read from the real bundle patches.
 * @param profile - the `dsh --profile` name the rows' `disabled` expressions see.
 * @returns the package names in composition order.
 */
function roster(profile: string): readonly string[] {
  const services: Readonly<Record<string, object | undefined>> = { profileContext: { name: profile } }
  return bundleRoster(WEB_PROFILE_BUNDLES, ANCHOR, {
    get: (name: string) => services[name],
    process: { platform: process.platform },
  }).rows.map(row => row.name)
}

it.each(['web', 'desktop'])('composes a Settings entry point for the shipped %s face', (profile) => {
  const rows = roster(profile)
  expect(rows.length).toBeGreaterThan(50)
  // Both the trigger and the surface it opens must ship, or Settings is unreachable.
  expect(rows).toContain(SETTINGS_SURFACE)
  expect(rows).toContain(SETTINGS_TRIGGER)
  // The account menu is the entry point the rebrand removed. While it stays out, the
  // sidebar-foot trigger is the one a user clicks; a test that drives the menu is stale.
  expect(rows).not.toContain(ACCOUNT_MENU)
})
