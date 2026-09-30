import { afterEach, expect, it, vi } from 'vitest'
import { DesktopAiAccountAttention, needsAiAccountNotification, type DesktopAiAccountWindow } from '../src/ai-account-attention.ts'
import { resolveDesktopLocale } from '../src/locale.ts'

const native = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const notices: Notice[] = []
  class Notice extends EventEmitter {
    static isSupported = vi.fn(() => true)
    show = vi.fn()
    close = vi.fn()
    constructor(readonly options: unknown) { super(); notices.push(this) }
  }
  return { notices, Notice }
})
vi.mock('electron', () => ({ Notification: native.Notice }))

let attention: DesktopAiAccountAttention | undefined
afterEach(() => { attention?.dispose(); native.notices.length = 0; vi.clearAllMocks(); native.Notice.isSupported.mockReturnValue(true) })

function windowState(state: { destroyed?: boolean; visible?: boolean; minimized?: boolean; focused?: boolean }): DesktopAiAccountWindow {
  return {
    isDestroyed: () => state.destroyed ?? false,
    isVisible: () => state.visible ?? true,
    isMinimized: () => state.minimized ?? false,
    isFocused: () => state.focused ?? true,
  }
}

function setup(window: DesktopAiAccountWindow | undefined, language = 'en') {
  const open = vi.fn()
  attention = new DesktopAiAccountAttention(() => resolveDesktopLocale(language), () => window, open)
  return { open, attention }
}

it('notifies only while the main window is missing, hidden, minimized, or unfocused', () => {
  expect(needsAiAccountNotification(windowState({}))).toBe(false)
  expect(needsAiAccountNotification(undefined)).toBe(true)
  expect(needsAiAccountNotification(windowState({ destroyed: true }))).toBe(true)
  expect(needsAiAccountNotification(windowState({ visible: false }))).toBe(true)
  expect(needsAiAccountNotification(windowState({ minimized: true }))).toBe(true)
  expect(needsAiAccountNotification(windowState({ focused: false }))).toBe(true)
  setup(windowState({})).attention.signedOut('claude')
  expect(native.notices).toHaveLength(0)
})

it('shows one notification per sign-out and opens the application on click', () => {
  const { open, attention } = setup(windowState({ focused: false }))
  attention.signedOut('claude')
  expect(native.notices).toHaveLength(1)
  expect(native.notices[0]!.options).toEqual({ title: 'Claude account signed out', body: 'Open Settings → AI Account to sign in again.' })
  expect(native.notices[0]!.show).toHaveBeenCalledOnce()
  native.notices[0]!.emit('click')
  expect(open).toHaveBeenCalledOnce()
  expect(native.notices[0]!.close).toHaveBeenCalledOnce()
  // A click on a replaced notification opens nothing.
  attention.signedOut('chatgpt')
  const first = native.notices[1]!
  attention.signedOut('chatgpt')
  expect(first.close).toHaveBeenCalledOnce()
  first.emit('click')
  expect(open).toHaveBeenCalledOnce()
  expect(native.notices).toHaveLength(3)
})

it('uses the Chinese copy, forgets failed notifications, and closes the rest on dispose', () => {
  const { attention } = setup(undefined, 'zh')
  attention.signedOut('chatgpt')
  expect(native.notices[0]!.options).toEqual({ title: 'ChatGPT 账号已退出登录', body: '打开「设置 → AI 账号」重新登录。' })
  native.notices[0]!.emit('failed')
  attention.signedOut('claude')
  attention.dispose()
  expect(native.notices[0]!.close).not.toHaveBeenCalled()
  expect(native.notices[1]!.close).toHaveBeenCalledOnce()
})

it('stays silent where notifications are unsupported or fail', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const { attention } = setup(undefined)
  native.Notice.isSupported.mockReturnValue(false)
  attention.signedOut('claude')
  expect(native.notices).toHaveLength(0)
  native.Notice.isSupported.mockImplementation(() => { throw new Error('no notification center') })
  attention.signedOut('claude')
  expect(warn).toHaveBeenCalledWith('desktop ai account: notification unavailable', expect.any(Error))
  native.Notice.isSupported.mockReturnValue(true)
  attention.signedOut('claude')
  native.notices[0]!.close.mockImplementation(() => { throw new Error('gone') })
  attention.dispose()
  expect(warn).toHaveBeenCalledWith('desktop ai account: could not close notification', expect.any(Error))
})
