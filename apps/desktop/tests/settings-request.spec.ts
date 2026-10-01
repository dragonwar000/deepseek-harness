import { expect, it, vi } from 'vitest'
import type { DesktopSettingsBridge } from '@deepseek-ai/dsh-client-ui-settings-general/types'
import { DESKTOP_IPC, type DshDesktopProductApi } from '../src/ipc.ts'
import { DesktopSettingsRequest, type DesktopSettingsRenderer } from '../src/settings-request.ts'

it('keeps the Desktop settings bridge assignable to the Settings shell consumer', () => {
  const assign = (bridge: DshDesktopProductApi['settings']): DesktopSettingsBridge => bridge
  expect(assign).toBeTypeOf('function')
})

it('signals the live renderer and hands the request to exactly one reader', () => {
  const send = vi.fn()
  const renderer: DesktopSettingsRenderer = { isDestroyed: () => false, send }
  const request = new DesktopSettingsRequest(() => renderer)
  expect(request.take()).toBeUndefined()
  request.open('ai-account')
  expect(send).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.settingsRequested)
  expect(request.take()).toBe('ai-account')
  expect(request.take()).toBeUndefined()
})

it('keeps a request made without a live renderer for the next reader', () => {
  const send = vi.fn()
  const renderers: Array<DesktopSettingsRenderer | undefined> = [undefined, { isDestroyed: () => true, send }]
  const request = new DesktopSettingsRequest(() => renderers.shift())
  request.open('ai-account')
  request.open('ai-account')
  expect(send).not.toHaveBeenCalled()
  expect(request.take()).toBe('ai-account')
})
