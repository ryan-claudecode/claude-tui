import { shell } from "electron"

/**
 * ShellService — hand things off to the user's operating system.
 *
 * Lets Claude open a URL in the user's default browser (e.g. pop open a
 * localhost dev server it just started) or reveal a file/folder in the OS file
 * manager (Explorer/Finder). Thin wrapper over Electron's `shell`.
 */
export class ShellService {
  /** Open a URL (http/https/mailto) in the user's default external app. */
  async openExternal(url: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await shell.openExternal(url)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** Reveal a file or folder in the OS file manager, selecting it. */
  revealPath(path: string): { ok: boolean } {
    shell.showItemInFolder(path)
    return { ok: true }
  }
}
