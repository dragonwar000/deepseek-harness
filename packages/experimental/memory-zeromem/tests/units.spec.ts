import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { applyZeromemTurn, emptyZeromemTurn } from '../src/fold.ts'
import { deletedTurnsOf, recallOf, statsOf } from '../src/results.ts'
import { isForgotten, markForgotten, prepareStore, resolveStore, resolveStoreRoot, sourceUuid, spoolTurns, ZeromemStoreError } from '../src/store.ts'
import { ZeromemProcessError } from '../src/zm.ts'
import { cleanup, tempRoot } from './harness.ts'

afterEach(cleanup)

let seq = 0
/** A committed event of one type. */
function event<T extends SessionEvent['type']>(type: T, data: Extract<SessionEvent, { type: T }>['data']): SessionEvent {
  seq += 1
  return { type, seq: SessionSeq(seq), time: 1_780_000_000_000 + seq, data } as Extract<SessionEvent, { type: T }>
}

const user = (text: string, kind: 'user' | 'runtime-context' = 'user') => event('user/message', createUserMessage({ content: [{ type: 'text', text }], source: kind === 'user' ? { kind } : { kind, form: 'snapshot', sections: [] } }))
const assistant = (text: string, interrupted = false) => event('assistant/message', {
  turn: 1,
  step: 1,
  message: { id: MessageId(`a${seq}`), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } },
  stream: [],
  ...interrupted ? { interrupted: true as const } : {},
})

describe('zeromemTurn fold', () => {
  const fold = (events: SessionEvent[], maxChars = 100) =>
    events.reduce((state, next) => applyZeromemTurn(maxChars, state, next), emptyZeromemTurn())

  it('keeps human messages and the last uninterrupted reply of a completed turn', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      user('first'),
      user('runtime context', 'runtime-context'),
      user('  '),
      assistant('I will check.'),
      assistant('Final answer.'),
      assistant('partial', true),
      assistant(''),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(state.open).toBeNull()
    expect(state.completed?.requests.map(text => text.text)).toEqual(['first'])
    expect(state.completed?.reply?.text).toBe('Final answer.')
  })

  it('ignores messages outside a turn and a turn end of another turn, and cuts text', () => {
    const state = fold([
      user('before any turn'),
      assistant('before any turn'),
      event('turn/start', { turn: 2 }),
      user('abcdefghij'),
      event('turn/end', { turn: 3, reason: { kind: 'completed' } }),
      event('step/start', { turn: 2, step: 1 }),
    ], 4)
    expect(state.completed).toBeNull()
    expect(state.open?.requests.map(text => text.text)).toEqual(['abcd'])
  })
})

describe('store', () => {
  it('resolves the default root under the harness home and expands ~', () => {
    expect(resolveStoreRoot('')).toBe(join(resolveDshHome(), 'zeromem'))
    expect(resolveStoreRoot('~/mem')).toBe(join(homedir(), 'mem'))
    expect(() => resolveStoreRoot('mem')).toThrow(ZeromemStoreError)
  })

  it('keys workspace stores by working directory and needs one', () => {
    const a = resolveStore({ scope: 'workspace', storeRoot: '/r', cwd: '/work/a' })
    expect(a.home).toMatch(/^\/r\/workspaces\/[0-9a-f]{16}$/)
    expect(resolveStore({ scope: 'workspace', storeRoot: '/r', cwd: '/work/a/' }).home).toBe(a.home)
    expect(resolveStore({ scope: 'workspace', storeRoot: '/r', cwd: '/work/b' }).home).not.toBe(a.home)
    expect(a.models).toBe('/r/models')
    expect(() => resolveStore({ scope: 'workspace', storeRoot: '/r', cwd: undefined })).toThrow(/no workspace directory/)
  })

  it('prepares owner-only directories with a shared model cache link, idempotently', async () => {
    const { root } = tempRoot()
    const spec = resolveStore({ scope: 'global', storeRoot: root, cwd: undefined })
    await prepareStore(spec)
    await prepareStore(spec)
    expect(lstatSync(join(spec.home, 'models')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(spec.home, 'models')).replace(/[\\/]$/, '')).toBe(spec.models)
    if (process.platform !== 'win32') expect(lstatSync(spec.home).mode & 0o777).toBe(0o700)
  })

  it('writes spool files zm drains and records forgotten sessions', async () => {
    const { root } = tempRoot()
    const id = SessionId('s-1')
    const path = await spoolTurns(root, [{ session_id: id, speaker: 'user', text: 'hi', ts: 5, uuid: sourceUuid(id, 7) }])
    expect(path).toMatch(/spool[\\/]\d{13}-\d+-dsh-\d+\.jsonl$/)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ session_id: 's-1', speaker: 'user', text: 'hi', ts: 5, uuid: 'dsh:s-1:7' })
    expect(await isForgotten(root, id)).toBe(false)
    await markForgotten(root, id)
    expect(await isForgotten(root, id)).toBe(true)
    expect(existsSync(join(root, 'dsh-forgotten'))).toBe(true)
  })

  it('reports a forgotten marker it cannot read', async () => {
    const { root } = tempRoot()
    writeFileSync(join(root, 'dsh-forgotten'), 'a file, not a directory')
    await expect(isForgotten(root, SessionId('s'))).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

describe('results', () => {
  it('converts recalled evidence', () => {
    const recall = recallOf({
      route: 'Local',
      evidence: [
        { session_id: 's1', speaker: 'user', text: 'hello there', ts: 1_780_000_000, role: 'Main', score: 1, turn_id: 1, session_turn: 0 },
        { session_id: 's2', speaker: 'assistant', text: 'ok', ts: 1_780_000_001, role: 'GraphBridge', score: 0, turn_id: 2, session_turn: 0 },
      ],
    }, 5)
    expect(recall).toEqual({
      fallbackEmbedder: false,
      turns: [
        { session: 's1', time: '2026-05-28T20:26:40Z', speaker: 'user', text: 'hello', kind: 'match', truncated: true },
        { session: 's2', time: '2026-05-28T20:26:41Z', speaker: 'assistant', text: 'ok', kind: 'context' },
      ],
    })
  })

  it('rejects results without zeromem fields as named errors', () => {
    expect(() => recallOf({ evidence: [{ text: 1 }] }, 5)).toThrow(ZeromemProcessError)
    expect(() => statsOf({ turns: -1 })).toThrow(/zm answered zeromem_stats with unexpected fields/)
    expect(() => deletedTurnsOf({})).toThrow(/zeromem_forget_session/)
    expect(statsOf({ turns: 3, sessions: 2, embedder_is_fallback: true })).toEqual({ turns: 3, sessions: 2, fallbackEmbedder: true })
    expect(deletedTurnsOf({ session_id: 'x', deleted_turns: 4 })).toBe(4)
  })
})
