/** Shell-initiated requests to open the Web UI's Settings dialog on one section. */
import { DESKTOP_IPC } from './ipc.ts'

/** Settings section ids the shell requests; each must match a `settings.section` registration in the Web UI. */
export type DesktopSettingsSectionId = 'ai-account'

/** Main-window renderer the request signal reaches. */
export interface DesktopSettingsRenderer {
  isDestroyed(): boolean
  send(channel: typeof DESKTOP_IPC.settingsRequested): void
}

/**
 * Holds the latest unread request until the application document takes it. The renderer reads it on
 * subscribe and after each `settingsRequested` signal, so a request made while the window is closed or
 * still loading opens Settings once the Web UI subscribes.
 */
export class DesktopSettingsRequest {
  private pending: DesktopSettingsSectionId | undefined

  /** @param renderer - Current main-window renderer, or `undefined` when none exists. */
  constructor(private readonly renderer: () => DesktopSettingsRenderer | undefined) {}

  /**
   * Record a request and signal the current renderer; a later request replaces an unread one.
   * @param sectionId - Settings section to open.
   */
  open(sectionId: DesktopSettingsSectionId): void {
    this.pending = sectionId
    const renderer = this.renderer()
    if (renderer !== undefined && !renderer.isDestroyed()) renderer.send(DESKTOP_IPC.settingsRequested)
  }

  /**
   * Consume the unread request.
   * @returns The requested section id, or `undefined` when none is unread.
   */
  take(): DesktopSettingsSectionId | undefined {
    const sectionId = this.pending
    this.pending = undefined
    return sectionId
  }
}
