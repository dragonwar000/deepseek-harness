/**
 * The plugin against a real zeromem `zm` binary: spooled turns are ingested with source-uuid dedup,
 * recall leaves the current session out, stats count the store, and forget deletes a session, all on the
 * hash embedder. Self-skips unless `DSH_ZEROMEM_ZM` names an absolute `zm` path, for example the one
 * `pnpm run prepare:desktop:zeromem` builds. When `DSH_ZEROMEM_MODELS` also names the model directory
 * prepared beside it, the default embedder recalls a paraphrase that the hash embedder misses. Neither
 * run downloads a model.
 */

import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as MemoryZeromem from '../src/index.ts'
import { boot, cleanup, results, spooled, turn, workspaceHome } from './harness.ts'
import type { Booted } from './harness.ts'

const zm = process.env['DSH_ZEROMEM_ZM']
const available = zm !== undefined && zm !== '' && existsSync(zm)
const models = process.env['DSH_ZEROMEM_MODELS']
const modelAvailable = available && models !== undefined && models !== '' && existsSync(models)

/** A stored turn and a query that shares no word with it. */
const DEPLOY = 'Our deploy script retries failed uploads with exponential backoff.'
const PARAPHRASE = 'which command handles transient network errors when pushing artifacts?'

afterEach(cleanup)

/** Boot the plugin with the real `zm`. */
async function bootReal(): Promise<Booted> {
  return boot({ config: { zmPath: zm!, zmArgs: [], embedder: 'hash', allowForget: true }, approval: 'allowed-once' })
}

/** Run one tool call in a session and return its parsed result. */
async function call(booted: Booted, sessionId: string, name: string, args: object): Promise<unknown> {
  const agent = await turn(booted, sessionId, `please run ${name}`, [toolCallResponse('c1', name, args), textResponse('done')])
  const [result] = results(agent)
  expect(result?.isError, result?.text).toBe(false)
  return JSON.parse(result!.text)
}

describe.skipIf(!available)('memory-zeromem with a real zm', () => {
  it('stores, recalls, counts, and forgets conversation turns', async () => {
    const booted = await bootReal()
    await turn(booted, 'past', 'Carrie is handling the Slowdive vinyl order at Dungeon Books.', [textResponse('Noted: Carrie owns the Slowdive vinyl order.')])
    const recalled = await call(booted, 'present', 'memory_recall', { query: 'What is Carrie handling?' }) as { turns: { session: string; text: string; time: string }[] }
    expect(recalled.turns.length).toBeGreaterThan(0)
    expect(recalled.turns.map(entry => entry.session)).not.toContain('present')
    expect(recalled.turns.some(entry => entry.text.includes('Slowdive vinyl'))).toBe(true)
    expect(recalled.turns[0]!.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)

    // `present` has one completed turn now; `past` has one. Each stored a user message and a reply.
    expect(await call(booted, 'counter', 'memory_stats', {})).toEqual({ turns: 4, sessions: 2 })
    expect(await call(booted, 'cleaner', 'memory_forget_session', { session: 'past' })).toEqual({ session: 'past', deletedTurns: 2 })
    const after = await call(booted, 'checker', 'memory_recall', { query: 'Slowdive vinyl order' }) as { turns: { session: string }[] }
    expect(after.turns.map(entry => entry.session)).not.toContain('past')
  })

  it('drops the duplicate a resumed session re-spools', async () => {
    const booted = await bootReal()
    await turn(booted, 'resume', 'The cache TTL is 90 seconds.', [textResponse('Noted.')])
    // A new plugin instance has no record of what the previous one spooled, like a restarted process.
    await booted.fiber.dispose()
    const second = await booted.ctx.plugin(MemoryZeromem, { zmPath: zm!, embedder: 'hash', storeRoot: booted.storeRoot })
    await turn(booted, 'resume', 'The queue depth limit is 500.', [textResponse('Noted too.')])
    // Unloading waits for the queued spool writes.
    await second.dispose()
    expect(spooled(workspaceHome(booted)).filter(entry => entry.text === 'The cache TTL is 90 seconds.')).toHaveLength(2)
    await booted.ctx.plugin(MemoryZeromem, { zmPath: zm!, embedder: 'hash', storeRoot: booted.storeRoot })
    expect(await call(booted, 'counter', 'memory_stats', {})).toEqual({ turns: 4, sessions: 1 })
  })
})

describe.skipIf(!modelAvailable)('memory-zeromem with a real zm and bge-small-en-v1.5', () => {
  /** Store two unrelated conversations, then recall the paraphrase from a third session. */
  async function recallParaphrase(embedder: 'default' | 'hash'): Promise<{ session: string; text: string }[]> {
    const booted = await boot({ config: { zmPath: zm!, zmArgs: [], embedder, modelDir: models! } })
    await turn(booted, 'deploy', DEPLOY, [textResponse('Understood, the upload retry policy is noted.')])
    await turn(booted, 'lunch', 'We ordered pizza for the team lunch on Friday.', [textResponse('Sounds good, enjoy the pizza.')])
    const recalled = await call(booted, 'asker', 'memory_recall', { query: PARAPHRASE, limit: 2 }) as { turns: { session: string; text: string }[] }
    return recalled.turns
  }

  it('recalls a paraphrase with the default embedder that the hash embedder misses', async () => {
    const semantic = await recallParaphrase('default')
    expect(semantic.map(entry => entry.session)).toEqual(['deploy', 'deploy'])
    expect(semantic.map(entry => entry.text)).toContain(DEPLOY)
    expect((await recallParaphrase('hash')).map(entry => entry.text)).not.toContain(DEPLOY)
  })
})
