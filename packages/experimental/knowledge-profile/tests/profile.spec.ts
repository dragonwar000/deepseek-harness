/**
 * The knowledge bundle carries one parseable layer of six rows with valid
 * configs, starts the tools read-only and distillation in shadow mode, ships
 * conversation memory disabled, and
 * stays independent of the loop guards bundle in both directions: neither
 * side depends on or injects the other, and graph-projection reads the
 * knowledge store only as an optional peer through `ctx.get`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { Config as ContextKnowledgeConfig } from '@deepseek-ai/dsh-experimental-context-knowledge'
import { Config as KnowledgeRulesConfig } from '@deepseek-ai/dsh-experimental-knowledge-rules'
import WikiFilesystemKnowledge from '@deepseek-ai/dsh-experimental-knowledge-wiki-filesystem'
import { Config as MemoryDistillConfig } from '@deepseek-ai/dsh-experimental-memory-distill'
import { Config as MemoryZeromemConfig } from '@deepseek-ai/dsh-experimental-memory-zeromem'
import { Config as ToolKnowledgeConfig } from '@deepseek-ai/dsh-experimental-tool-knowledge'

interface PatchRow {
  id?: string
  name?: string
  disabled?: boolean
  config?: Record<string, unknown>
  insert?: PatchRow[]
}

interface Manifest {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  dsh?: { bundle?: { patch?: string } }
}

const SCHEMAS: Record<string, (config: Record<string, unknown> | undefined) => unknown> = {
  'knowledge-wiki-filesystem': config => WikiFilesystemKnowledge.Config(config),
  'knowledge-rules': config => KnowledgeRulesConfig(config),
  'tool-knowledge': config => ToolKnowledgeConfig(config),
  'context-knowledge': config => ContextKnowledgeConfig(config),
  'memory-distill': config => MemoryDistillConfig(config),
  'memory-zeromem': config => MemoryZeromemConfig(config),
}

const experimental = fileURLToPath(new URL('../..', import.meta.url))
const manifestOf = (dir: string): Manifest => JSON.parse(readFileSync(resolve(experimental, dir, 'package.json'), 'utf8')) as Manifest
/** Runtime dependencies and required peers; an optional peer may be absent at runtime. */
const runtimeNames = (manifest: Manifest): string[] => [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}).filter(name => manifest.peerDependenciesMeta?.[name]?.optional !== true),
]
/** Source lines of one package that inject a service or read it as a declared injection. */
const injectionLines = (dir: string, service: string): string[] => {
  const src = resolve(experimental, dir, 'src')
  return readdirSync(src).filter(file => file.endsWith('.ts')).flatMap(file => readFileSync(resolve(src, file), 'utf8').split('\n')
    .filter(line => (/\binject\b/.test(line) && line.includes(`'${service}'`)) || line.includes(`ctx.${service}.`))
    .map(line => `${dir}/src/${file}: ${line.trim()}`))
}

describe('knowledge bundle', () => {
  const manifest = manifestOf('knowledge-profile')
  const patches = yaml.load(readFileSync(resolve(experimental, 'knowledge-profile', manifest.dsh!.bundle!.patch!), 'utf8'), { schema: entryListSchema }) as PatchRow[]
  const inserted = patches.flatMap(patch => patch.insert ?? [])

  it('depends on every row package it inserts and on nothing else', () => {
    expect(manifest.dependencies).toEqual(Object.fromEntries(Object.keys(SCHEMAS).sort().map(id => [`@deepseek-ai/dsh-experimental-${id}`, 'workspace:*'])))
  })

  it('inserts the rows in listener order with the store before its guard and consumers', () => {
    expect(inserted.map(row => row.id)).toEqual(['knowledge-wiki-filesystem', 'knowledge-rules', 'tool-knowledge', 'context-knowledge', 'memory-distill', 'memory-zeromem'])
    for (const row of inserted) expect(row.name).toBe(`@deepseek-ai/dsh-experimental-${row.id}`)
  })

  it.each(Object.keys(SCHEMAS))('validates the %s row against its package Config', (id) => {
    const row = inserted.find(entry => entry.id === id)
    expect(() => SCHEMAS[id]!(row?.config)).not.toThrow()
  })

  it('starts the tools read-only and distillation in shadow mode with an assumption', () => {
    expect(inserted.find(row => row.id === 'tool-knowledge')?.config).toMatchObject({ mode: 'read-only' })
    const distill = inserted.find(row => row.id === 'memory-distill')?.config
    expect(distill).toMatchObject({ mode: 'shadow', requireVerdict: true, dir: 'episodes' })
    expect(String(distill?.['assumption']).trim()).not.toBe('')
    expect(inserted.find(row => row.id === 'knowledge-wiki-filesystem')?.config?.['contentDirs']).toContain('episodes')
  })

  it('ships conversation memory disabled, per workspace, with the current session left out of recall and no forget tool', () => {
    const rows = inserted.filter(row => row.disabled === true).map(row => row.id)
    expect(rows).toEqual(['memory-zeromem'])
    expect(inserted.find(row => row.id === 'memory-zeromem')?.config).toMatchObject({ scope: 'workspace', excludeCurrentSession: true, ingestSubagentSessions: false, allowForget: false })
  })

  it('stays independent of the loop guards bundle in both directions, apart from optional peers read with ctx.get', () => {
    const loop = /dsh-experimental-(verifier-gate|stationarity-guard|denial-budget|loop-budget|infra-snapshot|graph-|loop-graph-profile)/
    const knowledge = /dsh-experimental-(knowledge|tool-knowledge|context-knowledge|memory-distill|memory-zeromem)/
    for (const dir of ['knowledge', 'knowledge-wiki-filesystem', 'knowledge-rules', 'tool-knowledge', 'context-knowledge', 'memory-distill', 'memory-zeromem', 'knowledge-profile']) {
      expect(runtimeNames(manifestOf(dir)).filter(name => loop.test(name))).toEqual([])
    }
    for (const dir of ['loop-graph-profile', 'verifier-gate', 'stationarity-guard', 'denial-budget', 'loop-budget', 'infra-snapshot', 'graph-contract', 'graph-projection', 'graph-runner']) {
      expect(runtimeNames(manifestOf(dir)).filter(name => knowledge.test(name))).toEqual([])
      expect(injectionLines(dir, 'knowledge')).toEqual([])
    }
    const graph = manifestOf('graph-projection')
    expect(graph.peerDependenciesMeta?.['@deepseek-ai/dsh-experimental-knowledge']).toEqual({ optional: true })
  })

  it('finds a declared knowledge injection in source', () => {
    expect(injectionLines('tool-knowledge', 'knowledge').length).toBeGreaterThan(0)
  })

  it('names the bundle for the Plugins page in English and Chinese', () => {
    for (const locale of ['en', 'zh']) {
      const meta = (JSON.parse(readFileSync(resolve(experimental, 'knowledge-profile', 'locale', `${locale}.json`), 'utf8')) as { meta: { title: string; description: string } }).meta
      expect(meta.title.trim()).not.toBe('')
      expect(meta.description.trim()).not.toBe('')
    }
  })
})
