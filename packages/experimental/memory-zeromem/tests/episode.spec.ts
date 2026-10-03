import { describe, expect, it } from 'vitest'
import { createToolResultMessage, createUserMessage, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { emptyDistill } from '@deepseek-ai/dsh-experimental-memory-distill'
import type { DistillState } from '@deepseek-ai/dsh-experimental-memory-distill'
import { applyZeromemEpisode, emptyZeromemEpisode, episodeFixedChars, renderEpisode, verifiedEpisode } from '../src/episode.ts'
import type { EpisodeTurn, ZeromemEpisodeState } from '../src/episode.ts'
import { memoryRecallDescription } from '../src/index.ts'
import { episodeSourceUuid } from '../src/store.ts'

const TOOLS = new Set(['write', 'edit'])

/** A completed turn that changed one file, got a verdict `ok`, and was asked and answered once. */
function verifiedTurn(overrides: Partial<EpisodeTurn> & { facts?: Partial<DistillState> } = {}): EpisodeTurn {
  const { facts: factOverrides, ...rest } = overrides
  const facts: DistillState = {
    turn: 1,
    request: 'Add retry to the client.',
    pending: {},
    changes: [{ path: 'src/retry.ts', seq: 4 }],
    boundary: 6,
    outcome: 'Added three attempts.',
    verdict: { seq: 8, verdict: 'ok', boundary: 6 },
    distilled: false,
    ...factOverrides,
  }
  return { turn: 1, facts, input: 2, responseTime: 1_000, ...rest }
}

/** Fold the events a session appends, from an empty state. */
function foldEvents(append: (session: Session) => void): ZeromemEpisodeState {
  const session = Session.create(SessionId('fold'))
  append(session)
  return foldAll(session.snapshotEvents())
}

/** Fold every event in order, from an empty state. */
function foldAll(events: readonly SessionEvent[]): ZeromemEpisodeState {
  return events.reduce((state: ZeromemEpisodeState, event: SessionEvent) => applyZeromemEpisode(TOOLS, state, event), emptyZeromemEpisode())
}

/** Append a successful or failed change of one file. */
function change(session: Session, callId: string, name: string, path: string, isError = false): void {
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(callId), name, arguments: JSON.stringify({ file_path: path }) })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text: 'ok' }], isError }),
  }, { surfaceOp: 'append' })
}

describe('verifiedEpisode', () => {
  it('accepts a turn whose latest verdict ok names its final response and follows every change and request', () => {
    expect(verifiedEpisode(verifiedTurn())).toEqual({
      kind: 'verified',
      response: 6,
      responseTime: 1_000,
      verdictSeq: 8,
      changes: [{ path: 'src/retry.ts', seq: 4 }],
    })
  })

  it.each([
    ['no-changes', { facts: { changes: [] } }],
    ['no-response', { facts: { boundary: null } }],
    ['no-response', { facts: { outcome: '   ' } }],
    ['no-response', { responseTime: null }],
    ['no-verdict', { facts: { verdict: null } }],
    ['no-verdict', { facts: { verdict: { seq: 8, verdict: 'ok', boundary: 5 } } }],
    ['verdict-not-ok', { facts: { verdict: { seq: 8, verdict: 'not-ok', boundary: 6 } } }],
    ['input-after-verdict', { input: 9 }],
    ['changed-after-verdict', { facts: { changes: [{ path: 'src/retry.ts', seq: 9 }] } }],
  ] as const)('refuses as %s', (reason, overrides) => {
    expect(verifiedEpisode(verifiedTurn(overrides as Partial<EpisodeTurn>))).toEqual({ kind: 'refused', reason })
  })
})

describe('applyZeromemEpisode', () => {
  it('opens a turn at turn/start and keeps it as completed only when it ends with reason completed', () => {
    const completed = foldEvents((session) => {
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    })
    expect(completed).toEqual({ open: null, completed: { turn: 1, facts: emptyDistill(1), input: null, responseTime: null } })

    const blocked = foldEvents((session) => {
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })
    })
    expect(blocked).toEqual({ open: null, completed: null })
  })

  it('ignores turn/end of another turn and events before any turn', () => {
    const state = foldEvents((session) => {
      session.append('turn/start', { turn: 2 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    })
    expect(state.open?.turn).toBe(2)
    expect(state.completed).toBeNull()
    const beforeTurn = foldEvents((session) => {
      session.append('loop/verdict', { turn: 1, mode: 'shadow', verdict: 'ok', reason: 'all-passed', checks: [], continuation: 0, continued: false })
    })
    expect(beforeTurn).toEqual(emptyZeromemEpisode())
  })

  it('moves the input to the latest user message and ignores messages from other sources', () => {
    const state = foldEvents((session) => {
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Add retry' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'steer' }], source: { kind: 'verifier-gate', form: 'notice', summary: 'steer' } }), { surfaceOp: 'append' })
    })
    expect(state.open?.input).toBe(1)
    expect(state.open?.facts.request).toBe('Add retry')
  })

  it('drops the response and its verdict when the final message was interrupted', () => {
    const state = foldEvents((session) => {
      session.append('turn/start', { turn: 1 })
      change(session, 'w1', 'write', 'src/a.ts')
      session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: { id: MessageId('m1'), role: 'assistant', content: [{ type: 'text', text: 'partial' }], source: { kind: 'model', provider: 'mock', model: 'mock' } },
        stream: [],
        interrupted: true,
      }, { surfaceOp: 'append' })
    })
    expect(state.open?.facts).toMatchObject({ boundary: null, outcome: '', verdict: null })
    expect(state.open?.responseTime).toBeNull()
  })

  it('takes the response time of the final message from its event', () => {
    const session = Session.create(SessionId('reply-time'))
    session.append('turn/start', { turn: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: { id: MessageId('m1'), role: 'assistant', content: [{ type: 'text', text: 'reply' }], source: { kind: 'model', provider: 'mock', model: 'mock' } },
      stream: [],
    }, { surfaceOp: 'append' })
    const message = session.snapshotEvents().find(event => event.type === 'assistant/message')!
    const state = foldAll(session.snapshotEvents())
    expect(state.open?.responseTime).toBe(message.time)
    expect(state.open?.facts.outcome).toBe('reply')
  })

  it('records a failed change without citing it', () => {
    const state = foldEvents((session) => {
      session.append('turn/start', { turn: 1 })
      change(session, 'e1', 'edit', 'src/a.ts', true)
    })
    expect(state.open?.facts.changes).toEqual([])
  })
})

describe('renderEpisode', () => {
  const refs = { turn: 3, response: 41, verdictSeq: 43, changes: [{ path: 'src/retry.ts', seq: 37 }] }

  it('writes the identifiers, bounded text, changed files with their events, and the verification line', () => {
    const text = renderEpisode({ ...refs, content: { summary: 'Add retry', request: 'Add retry to the client.', outcome: 'Added three attempts.' }, maxChars: 10_000 })
    expect(text).toBe([
      '# Verified episode',
      'Turn: 3',
      'Final response event: 41',
      'Verifier event: 43; verdict: ok',
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
      '- src/retry.ts — successful tool result event 37',
      '',
      '## Verification',
      '',
      'The verifier accepted the final response at event 41.',
    ].join('\n'))
  })

  it('shrinks the outcome first and then the request to the room the fixed lines leave, never past the limit', () => {
    const content = { summary: 'x', request: 'r'.repeat(400), outcome: 'o'.repeat(400) }
    const fixed = renderEpisode({ ...refs, content: { summary: 'x', request: '', outcome: '' }, maxChars: 10_000 })!.length
    const text = renderEpisode({ ...refs, content, maxChars: fixed + 100 })!
    expect(text.length).toBeLessThanOrEqual(fixed + 100)
    expect(text).toContain(' …')
  })

  it('keeps a request that fits and leaves the outcome out when less than three characters remain', () => {
    const fixed = renderEpisode({ ...refs, content: { summary: 'x', request: '', outcome: '' }, maxChars: 10_000 })!.length
    const text = renderEpisode({ ...refs, content: { summary: 'x', request: 'short', outcome: 'long outcome text' }, maxChars: fixed + 5 })!
    expect(text).toContain('## Request\n\nshort\n')
    expect(text).toContain('## Outcome\n\n\n')
  })

  it('returns undefined when the identifiers and changed files alone exceed the limit', () => {
    expect(renderEpisode({ ...refs, content: { summary: 'x', request: '', outcome: '' }, maxChars: 20 })).toBeUndefined()
  })
})

describe('episodeFixedChars', () => {
  it('is the length of an episode with no request, outcome, or changed file, at the largest event numbers', () => {
    const fixed = episodeFixedChars()
    expect(fixed).toBeGreaterThan(150)
    expect(renderEpisode({ turn: 1, response: 1, verdictSeq: 1, changes: [], content: { summary: 'x', request: '', outcome: '' }, maxChars: fixed })).toBeDefined()
  })
})

describe('episode identifiers and recall wording', () => {
  it('names an episode record by its session, turn, and final response, apart from conversation keys', () => {
    expect(episodeSourceUuid(SessionId('s'), 1, 6)).toBe('dsh:episode:s:1:6')
  })

  it('states which records the store holds for each ingest mode, and keeps the conversation wording', () => {
    expect(memoryRecallDescription('workspace', true, 'episodes')).toContain('Only verified episodes are stored: a finished turn that changed files and passed the verifier')
    expect(memoryRecallDescription('global', false, 'both')).toContain('User messages, final assistant replies, and verified episodes are stored')
    expect(memoryRecallDescription('global', false, 'both')).toContain('Recalled text records what was said or done then')
  })
})
