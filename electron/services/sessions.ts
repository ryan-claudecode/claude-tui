import * as pty from "node-pty"
import { existsSync } from "fs"
import { join } from "path"
import { BrowserWindow } from "electron"

export interface SessionInfo {
  id: string
  name: string
  cwd: string
  state: "active" | "idle" | "dead"
}

interface Session {
  id: string
  name: string
  cwd: string
  pty: pty.IPty
  state: "active" | "idle" | "dead"
}

/** Wrap a command in a shell so PATH resolution works reliably in Electron */
function shellWrap(command: string, args: string[]): { shell: string; shellArgs: string[] } {
  if (process.platform === "win32") {
    return {
      shell: "powershell.exe",
      shellArgs: ["-NoLogo", "-NoProfile", "-Command", [command, ...args].join(" ")],
    }
  }
  return {
    shell: "bash",
    shellArgs: ["-l", "-c", [command, ...args].join(" ")],
  }
}

export class SessionService {
  private sessions = new Map<string, Session>()
  private nextId = 1
  private mainWin: BrowserWindow | null = null
  private mcpConfigPath: string | null = null
  private defaultCommand = "claude"
  private defaultArgs = ["--dangerously-skip-permissions"]

  setMainWindow(win: BrowserWindow) {
    this.mainWin = win
  }

  setMcpConfigPath(path: string) {
    this.mcpConfigPath = path
  }

  setDefaults(command: string, args: string[]) {
    this.defaultCommand = command
    this.defaultArgs = args
  }

  private sendToRenderer(channel: string, ...args: unknown[]) {
    if (this.mainWin && !this.mainWin.isDestroyed()) {
      this.mainWin.webContents.send(channel, ...args)
    }
  }

  private attachPtyListeners(session: Session) {
    session.pty.onData((data) => {
      this.sendToRenderer("session:data", session.id, data)
    })

    session.pty.onExit(() => {
      session.state = "dead"
      this.sendToRenderer("session:exit", session.id)

      // Check for handoff file -- auto-respawn if present
      const handoffPath = join(session.cwd, "ephemeral", "handoff.md")
      if (existsSync(handoffPath)) {
        setTimeout(() => {
          const args = [...this.defaultArgs]
          if (this.mcpConfigPath) {
            args.push("--mcp-config", this.mcpConfigPath)
          }

          const { shell: hShell, shellArgs: hShellArgs } = shellWrap(
            this.defaultCommand, [...args, "continue from handoff"]
          )

          const newProc = pty.spawn(hShell, hShellArgs, {
            name: "xterm-256color",
            cols: session.pty.cols,
            rows: session.pty.rows,
            cwd: session.cwd,
            env: { ...process.env, CLAUDE_TUI: "1" } as Record<string, string>,
          })

          session.pty = newProc
          session.state = "active"
          this.attachPtyListeners(session)

          this.sendToRenderer("session:created", {
            id: session.id,
            name: session.name,
            cwd: session.cwd,
            state: "active",
          })
        }, 500)
      }
    })
  }

  create(name?: string, cwd?: string): SessionInfo {
    const id = `session-${this.nextId++}`
    const sessionName = name || id
    const sessionCwd = cwd || process.cwd()

    const args = [...this.defaultArgs]
    if (this.mcpConfigPath) {
      args.push("--mcp-config", this.mcpConfigPath)
    }

    const { shell, shellArgs } = shellWrap(this.defaultCommand, args)

    const proc = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: sessionCwd,
      env: {
        ...process.env,
        CLAUDE_TUI: "1",
      } as Record<string, string>,
    })

    const session: Session = {
      id,
      name: sessionName,
      cwd: sessionCwd,
      pty: proc,
      state: "active",
    }

    this.sessions.set(id, session)
    this.attachPtyListeners(session)

    const info: SessionInfo = { id, name: sessionName, cwd: sessionCwd, state: "active" }
    this.sendToRenderer("session:created", info)
    return info
  }

  kill(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.pty.kill()
    this.sessions.delete(id)
    return true
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      state: s.state,
    }))
  }

  rename(id: string, newName: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.name = newName
    return true
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (session) session.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (session) session.pty.resize(cols, rows)
  }

  handoff(id: string): boolean {
    const session = this.sessions.get(id)
    if (session) {
      session.pty.write("/handoff\r")
    }
    return true
  }

  focus(id: string): boolean {
    // Focus is primarily a renderer concern; main process just acknowledges
    return this.sessions.has(id)
  }

  splitPanes(leftId: string, rightId: string): boolean {
    if (!this.sessions.has(leftId) || !this.sessions.has(rightId)) return false
    this.sendToRenderer("split:set", leftId, rightId)
    return true
  }

  closeSplit(): boolean {
    this.sendToRenderer("split:close")
    return true
  }

  killAll(): void {
    for (const session of this.sessions.values()) {
      try {
        session.pty.kill()
      } catch {
        // Ignore cleanup errors
      }
    }
    this.sessions.clear()
  }
}
