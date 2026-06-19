import { BrowserWindow } from "electron"
import { join } from "path"
import { getThemeMode } from "../config"

/**
 * The small surface of a companion window that CompanionService actually uses.
 * Narrowed from BrowserWindow so the service can be tested with a fake window
 * (see companion.test.ts). BrowserWindow structurally satisfies this.
 */
export interface CompanionWindowLike {
  webContents: {
    send(channel: string, ...args: unknown[]): void
    once(event: "did-finish-load", listener: () => void): void
  }
  on(event: "closed", listener: () => void): void
  show(): void
  moveTop(): void
  isDestroyed(): boolean
  loadURL(url: string): void
  loadFile(path: string): void
  close(): void
}

export class CompanionService {
  private win: CompanionWindowLike | null = null
  private mainWin: BrowserWindow | null = null
  private readyPromise: Promise<void> | null = null

  setMainWindow(win: BrowserWindow) {
    this.mainWin = win
  }

  /**
   * Constructs the real companion BrowserWindow and starts loading its content.
   * Overridable in tests to inject a fake window (the only test seam — production
   * behavior is unchanged).
   */
  protected createWindow(): CompanionWindowLike {
    const mode = getThemeMode()
    const bg = mode === "dark" ? "#1c1814" : mode === "cold-dark" ? "#0b0e14" : "#f8f4ed"

    // Position next to main window
    const mainBounds = this.mainWin?.getBounds()
    const x = mainBounds ? mainBounds.x + mainBounds.width + 8 : undefined
    const y = mainBounds?.y

    const win = new BrowserWindow({
      // Roomier default so diff/code/table panels aren't cramped next to the
      // larger main window (rich panels benefit from the extra height).
      width: 680,
      height: 860,
      minWidth: 380,
      minHeight: 320,
      x,
      y,
      title: "ClaudeTUI — Panels",
      backgroundColor: bg,
      frame: false,
      webPreferences: {
        preload: join(__dirname, "../preload/companion.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })

    if (process.env.ELECTRON_RENDERER_URL) {
      // Dev mode — electron-vite serves from a URL
      const baseUrl = process.env.ELECTRON_RENDERER_URL.replace(/\/[^/]*$/, "")
      win.loadURL(`${baseUrl}/src/companion/index.html`)
    } else {
      win.loadFile(join(__dirname, "../renderer/src/companion/index.html"))
    }

    return win
  }

  private getOrCreate(): { win: CompanionWindowLike; ready: Promise<void> } {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show()
      return { win: this.win, ready: this.readyPromise ?? Promise.resolve() }
    }

    const win = this.createWindow()
    this.win = win

    this.readyPromise = new Promise<void>((resolve) => {
      win.webContents.once("did-finish-load", () => resolve())
    })

    win.on("closed", () => {
      this.win = null
      this.readyPromise = null
    })

    return { win, ready: this.readyPromise }
  }

  /** Send a panel event to the companion window. Creates it if needed. */
  sendToCompanion(channel: string, ...args: unknown[]): void {
    const { win, ready } = this.getOrCreate()
    ready.then(() => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args)
      }
    })
  }

  /** Close the companion window if open. */
  close(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.close()
      this.win = null
    }
  }

  /** Check if the companion window exists and is visible. */
  isOpen(): boolean {
    return this.win != null && !this.win.isDestroyed()
  }

  /**
   * Bring the companion window to the top if it is already open. Does NOT
   * create the window — only acts when a panel is already showing (a tier-1
   * form should already have opened it). Used by the OS-notification click
   * handler so the form lands on top of the freshly-raised main window.
   */
  focusIfOpen(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show()
      this.win.moveTop()
    }
  }
}
