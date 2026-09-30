/** Locale-owned provider copy: which routes state more than their adapter's own name, and what. */
import { describe, expect, it } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { en, zh } from '../src/client/locales.ts'
import { providerCopy } from '../src/client/provider-copy.ts'

/** A translator over one shipped dictionary, so the test reads the real copy. */
function translator(dict: typeof en): TranslateNS<'model'> {
  return ((key: keyof typeof en) => dict[key]) as TranslateNS<'model'>
}

describe('providerCopy', () => {
  it('leaves an ordinary route to its own name and states nothing extra', () => {
    expect(providerCopy('deepseek-official', translator(en))).toEqual({ label: undefined, note: undefined })
  })

  it('localizes the DeepSeek account route without a note', () => {
    expect(providerCopy('deepseek-account', translator(en)))
      .toEqual({ label: 'DeepSeek Account', note: undefined })
    expect(providerCopy('deepseek-account', translator(zh)).label).toBe('DeepSeek 账号')
  })

  it('states that the Claude CLI route is subscription-backed and runs through the vendor CLI', () => {
    const english = providerCopy('claude-cli', translator(en))
    expect(english.label).toBe('Claude (Claude Code CLI)')
    expect(english.note).toContain('subscription')
    expect(english.note).toContain('Claude Code CLI')
    const chinese = providerCopy('claude-cli', translator(zh))
    expect(chinese.label).toBe('Claude（Claude Code CLI）')
    expect(chinese.note).toContain('订阅')
    expect(chinese.note).toContain('Claude Code CLI')
  })
})
