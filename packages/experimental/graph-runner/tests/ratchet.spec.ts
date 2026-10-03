import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { captureScope, isBetter, parseMetric, removalCommand, restoreScope } from '../src/ratchet.ts'
import type { RatchetFiles } from '../src/ratchet.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A context whose file service is rooted at a fresh temporary workspace.
 * @returns the files, the workspace root, and the context.
 */
async function workspace(): Promise<{ files: RatchetFiles; root: string; ctx: Context }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ratchet-'))
  dirs.push(root)
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root })
  return { files: ctx.fs, root, ctx }
}

const never = new AbortController().signal

describe('parseMetric', () => {
  it('reads the last non-blank stdout line as a finite number', () => {
    expect(parseMetric('3\n')).toBe(3)
    expect(parseMetric('progress\n  2.5  \n\n')).toBe(2.5)
  })

  it('measures nothing from empty, non-numeric, or non-finite output', () => {
    expect(parseMetric('')).toBeNull()
    expect(parseMetric('\n \n')).toBeNull()
    expect(parseMetric('three')).toBeNull()
    expect(parseMetric('Infinity')).toBeNull()
  })
})

describe('isBetter', () => {
  it('prefers a higher metric under max and a lower one under min, and never a tie', () => {
    expect(isBetter(4, 3, 'max')).toBe(true)
    expect(isBetter(2, 3, 'max')).toBe(false)
    expect(isBetter(2, 3, 'min')).toBe(true)
    expect(isBetter(3, 3, 'max')).toBe(false)
    expect(isBetter(3, 3, 'min')).toBe(false)
  })
})

describe('removalCommand', () => {
  it('removes a shell-safe workspace path without quoting', () => {
    expect(removalCommand('src/extra.txt')).toBe('rm -f -- src/extra.txt')
    expect(removalCommand('src/a_b-c.1/file')).toBe('rm -f -- src/a_b-c.1/file')
  })

  it('refuses paths that would need quoting, escape the workspace, or are absolute', () => {
    expect(removalCommand('src/a b.txt')).toBeUndefined()
    expect(removalCommand('src/$(x).txt')).toBeUndefined()
    expect(removalCommand('../outside.txt')).toBeUndefined()
    expect(removalCommand('src/../../outside.txt')).toBeUndefined()
    expect(removalCommand('/etc/hosts')).toBeUndefined()
  })
})

describe('captureScope', () => {
  it('reads every file under a directory prefix and descends into subdirectories', async () => {
    const { files, root } = await workspace()
    mkdirSync(join(root, 'src/deep'), { recursive: true })
    writeFileSync(join(root, 'src/a.txt'), 'a\n')
    writeFileSync(join(root, 'src/deep/b.txt'), 'b\n')
    const snapshot = await captureScope(files, undefined, ['src'], 1024, never)
    expect(snapshot).toEqual(new Map([['src/a.txt', 'a\n'], ['src/deep/b.txt', 'b\n']]))
  })

  it('reads a file prefix and yields nothing for an absent prefix', async () => {
    const { files, root } = await workspace()
    writeFileSync(join(root, 'notes.md'), 'x')
    expect(await captureScope(files, undefined, ['notes.md', 'missing.txt'], 1024, never)).toEqual(new Map([['notes.md', 'x']]))
  })

  it('gives up when the text exceeds maxBytes', async () => {
    const { files, root } = await workspace()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/big.txt'), 'x'.repeat(64))
    expect(await captureScope(files, undefined, ['src'], 16, never)).toBeUndefined()
  })

  it('gives up on a file that is not text', async () => {
    const { files, root } = await workspace()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/blob.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x81]))
    expect(await captureScope(files, undefined, ['src'], 1024, never)).toBeUndefined()
  })

  it('gives up on an entry that is neither a file nor a directory', async () => {
    const { files, root } = await workspace()
    mkdirSync(join(root, 'src'))
    execFileSync('mkfifo', [join(root, 'src/pipe')])
    expect(await captureScope(files, undefined, ['src'], 1024, never)).toBeUndefined()
  })
})

describe('restoreScope', () => {
  it('rewrites changed kept files, removes files the kept state lacks, and leaves identical files alone', async () => {
    const { files, root } = await workspace()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/a.txt'), 'worse')
    writeFileSync(join(root, 'src/same.txt'), 'kept')
    writeFileSync(join(root, 'src/extra.txt'), 'created later')
    const kept = new Map([['src/a.txt', 'best'], ['src/same.txt', 'kept']])
    const current = await captureScope(files, undefined, ['src'], 1024, never)
    const removed: string[] = []
    const outcome = await restoreScope(files, undefined, kept, current, async (path) => {
      removed.push(path)
      rmSync(join(root, path))
      return true
    }, never)
    expect(outcome).toEqual({ restored: 2, leftovers: [] })
    expect(removed).toEqual(['src/extra.txt'])
    expect(await captureScope(files, undefined, ['src'], 1024, never)).toEqual(kept)
  })

  it('reports a file it cannot remove as a leftover', async () => {
    const { files, root } = await workspace()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/extra.txt'), 'stays')
    const current = await captureScope(files, undefined, ['src'], 1024, never)
    const outcome = await restoreScope(files, undefined, new Map(), current, async () => false, never)
    expect(outcome).toEqual({ restored: 0, leftovers: ['src/extra.txt'] })
  })

  it('writes the kept files without removing anything when the current scope cannot be read', async () => {
    const { files, root } = await workspace()
    mkdirSync(join(root, 'src'))
    const outcome = await restoreScope(files, undefined, new Map([['src/a.txt', 'best']]), undefined, async () => true, never)
    expect(outcome).toEqual({ restored: 1, leftovers: ['(the write scope could not be read)'] })
    expect(await captureScope(files, undefined, ['src'], 1024, never)).toEqual(new Map([['src/a.txt', 'best']]))
  })
})
