import { BrowserWindow } from "electron"
import { execSync } from "child_process"

export class AppService {
  private mainWin: BrowserWindow | null = null
  private projectRoot: string = process.cwd()

  setMainWindow(win: BrowserWindow) {
    this.mainWin = win
  }

  setProjectRoot(root: string) {
    this.projectRoot = root
  }

  async captureScreenshot(): Promise<string> {
    if (!this.mainWin || this.mainWin.isDestroyed()) {
      throw new Error("No window available")
    }
    const image = await this.mainWin.webContents.capturePage()
    return image.toPNG().toString("base64")
  }

  getAppState(sessions: any[], workspaces: any[]): object {
    return {
      windowBounds: this.mainWin?.getBounds(),
      isVisible: this.mainWin?.isVisible(),
      sessions,
      workspaces,
    }
  }

  runBuild(): { success: boolean; output: string } {
    try {
      const output = execSync("npx electron-vite build", {
        cwd: this.projectRoot,
        encoding: "utf8",
        timeout: 60000,
      })
      return { success: true, output }
    } catch (e: any) {
      return { success: false, output: `${e.stdout ?? ""}\n${e.stderr ?? ""}` }
    }
  }
}
