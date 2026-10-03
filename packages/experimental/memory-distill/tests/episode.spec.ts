import { describe, expect, it } from 'vitest'
import { episodeEntry, episodeId, filterTransient } from '../src/episode.ts'

const MARKERS = ['this session', 'for now', 'today only']

describe('filterTransient', () => {
  it('drops sentences that carry a temporary marker, case-insensitively, and blank lines they leave', () => {
    expect(filterTransient('Added retry. For now, lint is skipped! Tests pass.\nThis session only.\n\nDone?', MARKERS)).toBe('Added retry. Tests pass.\nDone?')
    expect(filterTransient('For now, nothing.', MARKERS)).toBe('')
  })
})

describe('episodeId', () => {
  it('names the page by directory, date, sanitized session id, and turn', () => {
    expect(episodeId('episodes', 'lead', 3, '2026-09-30')).toBe('episodes/2026-09-30-lead-t3.md')
    expect(episodeId('episodes', 'a b/c:d-e_f.12345678901234567890', 1, '2026-09-30')).toBe('episodes/2026-09-30-a-b-c-d-e_f-123456789012-t1.md')
  })
})

describe('episodeEntry', () => {
  const base = {
    dir: 'episodes', sessionId: 'lead', turn: 2, date: '2026-09-30', markers: MARKERS, maxRequestChars: 1000, maxOutcomeChars: 12,
    changes: [{ path: 'src/retry.ts', seq: 7 }, { path: 'src/backoff.ts', seq: 9 }],
  }

  it('writes the request, the filtered outcome within its cap, the changed files, and the verdict', () => {
    const entry = episodeEntry({ ...base, request: 'Add retry to the client\nwith backoff', outcome: 'Added retry and backoff. For now, lint is off.', verdictSeq: 11 })
    expect(entry).toEqual({
      id: 'episodes/2026-09-30-lead-t2.md',
      type: 'episode',
      title: 'Turn 2: Add retry to the client',
      relations: [],
      body: [
        '## Request',
        '',
        'Add retry to the client\nwith backoff',
        '',
        '## Outcome',
        '',
        'Added retry …',
        '',
        '## Files changed',
        '',
        '- `src/retry.ts`',
        '- `src/backoff.ts`',
        '',
        '## Verification',
        '',
        'The verifier gate recorded verdict ok at session event 11.',
      ].join('\n'),
    })
  })

  it('marks missing text and a missing verdict', () => {
    const entry = episodeEntry({ ...base, request: null, outcome: 'For now, done.', verdictSeq: undefined })
    expect(entry.title).toBe('Turn 2: (no request text)')
    expect(entry.body).toContain('## Request\n\n(none)\n')
    expect(entry.body).toContain('## Outcome\n\n(none)\n')
    expect(entry.body.endsWith('No verifier verdict was recorded for this turn.')).toBe(true)
  })
})
