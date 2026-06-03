import { app, ipcMain, BrowserWindow } from "electron"
import * as pty from "node-pty"
import { existsSync } from "fs"
import { join } from "path"
import { discoverWorkspaces, type Workspace } from "./workspace/discovery"
import { loadConfig } from "./config"

interface Session {
  id: string
  name: string
  cwd: string
  pty: pty.IPty
  state: "active" | "idle" | "dead"
}

const sessions: Map<string, Session> = new Map()
let nextId = 1
let workspaces: Workspace[] = []
let mainWin: BrowserWindow | null = null

function sendToRenderer(channel: string, ...args: unknown[]) {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send(channel, ...args)
  }
}

function attachPtyListeners(session: Session) {
  session.pty.onData((data) => {
    sendToRenderer("session:data", session.id, data)
  })

  session.pty.onExit(() => {
    session.state = "dead"
    sendToRenderer("session:exit", session.id)

    // Check for handoff file — auto-respawn if present
    const handoffPath = join(session.cwd, "ephemeral", "handoff.md")
    if (existsSync(handoffPath)) {
      setTimeout(() => {
        const newProc = pty.spawn("claude", ["--dangerously-skip-permissions", "continue from handoff"], {
          name: "xterm-256color",
          cols: session.pty.cols,
          rows: session.pty.rows,
          cwd: session.cwd,
          env: { ...process.env, CLAUDE_TUI: "1" } as Record<string, string>,
        })

        session.pty = newProc
        session.state = "active"
        attachPtyListeners(session)

        sendToRenderer("session:created", {
          id: session.id,
          name: session.name,
          cwd: session.cwd,
          state: "active",
        })
      }, 500)
    }
  })
}

function createSessionInternal(name: string, cwd: string): { id: string; name: string; cwd: string; state: string } {
  const id = `session-${nextId++}`
  const sessionName = name || id
  const sessionCwd = cwd || process.cwd()

  const shell = process.platform === "win32" ? "powershell.exe" : "bash"

  const proc = pty.spawn(shell, [], {
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

  sessions.set(id, session)
  attachPtyListeners(session)

  const info = { id, name: sessionName, cwd: sessionCwd, state: "active" }
  sendToRenderer("session:created", info)
  return info
}

export function setupIpc(win: BrowserWindow) {
  mainWin = win

  // Load workspaces
  const config = loadConfig()
  workspaces = discoverWorkspaces(config.workspaceScanPaths)

  // Create session
  ipcMain.handle("session:create", (_e, name: string, cwd: string) => {
    return createSessionInternal(name, cwd)
  })

  // Kill session
  ipcMain.handle("session:kill", (_e, id: string) => {
    const session = sessions.get(id)
    if (!session) return false
    session.pty.kill()
    sessions.delete(id)
    return true
  })

  // Focus session (renderer-side concern, but track it)
  ipcMain.handle("session:focus", (_e, _id: string) => {
    return true
  })

  // List sessions
  ipcMain.handle("session:list", () => {
    return Array.from(sessions.values()).map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      state: s.state,
    }))
  })

  // Write to session PTY
  ipcMain.on("session:write", (_e, id: string, data: string) => {
    const session = sessions.get(id)
    if (session) session.pty.write(data)
  })

  // Resize session PTY
  ipcMain.on("session:resize", (_e, id: string, cols: number, rows: number) => {
    const session = sessions.get(id)
    if (session) session.pty.resize(cols, rows)
  })

  // List workspaces
  ipcMain.handle("workspace:list", () => {
    return workspaces.map((ws) => ({
      name: ws.name,
      alias: ws.alias,
      editor: ws.editor,
      repos: ws.repos,
    }))
  })

  // Activate workspace — create sessions for each repo
  ipcMain.handle("workspace:activate", (_e, index: number) => {
    const ws = workspaces[index]
    if (!ws) return null

    const created = []
    for (const repo of ws.repos) {
      const repoPath = repo.path.replace(/^~/, process.env.HOME ?? process.env.USERPROFILE ?? "")
      const info = createSessionInternal(repo.name, repoPath)
      created.push(info)
    }
    return { workspace: ws.name, sessions: created }
  })

  // Handoff
  ipcMain.handle("session:handoff", (_e, id: string) => {
    const session = sessions.get(id)
    if (session) {
      session.pty.write("/handoff\r")
    }
    return true
  })

  // Cleanup on app quit
  app.on("before-quit", () => {
    for (const session of sessions.values()) {
      try {
        session.pty.kill()
      } catch {
        // Ignore cleanup errors
      }
    }
    sessions.clear()
  })
}
