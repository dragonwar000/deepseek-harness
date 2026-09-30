/**
 * The plugin against a real zeromem `zm` binary: spooled turns are ingested with source-uuid dedup,
 * recall leaves the current session out, stats count the store, and forget deletes a session.
 * Self-skips unless `DSH_ZEROMEM_ZM` names an absolute `zm` path, for example one built offline with
 * `cargo build --release --no-default-features` in a zeromem checkout. The hash embedder is always
 * selected, so the run downloads no model.
 */

import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as MemoryZeromem from '../src/index.ts'
import { boot, cleanup, results, spooled, turn, workspaceHome } from './harness.ts'
import type { Booted } from './harness.ts'

const zm = process.env['DSH_ZEROMEM_ZM']
const available = zm !== undefined && zm !== '' && existsSync(zm)

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
