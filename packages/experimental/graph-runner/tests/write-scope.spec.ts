import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WriteScopes, writeViolation } from '../src/write-scope.ts'

describe('writeViolation', () => {
  it.each<[string[], string | undefined, string, string | undefined]>([
    [['src'], '/work', 'src/a.ts', undefined],
    [['src'], '/work', '/work/src/deep/a.ts', undefined],
    [['src'], '/work', 'src', undefined],
    [['src'], '/work', 'srcx/a.ts', 'srcx/a.ts is outside the write scopes src'],
    [['src'], '/work', '/elsewhere/a.ts', '/elsewhere/a.ts is outside the workspace'],
    [['src'], undefined, '/work/src/a.ts', '/work/src/a.ts is absolute and the session has no working directory'],
    [[], '/work', 'site/a.txt', 'site/a.txt is written by a node that declares no write scope'],
  ])('%j cwd=%s path=%s', (writes, cwd, path, expected) => {
    expect(writeViolation(writes, cwd, path)).toBe(expected)
  })
})

describe('WriteScopes', () => {
  it('checks only tracked child sessions and returns their violations once', () => {
    const scopes = new WriteScopes()
    const child = SessionId('child-1')
    const actor = { agent: { session: { header: { id: child } } } }
    scopes.track(child, ['src'], '/work')
    expect(scopes.check(actor, 'src/ok.ts')).toBeUndefined()
    expect(scopes.check(actor, 'site/no.txt')).toBe('site/no.txt is outside the write scopes src')
    expect(scopes.check({ agent: { session: { header: { id: SessionId('other') } } } }, 'site/no.txt')).toBeUndefined()
    expect(scopes.check(undefined, 'site/no.txt')).toBeUndefined()
    expect(scopes.check({}, 'site/no.txt')).toBeUndefined()
    expect(scopes.release(child)).toEqual(['site/no.txt is outside the write scopes src'])
    expect(scopes.release(child)).toEqual([])
  })
})
