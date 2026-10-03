import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createToolResultMessage, createUserMessage, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { episodeFixedChars } from '../src/episode.ts'
import { boot, cleanup, flush, spooled, tempRoot, turn, workspaceHome } from './harness.ts'
import type { Booted } from './harness.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

afterEach(cleanup)

/** Append a user message of the turn. */
function ask(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

/** Append one write of a file, as the model's tool call and its result. */
function write(session: Session, turn: number, path: string, callId = `w-${path}`, isError = false, name = 'write'): void {
  session.append('tool/call', { turn, step: 1, callId: ToolCallId(callId), name, arguments: JSON.stringify({ file_path: path }) })
  session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text: 'wrote' }], isError }),
  }, { surfaceOp: 'append' })
}

/** Append the final assistant message of the turn. */
function reply(session: Session, turn: number, text: string, interrupted = false): void {
  session.append('assistant/message', {
    turn,
    step: 1,
    message: { id: MessageId(`m${turn}-${text.length}`), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'mock', model: 'mock' } },
    stream: [],
    ...interrupted ? { interrupted: true } : {},
  }, { surfaceOp: 'append' })
}

/** Append the verifier gate's verdict for the turn. */
function verdict(session: Session, turn: number, kind: 'ok' | 'not-ok'): void {
  session.append('loop/verdict', { turn, mode: 'enforce', verdict: kind, reason: kind === 'ok' ? 'all-passed' : 'command-failed', checks: [], continuation: 0, continued: false })
}

/** Append turn/end with the given reason. */
function end(session: Session, turn: number, kind: 'completed' | 'blocked' = 'completed'): void {
  session.append('turn/end', { turn, reason: { kind } })
}

/** Sequence number of the first event of a type. */
function seqOf(session: Session, type: SessionEvent['type']): number {
  const event = session.snapshotEvents().find(candidate => candidate.type === type)
  if (event === undefined) throw new Error(`no ${type} event`)
  return event.seq
}

/** Warnings that name the episode refusal reasons, in order. */
function refusals(booted: Booted): string[] {
  return booted.warnings.map(String).filter(warning => warning.includes('is not stored as an episode'))
}

/** A session in the workspace that the plugin ingests. */
function workspaceSession(booted: Booted, id: string): Session {
  return booted.ctx.sessions.create(SessionId(id), { meta: { cwd: booted.workspace } })
}

describe('verified episodes in the spool', () => {
  it('stores the conversation records and one verified episode of a turn in one spool file under both', async () => {
    const booted = await boot({ config: { ingestMode: 'both' } })
    const session = workspaceSession(booted, 'ep')
    session.append('turn/start', { turn: 1 })
    ask(session, 'Add retry to the client.')
    write(session, 1, 'src/retry.ts')
    reply(session, 1, 'Added three attempts. For now, lint is skipped.')
    verdict(session, 1, 'ok')
    end(session, 1)
    await flush(booted)

    const response = seqOf(session, 'assistant/message')
    const result = seqOf(session, 'tool/result')
    const verdictSeq = seqOf(session, 'loop/verdict')
    const home = workspaceHome(booted)
    const records = spooled(home)
    expect(records.map(record => [record.speaker, record.text])).toEqual([
      ['user', 'Add retry to the client.'],
      ['assistant', 'Added three attempts. For now, lint is skipped.'],
      ['assistant', [
        '# Verified episode',
        'Turn: 1',
        `Final response event: ${response}`,
        `Verifier event: ${verdictSeq}; verdict: ok`,
        '',
        '## Request',
        '',
        'Add retry to the client.',
        '',
        '## Outcome',
        '',
        'Added three attempts.',
        '',
        '## Files changed',
        '',
        `- src/retry.ts — successful tool result event ${result}`,
        '',
        '## Verification',
        '',
        `The verifier accepted the final response at event ${response}.`,
      ].join('\n')],
    ])
    expect(records.map(record => record.session_id)).toEqual(['ep', 'ep', 'ep'])
    expect(records[2]!.uuid).toBe(`dsh:episode:ep:1:${response}`)
    expect(records[2]!.ts).toBe(Math.floor(session.snapshotEvents()[response]!.time / 1000))
    expect(refusals(booted)).toEqual([])
  })

  it('stores only the episode under episodes, and nothing for a turn that changed no file', async () => {
    const booted = await boot({ config: { ingestMode: 'episodes' } })
    const session = workspaceSession(booted, 'only')
    session.append('turn/start', { turn: 1 })
    ask(session, 'Explain the retry policy.')
    reply(session, 1, 'It retries three times.')
    verdict(session, 1, 'ok')
    end(session, 1)
    session.append('turn/start', { turn: 2 })
    ask(session, 'Add retry to the client.')
    write(session, 2, 'src/retry.ts')
    reply(session, 2, 'Added three attempts.')
    verdict(session, 2, 'ok')
    end(session, 2)
    await flush(booted)

    expect(spooled(workspaceHome(booted)).map(record => record.text.split('\n')[0])).toEqual(['# Verified episode'])
    expect(spooled(workspaceHome(booted))[0]!.text).toContain('Turn: 2\n')
    expect(refusals(booted)).toEqual([])
  })

  it('stores no episode without a verdict, and reports that reason once per session', async () => {
    const booted = await boot({ config: { ingestMode: 'episodes' } })
    const session = workspaceSession(booted, 'unverified')
    for (const turnNumber of [1, 2]) {
      session.append('turn/start', { turn: turnNumber })
      ask(session, `Change ${turnNumber}.`)
      write(session, turnNumber, `src/file${turnNumber}.ts`)
      reply(session, turnNumber, 'Changed.')
      end(session, turnNumber)
    }
    await flush(booted)

    expect(spooled(workspaceHome(booted))).toEqual([])
    expect(refusals(booted)).toEqual(['memory-zeromem: turn 1 of session unverified changed files but is not stored as an episode (no-verdict); an episode needs a verifier verdict ok for its final response'])
  })

  it.each([
    ['verdict-not-ok', (session: Session) => { verdict(session, 1, 'not-ok') }],
    ['input-after-verdict', (session: Session) => { verdict(session, 1, 'ok'); ask(session, 'one more thing') }],
    ['changed-after-verdict', (session: Session) => { verdict(session, 1, 'ok'); write(session, 1, 'src/other.ts') }],
  ] as const)('refuses an episode as %s', async (reason, afterChange) => {
    const booted = await boot({ config: { ingestMode: 'episodes' } })
    const session = workspaceSession(booted, `refused-${reason}`)
    session.append('turn/start', { turn: 1 })
    ask(session, 'Add retry.')
    write(session, 1, 'src/retry.ts')
    reply(session, 1, 'Added retry.')
    afterChange(session)
    end(session, 1)
    await flush(booted)

    expect(spooled(workspaceHome(booted))).toEqual([])
    expect(refusals(booted)).toEqual([expect.stringContaining(`(${reason})`)])
  })

  it('refuses a turn whose final response was interrupted, and one that did not complete', async () => {
    const booted = await boot({ config: { ingestMode: 'episodes' } })
    const interrupted = workspaceSession(booted, 'interrupted')
    interrupted.append('turn/start', { turn: 1 })
    ask(interrupted, 'Add retry.')
    write(interrupted, 1, 'src/retry.ts')
    reply(interrupted, 1, 'Added', true)
    verdict(interrupted, 1, 'ok')
    end(interrupted, 1)

    const blocked = workspaceSession(booted, 'blocked')
    blocked.append('turn/start', { turn: 1 })
    ask(blocked, 'Add retry.')
    write(blocked, 1, 'src/retry.ts')
    reply(blocked, 1, 'Added retry.')
    verdict(blocked, 1, 'ok')
    end(blocked, 1, 'blocked')
    await flush(booted)

    expect(spooled(workspaceHome(booted))).toEqual([])
    expect(refusals(booted)).toEqual([expect.stringContaining('(no-response)')])
  })

  it('stores nothing and warns nothing for a turn that changed no file', async () => {
    const booted = await boot({ config: { ingestMode: 'both' } })
    const session = workspaceSession(booted, 'chat')
    session.append('turn/start', { turn: 1 })
    ask(session, 'What is retry?')
    reply(session, 1, 'A repeated attempt.')
    verdict(session, 1, 'ok')
    end(session, 1)
    await flush(booted)

    expect(spooled(workspaceHome(booted)).map(record => record.speaker)).toEqual(['user', 'assistant'])
    expect(refusals(booted)).toEqual([])
  })

  it('does not store an episode whose cited events a fork inherited from its parent', async () => {
    const booted = await boot({ config: { ingestMode: 'episodes' } })
    const parent = workspaceSession(booted, 'parent')
    parent.append('turn/start', { turn: 1 })
    ask(parent, 'Add retry.')
    write(parent, 1, 'src/retry.ts')
    reply(parent, 1, 'Added retry.')
    verdict(parent, 1, 'ok')
    const inherited = parent.snapshotEvents()
    const child = booted.ctx.sessions.create(SessionId('child'), {
      seed: inherited,
      inheritedEventCount: SessionLogOffset(inherited.length),
      meta: { cwd: booted.workspace, isSeeded: true },
    })
    end(child, 1)
    await flush(booted)

    expect(spooled(workspaceHome(booted))).toEqual([])
  })

  it('shrinks the request and outcome to maxEpisodeChars and keeps the changed files whole', async () => {
    const limit = episodeFixedChars() + 120
    const booted = await boot({ config: { ingestMode: 'episodes', maxEpisodeChars: limit } })
    const session = workspaceSession(booted, 'long')
    session.append('turn/start', { turn: 1 })
    ask(session, 'Rewrite the whole retry module. '.repeat(10))
    write(session, 1, 'src/retry.ts')
    reply(session, 1, 'Rewrote the module with three attempts and backoff. '.repeat(20))
    verdict(session, 1, 'ok')
    end(session, 1)
    await flush(booted)

    const [record] = spooled(workspaceHome(booted))
    expect(record!.text.length).toBeLessThanOrEqual(limit)
    expect(record!.text).toContain('- src/retry.ts — successful tool result event ')
    expect(record!.text).toContain(' …')
  })

  it('warns and stores nothing when the changed files alone exceed maxEpisodeChars', async () => {
    const booted = await boot({ config: { ingestMode: 'episodes', maxEpisodeChars: episodeFixedChars() } })
    const session = workspaceSession(booted, 'many')
    session.append('turn/start', { turn: 1 })
    ask(session, 'Touch many files.')
    for (const name of ['a', 'b', 'c']) write(session, 1, `src/${name.repeat(40)}.ts`, `w-${name}`)
    reply(session, 1, 'Touched them.')
    verdict(session, 1, 'ok')
    end(session, 1)
    await flush(booted)

    expect(spooled(workspaceHome(booted))).toEqual([])
    expect(booted.warnings.map(String)).toContain('memory-zeromem: the episode of turn 1 of session many lists more changed files than maxEpisodeChars allows, so it is not stored; raise maxEpisodeChars')
  })

  it('does not store episodes under the default conversation mode', async () => {
    const booted = await boot()
    const session = workspaceSession(booted, 'default')
    session.append('turn/start', { turn: 1 })
    ask(session, 'Add retry.')
    write(session, 1, 'src/retry.ts')
    reply(session, 1, 'Added retry.')
    verdict(session, 1, 'ok')
    end(session, 1)
    await flush(booted)

    expect(spooled(workspaceHome(booted)).map(record => record.speaker)).toEqual(['user', 'assistant'])
  })
})

describe('episode settings', () => {
  it('refuses maxEpisodeChars below the fixed lines of an episode', async () => {
    await expect(boot({ config: { ingestMode: 'both', maxEpisodeChars: episodeFixedChars() - 1 } })).rejects.toThrow(`maxEpisodeChars must be at least ${episodeFixedChars()}`)
  })

  it('refuses a blank changed tool and a blank transient marker', async () => {
    await expect(boot({ config: { episodeChangeTools: [' '] } })).rejects.toThrow('episodeChangeTools must name at least one tool and no blank one')
    await expect(boot({ config: { episodeChangeTools: [] } })).rejects.toThrow('episodeChangeTools must name at least one tool and no blank one')
    await expect(boot({ config: { episodeTransientMarkers: ['for now', ' '] } })).rejects.toThrow('episodeTransientMarkers entries must not be blank')
  })
})

describe('episode evidence and ordering', () => {
  it('cites only the latest successful change of a file that was changed twice', async () => {
    const booted = await boot({ config: { ingestMode: 'episodes' } })
    const session = workspaceSession(booted, 'twice')
    session.append('turn/start', { turn: 1 })
    ask(session, 'Add retry.')
    write(session, 1, 'src/retry.ts', 'first')
    write(session, 1, 'src/retry.ts', 'second')
    reply(session, 1, 'Added retry.')
    verdict(session, 1, 'ok')
    end(session, 1)
    await flush(booted)

    const [record] = spooled(workspaceHome(booted))
    const latest = session.snapshotEvents().filter(event => event.type === 'tool/result').at(-1)!.seq
    expect(record!.text.match(/^- .*$/gm)).toEqual([`- src/retry.ts — successful tool result event ${latest}`])
  })

  it('cites no failed change, no change without a path, and no tool outside episodeChangeTools', async () => {
    const booted = await boot({ config: { ingestMode: 'episodes' } })
    const session = workspaceSession(booted, 'evidence')
    session.append('turn/start', { turn: 1 })
    ask(session, 'Add retry.')
    write(session, 1, 'src/failed.ts', 'failed', true)
    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('nopath'), name: 'write', arguments: '{}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: ToolCallId('nopath'), content: [{ type: 'text', text: 'ok' }], isError: false }),
    }, { surfaceOp: 'append' })
    write(session, 1, 'src/read.ts', 'read', false, 'read')
    write(session, 1, 'src/retry.ts', 'good')
    reply(session, 1, 'Added retry.')
    verdict(session, 1, 'ok')
    end(session, 1)
    await flush(booted)

    const [record] = spooled(workspaceHome(booted))
    expect(record!.text.match(/^- .*$/gm)).toEqual([expect.stringContaining('- src/retry.ts — ')])
    expect(record!.text).not.toContain('src/failed.ts')
    expect(record!.text).not.toContain('src/read.ts')
  })

  it('filters Vietnamese temporary sentences from the episode and keeps them in the conversation', async () => {
    const booted = await boot({ config: { ingestMode: 'both', episodeTransientMarkers: ['tạm thời'] } })
    const session = workspaceSession(booted, 'vi')
    session.append('turn/start', { turn: 1 })
    ask(session, 'Thêm retry cho client.')
    write(session, 1, 'src/retry.ts')
    reply(session, 1, 'Đã thêm retry. Tạm thời bỏ qua lint.')
    verdict(session, 1, 'ok')
    end(session, 1)
    await flush(booted)

    const records = spooled(workspaceHome(booted))
    expect(records[1]!.text).toBe('Đã thêm retry. Tạm thời bỏ qua lint.')
    expect(records[2]!.text).toContain('## Outcome\n\nĐã thêm retry.\n')
    expect(records[2]!.text).not.toContain('Tạm thời')
  })

  it.each([
    { kind: 'aborted', reason: { kind: 'user' } },
    { kind: 'error', error: { message: 'lost', code: 'network' } },
    { kind: 'max-tokens' },
  ] as const)('stores no episode for a turn that ended as $kind', async (reason) => {
    const booted = await boot({ config: { ingestMode: 'episodes' } })
    const session = workspaceSession(booted, `ended-${reason.kind}`)
    session.append('turn/start', { turn: 1 })
    ask(session, 'Add retry.')
    write(session, 1, 'src/retry.ts')
    reply(session, 1, 'Added retry.')
    verdict(session, 1, 'ok')
    session.append('turn/end', { turn: 1, reason })
    await flush(booted)

    expect(spooled(workspaceHome(booted))).toEqual([])
    expect(refusals(booted)).toEqual([])
  })

  it('stores the episode of a turn whose spool write failed at the next turn boundary', async () => {
    const booted = await boot({ config: { ingestMode: 'episodes' } })
    const home = workspaceHome(booted)
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'spool'), 'not a directory')
    const session = workspaceSession(booted, 'retry-episode')
    session.append('turn/start', { turn: 1 })
    ask(session, 'Add retry.')
    write(session, 1, 'src/retry.ts')
    reply(session, 1, 'Added retry.')
    verdict(session, 1, 'ok')
    end(session, 1)
    await vi.waitFor(() => { expect(booted.warnings).toContain('memory-zeromem: could not store turn 1 of session retry-episode') })
    rmSync(join(home, 'spool'))
    session.append('turn/start', { turn: 2 })
    await flush(booted)

    expect(spooled(home).map(record => record.uuid)).toEqual([`dsh:episode:retry-episode:1:${seqOf(session, 'assistant/message')}`])
  })

  it('stores an episode again under the same key after a restart replays its turn', async () => {
    const storeRoot = join(tempRoot().root, 'stores')
    const first = await boot({ config: { ingestMode: 'episodes', storeRoot } })
    const home = workspaceHome({ ...first, storeRoot })
    const session = workspaceSession(first, 'resume')
    session.append('turn/start', { turn: 1 })
    ask(session, 'Add retry.')
    write(session, 1, 'src/retry.ts')
    reply(session, 1, 'Added retry.')
    verdict(session, 1, 'ok')
    end(session, 1)
    await flush(first)
    const events = session.snapshotEvents()

    const second = await boot({ config: { ingestMode: 'episodes', storeRoot } })
    // The resumed session keeps its working directory, so it reads the same store.
    const resumed = second.ctx.sessions.create(SessionId('resume'), { seed: events, meta: { cwd: first.workspace } })
    resumed.append('turn/start', { turn: 2 })
    await flush(second)

    const keys = spooled(home).map(record => record.uuid)
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
  })

  it('stores no episode for a session forgotten by memory_forget_session, even when it runs another turn', async () => {
    const booted = await boot({ config: { ingestMode: 'episodes', allowForget: true }, approval: 'allowed-once' })
    const old = workspaceSession(booted, 'old')
    old.append('turn/start', { turn: 1 })
    ask(old, 'Add retry.')
    write(old, 1, 'src/retry.ts')
    reply(old, 1, 'Added retry.')
    verdict(old, 1, 'ok')
    end(old, 1)
    // The forget call drains the spool into zm, so a later check reads only what the spool holds after it.
    await turn(booted, 'now', 'forget old', [toolCallResponse('c1', 'memory_forget_session', { session: 'old' }), textResponse('done')])
    old.append('turn/start', { turn: 2 })
    ask(old, 'Add retry again.')
    write(old, 2, 'src/retry.ts', 'again')
    reply(old, 2, 'Added again.')
    verdict(old, 2, 'ok')
    end(old, 2)
    const other = workspaceSession(booted, 'other')
    other.append('turn/start', { turn: 1 })
    ask(other, 'Add retry.')
    write(other, 1, 'src/retry.ts')
    reply(other, 1, 'Added retry.')
    verdict(other, 1, 'ok')
    end(other, 1)
    await flush(booted)

    expect(spooled(workspaceHome(booted)).map(record => record.session_id)).toEqual(['other'])
  })

  it('stores episodes without any knowledge store mounted', async () => {
    const booted = await boot({ config: { ingestMode: 'episodes' } })
    const session = workspaceSession(booted, 'standalone')
    session.append('turn/start', { turn: 1 })
    ask(session, 'Add retry.')
    write(session, 1, 'src/retry.ts')
    reply(session, 1, 'Added retry.')
    verdict(session, 1, 'ok')
    end(session, 1)
    await flush(booted)

    expect(spooled(workspaceHome(booted))).toHaveLength(1)
  })
})
