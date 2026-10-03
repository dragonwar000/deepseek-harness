import { describe, expect, it } from 'vitest'
import { normalizeStoreRoot, shellWriteReason, STORE_WRITE_REASON } from '../src/shell.ts'

describe('shellWriteReason', () => {
  it.each([
    'echo x > knowledge/concepts/a.md',
    'echo x >> knowledge/a.md',
    'echo x >knowledge/a.md',
    'echo x > /work/repo/knowledge/a.md',
    'printf x | tee knowledge/a.md',
    'tee -a knowledge/a.md < notes.txt',
    'touch knowledge/concepts/new.md',
    "sed -i 's/a/b/' knowledge/concepts/a.md",
    "sed -i.bak -e 's/a/b/' ./knowledge/a.md",
    "perl -pi -e 's/a/b/' knowledge/a.md",
    'rm -rf knowledge',
    'rm knowledge/concepts/a.md && echo done',
    'mv knowledge/a.md /tmp/a.md',
    'git mv knowledge/a.md knowledge/b.md',
    'git checkout -- knowledge/a.md',
    'cp notes.md knowledge/concepts/n.md',
    'rsync -a src/ knowledge/',
    'mkdir -p knowledge/concepts',
    'truncate -s 0 knowledge/a.md',
    'Set-Content -Path knowledge/a.md -Value x',
    'remove-item knowledge/a.md',
  ])('refuses %s', (command) => {
    expect(shellWriteReason(command, 'knowledge')).toBe(STORE_WRITE_REASON)
  })

  it.each([
    'cat knowledge/concepts/a.md',
    'grep -rn retry knowledge/',
    'cp knowledge/a.md /tmp/a.md',
    'ls knowledge > /tmp/list.txt',
    'echo knowledge > notes.txt',
    'rm -rf build && echo knowledge',
    'touch notes/knowledge.md',
    'touch knowledgebase/x.md',
    'git status knowledge',
  ])('allows %s', (command) => {
    expect(shellWriteReason(command, 'knowledge')).toBeUndefined()
  })

  it('normalizes the root and escapes pattern characters', () => {
    expect(normalizeStoreRoot(' ./team/k.b/ ')).toBe('team/k.b')
    expect(shellWriteReason('touch team/k.b/x.md', './team/k.b/')).toBe(STORE_WRITE_REASON)
    expect(shellWriteReason('touch team/kxb/x.md', 'team/k.b')).toBeUndefined()
  })
})
