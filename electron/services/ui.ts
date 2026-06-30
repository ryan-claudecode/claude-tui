import { BrowserWindow } from "electron"

/**
 * UiService — lets MCP tools drive renderer-only UI state: focus (zen) mode, the
 * panel drawer, the overlays (command palette / shortcuts help / history search),
 * and log export. Each method emits a `ui:*` event the renderer listens for.
 *
 * This is the bridge for "view" actions that have no natural home in a
 * data-owning service — it holds the window and fans commands to the renderer,
 * mirroring how TerminalService drives split panes. The rule for full MCP
 * coverage: any new renderer-only affordance (a toggle, an overlay, a view
 * command) gets a method here + a tool, so Claude can control everything the
 * user can click or key-bind.
 *
 * Boolean methods take an optional desired state; omitting it toggles the
 * current renderer state.
 */
export class UiService {
  private mainWin: BrowserWindow | null = null

  setMainWindow(win: BrowserWindow) {
    this.mainWin = win
  }

  private emit(channel: string, ...args: unknown[]) {
    if (this.mainWin && !this.mainWin.isDestroyed()) {
      this.mainWin.webContents.send(channel, ...args)
    }
  }

  /** Toggle/set distraction-free focus mode (hides the sidebar + tab bar). */
  setFocusMode(enabled?: boolean) {
    this.emit("ui:focus-mode", enabled)
  }

  /** Toggle/set the command palette overlay. */
  setCommandPalette(open?: boolean) {
    this.emit("ui:command-palette", open)
  }

  /** Toggle/set the keyboard-shortcuts help overlay. */
  setShortcutsHelp(open?: boolean) {
    this.emit("ui:shortcuts-help", open)
  }

  /** Toggle/set the session-history search overlay. */
  setHistorySearch(open?: boolean) {
    this.emit("ui:history-search", open)
  }

  /** Trigger a download of a session's captured output (active session if omitted). */
  exportSessionLog(sessionId?: string) {
    this.emit("ui:export-log", sessionId ?? null)
  }
}
