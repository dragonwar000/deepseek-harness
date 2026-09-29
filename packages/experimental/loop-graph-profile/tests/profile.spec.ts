/**
 * The loop guards bundle must carry one parseable layer that leaves repeat-tool-reminder running and starts every
 * guard and the graph contract in shadow mode.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { Config as DenialBudgetConfig } from '@deepseek-ai/dsh-experimental-denial-budget'
import { Config as GraphContractConfig } from '@deepseek-ai/dsh-experimental-graph-contract'
import { Config as LoopBudgetConfig } from '@deepseek-ai/dsh-experimental-loop-budget'
import { Config as StationarityConfig } from '@deepseek-ai/dsh-experimental-stationarity-guard'
import { Config as VerifierGateConfig } from '@deepseek-ai/dsh-experimental-verifier-gate'

interface PatchRow {
  id?: string
  name?: string
  disabled?: boolean
  config?: Record<string, unknown>
  insert?: PatchRow[]
}

const GUARD_SCHEMAS: Record<string, (config: Record<string, unknown> | undefined) => unknown> = {
  'verifier-gate': config => VerifierGateConfig(config),
  'stationarity-guard': config => StationarityConfig(config),
  'denial-budget': config => DenialBudgetConfig(config),
  'loop-budget': config => LoopBudgetConfig(config),
  'graph-contract': config => GraphContractConfig(config),
}

describe('loop guards bundle', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { bundle?: { patch?: string } }
  }
  const patches = yaml.load(readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'), { schema: entryListSchema }) as PatchRow[]
  const inserted = patches.flatMap(patch => patch.insert ?? [])

  it('depends on every row package it inserts', () => {
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-experimental-denial-budget': 'workspace:*',
      '@deepseek-ai/dsh-experimental-graph-contract': 'workspace:*',
      '@deepseek-ai/dsh-experimental-graph-projection': 'workspace:*',
      '@deepseek-ai/dsh-experimental-infra-snapshot': 'workspace:*',
      '@deepseek-ai/dsh-experimental-loop-budget': 'workspace:*',
      '@deepseek-ai/dsh-experimental-stationarity-guard': 'workspace:*',
      '@deepseek-ai/dsh-experimental-verifier-gate': 'workspace:*',
    })
  })

  it('leaves repeat-tool-reminder running while stationarity-guard is in shadow', () => {
    expect(patches.find(patch => patch.id === 'repeat-tool-reminder')).toBeUndefined()
  })

  it('inserts the rows in listener order with verifier-gate before loop-budget', () => {
    expect(inserted.map(row => row.id)).toEqual(['infra-snapshot', 'verifier-gate', 'stationarity-guard', 'denial-budget', 'loop-budget', 'graph-contract', 'graph-projection'])
  })

  it.each(Object.keys(GUARD_SCHEMAS))('starts %s in shadow mode with a valid config and an assumption', (id) => {
    const row = inserted.find(entry => entry.id === id)
    expect(row?.name).toBe(`@deepseek-ai/dsh-experimental-${id}`)
    expect(row?.config).toMatchObject({ mode: 'shadow' })
    expect(String(row?.config?.['assumption']).trim()).not.toBe('')
    expect(() => GUARD_SCHEMAS[id]!(row?.config)).not.toThrow()
  })

  it('starts the verifier gate with one blank-response steer per turn', () => {
    const row = inserted.find(entry => entry.id === 'verifier-gate')
    expect(row?.config).toMatchObject({ mode: 'shadow', blankResponse: { maxSteers: 1 } })
  })

  it('starts the graph contract with no node tools and no run limits', () => {
    const row = inserted.find(entry => entry.id === 'graph-contract')
    expect(row?.config).toMatchObject({ mode: 'shadow', allowedTools: [], runBudget: { steps: 0, tokens: 0, wallMs: 0 } })
  })

  it('mounts the graph projection without config', () => {
    const row = inserted.find(entry => entry.id === 'graph-projection')
    expect(row).toEqual({ id: 'graph-projection', name: '@deepseek-ai/dsh-experimental-graph-projection' })
  })

  it('leaves the dsh-base compaction rows to the profile owner', () => {
    expect(patches.filter(patch => patch.id === 'compaction-basic' || patch.id === 'tool-result-pruner')).toEqual([])
  })
})
