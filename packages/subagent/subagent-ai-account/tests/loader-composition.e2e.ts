/** Public Loader composition of the AI Account provider Bundle over the headless profile. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const PROCESS_TIMEOUT_MS = 60_000
const fixtureDir = fileURLToPath(new URL('./fixtures/loader/', import.meta.url))
const driver = join(fixtureDir, 'driver.ts')
const configPath = join(fixtureDir, 'ai-account.patch.yml')
const packageDir = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { dsh?: { bundle?: { patch?: string } } }
const bundlePatch = manifest.dsh?.bundle?.patch
if (bundlePatch === undefined) throw new Error('subagent-ai-account must declare a Bundle patch')
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('AI Account provider Bundle Loader composition', () => {
  it('mounts one provider per default account and exposes its delegation tool without starting a product', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'AI Account provider Loader composition',
      tempDirPrefix: 'dsh-subagent-ai-account-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      binArgs: [configPath, join(packageDir, bundlePatch)],
      tsconfigPath: repoTsconfig,
      processTimeoutMs: PROCESS_TIMEOUT_MS,
      env: { PATH: '' },
    })
    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({
      initial: { providers: ['claude-code'], tools: ['subagent_claude_code'] },
      withCodex: { providers: ['claude-code', 'codex'], tools: ['subagent_claude_code', 'subagent_codex'] },
      unchanged: { providers: ['claude-code', 'codex'], tools: ['subagent_claude_code', 'subagent_codex'] },
      codexHome: true,
      starts: 0,
    })
  }, PROCESS_TIMEOUT_MS + 15_000)
})
