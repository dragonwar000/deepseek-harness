import { Context } from '@deepseek-ai/cordis'
import type { AiAccountId, AiAccountStatus, AiAccountStatusView } from '@deepseek-ai/dsh-ai-account/types'
import { expect, it, vi } from 'vitest'
import { installAiAccountSignedOutPublisher } from '../src/ai-account-status.ts'

const view = (status: AiAccountStatus): AiAccountStatusView => ({ status, checkedAt: status === 'unknown' ? null : 1, message: null })

it('forwards only transitions into signedOut, once each, until the context is disposed', async () => {
  const ctx = new Context()
  const publish = vi.fn()
  const fiber = await ctx.plugin({ name: 'desktop-ai-account-status', apply: (child: Context) => { installAiAccountSignedOutPublisher(child, publish) } })
  const emit = (kind: 'claude' | 'chatgpt', previous: AiAccountStatus, current: AiAccountStatus) => {
    ctx.emit('ai-account/status-changed', { id: 'a' as AiAccountId, kind, isDefault: true, previous, current: view(current) })
  }
  emit('claude', 'unknown', 'signedIn')
  emit('claude', 'signedOut', 'signedIn')
  emit('claude', 'signedOut', 'unknown')
  expect(publish).not.toHaveBeenCalled()
  emit('claude', 'signedIn', 'signedOut')
  emit('chatgpt', 'unknown', 'signedOut')
  emit('claude', 'signedOut', 'signedOut')
  expect(publish.mock.calls).toEqual([['claude'], ['chatgpt']])
  await fiber.dispose()
  emit('claude', 'signedIn', 'signedOut')
  expect(publish).toHaveBeenCalledTimes(2)
})
