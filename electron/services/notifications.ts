import { BrowserWindow } from "electron"

export type NotificationLevel = "info" | "success" | "warning" | "error"

export interface NotificationState {
  id: string
  level: NotificationLevel
  title?: string
  message: string
  timeout: number // ms before auto-dismiss; 0 = sticky
  createdAt: number
  /**
   * The work-session that raised this notification, when the caller is an
   * identity-bound terminal. Lets the attention queue enqueue an `error` entry
   * for an attributable error/warning toast. Absent = unattributable; behaves
   * exactly as today and never enqueues.
   */
  sessionId?: string
}

/**
 * NotificationService — toast notifications surfaced in the renderer.
 *
 * Lets a background Claude session announce that it finished a task, needs
 * input, or hit an error, even when its terminal isn't focused. State flows:
 * Claude -> MCP tool -> NotificationService -> IPC -> ToastHost (React).
 */
export class NotificationService {
  private notifications = new Map<string, NotificationState>()
  private mainWin: BrowserWindow | null = null
  private nextId = 1

  // Subscribers (AttentionService) observing every raised notification — the
  // error/warning-with-sessionId ones become tier-2 attention entries.
  private eventListeners = new Set<(n: NotificationState) => void>()

  /** Subscribe to raised notifications. Returns an unsubscribe fn. */
  onNotification(cb: (n: NotificationState) => void): () => void {
    this.eventListeners.add(cb)
    return () => this.eventListeners.delete(cb)
  }

  setMainWindow(win: BrowserWindow) {
    this.mainWin = win
  }

  private sendToRenderer(channel: string, ...args: unknown[]) {
    if (this.mainWin && !this.mainWin.isDestroyed()) {
      this.mainWin.webContents.send(channel, ...args)
    }
  }

  notify(
    message: string,
    level: NotificationLevel = "info",
    title?: string,
    timeout = 5000,
    sessionId?: string,
  ): NotificationState {
    const id = `notif-${this.nextId++}`
    const notification: NotificationState = {
      id,
      level,
      title,
      message,
      timeout,
      createdAt: Date.now(),
      ...(sessionId ? { sessionId } : {}),
    }
    this.notifications.set(id, notification)
    this.sendToRenderer("notification:show", notification)
    for (const cb of this.eventListeners) cb(notification)
    return notification
  }

  dismiss(id: string): boolean {
    if (!this.notifications.delete(id)) return false
    this.sendToRenderer("notification:dismiss", id)
    return true
  }

  list(): NotificationState[] {
    return Array.from(this.notifications.values())
  }
}
