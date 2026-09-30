/**
 * Retrieval eval of `knowledge_query` over the keyless fixture wiki: the
 * mean recall@3 of the held-out questions stays at or above the floor the
 * package README records. No model is called.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import WikiFilesystemKnowledge from '@deepseek-ai/dsh-experimental-knowledge-wiki-filesystem'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as ToolKnowledge from '../src/index.ts'
import { RETRIEVAL_PAGES, RETRIEVAL_QUERIES } from './retrieval-fixture.ts'

/** Hits per question that count toward recall. */
const K = 3
/** Minimum mean recall@3; the ranking measured 0.825 when the floor was set. */
const RECALL_FLOOR = 0.8

let dir: string
let ctx: Context

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-knowledge-eval-'))
  for (const page of RETRIEVAL_PAGES) {
    const path = join(dir, 'knowledge', page.id)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `---\ntype: ${page.type}\ntitle: ${page.title}\n---\n\n# ${page.title}\n\n${page.body}\n\n## Origin\n\n- Retrieval eval fixture.\n`)
  }
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(WikiFilesystemKnowledge, { contentDirs: ['concepts', 'decisions', 'procedures'] })
  await ctx.plugin(ToolKnowledge, { evidenceTools: ['read'] })
})

afterAll(async () => {
  await ctx.fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Page ids `knowledge_query` returns for one question.
 * @param query - question text.
 * @returns the hit ids, best first.
 */
async function hitsOf(query: string): Promise<string[]> {
  const result = await ctx.tools.execute({ callId: ToolCallId('eval'), name: 'knowledge_query', arguments: { query, limit: K }, signal: new AbortController().signal })
  const text = result.content.map(block => (block.type === 'text' ? block.text : '')).join('')
  return (JSON.parse(text) as { hits: { id: string }[] }).hits.map(hit => hit.id)
}

describe('knowledge_query retrieval eval', () => {
  it(`keeps mean recall@${K} at or above ${RECALL_FLOOR}`, async () => {
    const recalls: number[] = []
    for (const { query, expected } of RETRIEVAL_QUERIES) {
      const hits = await hitsOf(query)
      recalls.push(expected.filter(id => hits.includes(id)).length / expected.length)
    }
    const mean = recalls.reduce((sum, value) => sum + value, 0) / recalls.length
    expect(RETRIEVAL_QUERIES).toHaveLength(20)
    expect(mean).toBeGreaterThanOrEqual(RECALL_FLOOR)
  })
})
