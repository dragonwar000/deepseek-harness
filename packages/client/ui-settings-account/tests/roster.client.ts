/** The Web roster with this package's row restored: the shipped composition disables it, and these specs test the package itself. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ClientRoster, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'

const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
  name: string
  dsh: { client: { inject: string[] } }
}

/** Every shipped Web row plus `@deepseek-ai/dsh-client-ui-settings-account`, which the shipped Web App Bundle disables. */
export const accountRoster: ClientRoster = ClientRoster.of([
  ...webApp.rows,
  { name: manifest.name, inject: manifest.dsh.client.inject, immediately: false },
])
