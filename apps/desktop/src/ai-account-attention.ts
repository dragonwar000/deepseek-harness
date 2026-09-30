/** Operating-system notification for an AI Account the Host reports signed out while the application is in the background. */
import { Notification } from 'electron'
import type { DesktopAiAccountKind } from './host-process.ts'
import type { DesktopLocale } from './locale.ts'

/** Main-window state the notification decision reads. */
export interface DesktopAiAccountWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
  isFocused(): boolean
}

/**
 * Decide whether a sign-out needs an operating-system notification.
 * @param window - Main window, or `undefined` when none exists.
 * @returns `false` only while the main window is shown and focused, where the AI Account page and
 *   the model picker already show the signed-out state.
 */
export function needsAiAccountNotification(window: DesktopAiAccountWindow | undefined): boolean {
  if (window === undefined || window.isDestroyed()) return true
  return !window.isVisible() || window.isMinimized() || !window.isFocused()
}

/** Owns at most one notification per account kind; a later sign-out of the same kind replaces it. */
export class DesktopAiAccountAttention {
  private readonly notifications = new Map<DesktopAiAccountKind, Notification>()

  /**
   * @param locale - Current shell-owned notification copy.
   * @param window - Current main window.
   * @param open - Shows and focuses the application after the notification is clicked.
   */
  constructor(
    private readonly locale: () => DesktopLocale,
    private readonly window: () => DesktopAiAccountWindow | undefined,
    private readonly open: () => void,
  ) {}

  /**
   * Notify about one transition into signed out unless the main window is in front.
   * @param kind - Kind of the signed-out account.
   */
  signedOut(kind: DesktopAiAccountKind): void {
    if (!needsAiAccountNotification(this.window())) return
    this.close(kind)
    try {
      if (!Notification.isSupported()) return
      const { messages } = this.locale()
      const notification = new Notification({
        title: kind === 'claude' ? messages.aiAccountSignedOutClaude : messages.aiAccountSignedOutChatgpt,
        body: messages.aiAccountSignedOutBody,
      })
      this.notifications.set(kind, notification)
      notification.on('failed', () => { this.forget(kind, notification) })
      notification.once('click', () => {
        if (this.notifications.get(kind) !== notification) return
        this.close(kind)
        this.open()
      })
      notification.show()
    } catch (error) { console.warn('desktop ai account: notification unavailable', error) }
  }

  /** Close every owned notification. */
  dispose(): void {
    for (const kind of [...this.notifications.keys()]) this.close(kind)
  }

  private close(kind: DesktopAiAccountKind): void {
    const notification = this.notifications.get(kind)
    if (notification === undefined) return
    this.forget(kind, notification)
    try { notification.close() }
    catch (error) { console.warn('desktop ai account: could not close notification', error) }
  }

  private forget(kind: DesktopAiAccountKind, notification: Notification): void {
    if (this.notifications.get(kind) === notification) this.notifications.delete(kind)
    notification.removeAllListeners()
  }
}
