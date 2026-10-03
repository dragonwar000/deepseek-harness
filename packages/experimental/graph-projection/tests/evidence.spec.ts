import { describe, expect, it } from 'vitest'
import {
  argumentStrings, claimOf, claimsOf, commandOf, edgeClaimOf, leavesFor, pathMatches, pathOf, pathsIn, withMentions,
} from '../src/evidence.ts'
import type { EvidenceLeaf } from '../src/types.ts'

describe('paths and commands', () => {
  it.each<[string, boolean, string | undefined]>([
    ['src/app.ts', false, 'src/app.ts'],
    ['./src/app.ts:42:7.', false, 'src/app.ts'],
    ['/etc/hosts', false, '/etc/hosts'],
    ['~/notes', false, '~/notes'],
    ['pkgs/graph-runner/', false, undefined],
    ['pkgs/graph-runner/', true, 'pkgs/graph-runner'],
    ['and/or', false, undefined],
    ['README.md', false, undefined],
    ['README.md', true, 'README.md'],
    ['e.g', true, undefined],
    ['v1.2', true, undefined],
    ['https://example.com/a.ts', true, undefined],
    ['--filter', true, undefined],
    ['/', true, undefined],
    ['/./', true, undefined],
  ])('reads %j (loose %s) as %j', (token, loose, expected) => {
    expect(pathOf(token, loose)).toBe(expected)
  })

  it('collects distinct paths from text', () => {
    expect(pathsIn('Edited src/a.ts and "src/b.ts"; see src/a.ts:3 (notes/c.md)', false)).toEqual(['src/a.ts', 'src/b.ts', 'notes/c.md'])
  })

  it('reads a single-line value with a space as a command', () => {
    expect(commandOf('  pnpm   test --filter x ')).toBe('pnpm test --filter x')
    expect(commandOf('pnpm')).toBeUndefined()
    expect(commandOf('cat <<EOF\nx\nEOF')).toBeUndefined()
  })

  it('classifies one cited claim', () => {
    expect(claimOf(' pnpm test ')).toEqual({ kind: 'command', text: 'pnpm test' })
    expect(claimOf('src/app.ts:9')).toEqual({ kind: 'path', text: 'src/app.ts' })
    expect(claimOf('hello')).toBeUndefined()
    expect(claimOf('two\nlines')).toBeUndefined()
  })

  it('reads the claims of an answer from inline code and rooted or file-like prose paths, not from fences', () => {
    const answer = [
      'I updated `src/app.ts` and ran `pnpm test`; see notes/guide.md and and/or `helper`.',
      '```sh\npnpm build src/ignored.ts\n```',
      'Also `src/app.ts` again, and src/app.ts in prose.',
    ].join('\n')
    expect(claimsOf(answer)).toEqual([
      { kind: 'path', text: 'src/app.ts' },
      { kind: 'command', text: 'pnpm test' },
      { kind: 'path', text: 'notes/guide.md' },
    ])
  })

  it('reads knowledge edge ids from inline code and prose tokens', () => {
    expect(edgeClaimOf(' e:0a1b2c3d. ')).toEqual({ kind: 'edge', text: 'e:0a1b2c3d' })
    expect(edgeClaimOf('e:0A1B2C3D')).toBeUndefined()
    expect(edgeClaimOf('e:0a1b2c3')).toBeUndefined()
    expect(claimOf('e:0a1b2c3d')).toBeUndefined()
    expect(claimsOf('Edge `e:0a1b2c3d` links notes/a.md; so does e:99aabbcc, and `e:0a1b2c3d` again.')).toEqual([
      { kind: 'edge', text: 'e:0a1b2c3d' },
      { kind: 'path', text: 'notes/a.md' },
      { kind: 'edge', text: 'e:99aabbcc' },
    ])
  })

  it('reads every string in tool arguments and nothing from malformed arguments', () => {
    expect(argumentStrings('{"path":"src/a.ts","opts":{"lines":[1,"x y"],"on":true,"none":null}}')).toEqual(['src/a.ts', 'x y'])
    expect(argumentStrings('"pnpm test"')).toEqual(['pnpm test'])
    expect(argumentStrings('{"path": ')).toEqual([])
  })
})

describe('mentions and leaves', () => {
  const leaf = (kind: EvidenceLeaf['kind'], seq: number, tool = 'read'): EvidenceLeaf => ({ kind, seq, tool })

  it('keeps mentions sorted and one latest leaf per kind', () => {
    const first = withMentions([], ['src/b.ts', 'src/a.ts'], leaf('tool-record', 3))
    const second = withMentions(first, ['src/b.ts'], leaf('observed', 4))
    const third = withMentions(second, ['src/b.ts'], leaf('tool-record', 7, 'edit'))
    expect(third).toEqual([
      { text: 'src/a.ts', leaves: [leaf('tool-record', 3)] },
      { text: 'src/b.ts', leaves: [leaf('tool-record', 7, 'edit'), leaf('observed', 4)] },
    ])
  })

  it('matches paths by suffix on a segment boundary and commands by inclusion', () => {
    expect(pathMatches('src/a.ts', 'src/a.ts')).toBe(true)
    expect(pathMatches('src/a.ts', '/work/repo/src/a.ts')).toBe(true)
    expect(pathMatches('/work/repo/src/a.ts', 'src/a.ts')).toBe(true)
    expect(pathMatches('a.ts', 'src/data.ts')).toBe(false)
    const paths = [
      { text: '/work/src/a.ts', leaves: [leaf('observed', 9)] },
      { text: 'src/a.ts', leaves: [leaf('observed', 5), leaf('absence', 2)] },
    ]
    const commands = [{ text: 'pnpm test --filter x', leaves: [leaf('tool-record', 4, 'bash')] }]
    expect(leavesFor({ kind: 'path', text: 'src/a.ts' }, paths, commands)).toEqual([leaf('observed', 9), leaf('absence', 2)])
    expect(leavesFor({ kind: 'command', text: 'pnpm test' }, paths, commands)).toEqual([leaf('tool-record', 4, 'bash')])
    expect(leavesFor({ kind: 'path', text: 'notes/x.md' }, paths, commands)).toEqual([])
    expect(leavesFor({ kind: 'edge', text: 'e:0a1b2c3d' }, [{ text: 'e:0a1b2c3d', leaves: [leaf('observed', 3)] }], commands)).toEqual([])
  })
})
