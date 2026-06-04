import * as pty from "node-pty"
import { existsSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs"
import { join } from "path"
import { tmpdir, homedir } from "os"
import { BrowserWindow } from "electron"

/**
 * Encode an absolute cwd into the directory name Claude Code uses under
 * ~/.claude/projects/. CC replaces every path separator and the drive colon
 * with "-": "C:\\Users\\ryguy\\app" -> "C--Users-ryguy-app".
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[:\\/]/g, "-")
}

/**
 * Resolve the Claude Code conversation id for a terminal by finding the newest
 * transcript .jsonl in ~/.claude/projects/<encoded-cwd>/ whose mtime is at or
 * after the terminal's spawn time (minus a small skew). Returns the uuid (file
 * basename) or undefined if CC hasn't written one yet.
 *
 * `projectsRoot` is injectable for tests; production passes
 * join(homedir(), ".claude", "projects").
 */
export function resolveTranscriptId(
  projectsRoot: string,
  cwd: string,
  spawnedAt: number,
): string | undefined {
  const dir = join(projectsRoot, encodeProjectDir(cwd))
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return undefined
  }
  const skewMs = 2000
  let best: { id: string; mtime: number } | undefined
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue
    let mtime: number
    try {
      mtime = statSync(join(dir, f)).mtimeMs
    } catch {
      continue
    }
    if (mtime < spawnedAt - skewMs) continue
    if (!best || mtime > best.mtime) best = { id: f.slice(0, -".jsonl".length), mtime }
  }
  return best?.id
}

/**
 * The extra CLI args to reattach a terminal to its prior Claude Code chat:
 * ["--resume", id] when we have an id AND its transcript still exists on disk,
 * otherwise [] (spawn fresh — the always-works fallback).
 */
export function resumeArgs(
  projectsRoot: string,
  cwd: string,
  ccConversationId: string | undefined,
): string[] {
  if (!ccConversationId) return []
  const file = join(projectsRoot, encodeProjectDir(cwd), `${ccConversationId}.jsonl`)
  return existsSync(file) ? ["--resume", ccConversationId] : []
}

export interface TerminalInfo {
  id: string
  name: string
  cwd: string
  state: "active" | "idle" | "dead"
}

interface Terminal {
  id: string
  name: string
  cwd: string
  pty: pty.IPty
  state: "active" | "idle" | "dead"
  /** Epoch ms of the last terminal output — drives idle detection. */
  lastActivity: number
}

/** Per-session activity snapshot for the "which session needs me?" view. */
export interface TerminalActivity {
  id: string
  name: string
  state: "active" | "idle" | "dead"
  /** Milliseconds since the session last produced output. */
  idleMs: number
}

export type TerminalEvent =
  | { type: "created"; info: TerminalInfo }
  | { type: "state"; id: string; state: "active" | "idle" | "dead" }
  | { type: "exit"; id: string }
  | { type: "convo"; id: string; ccConversationId: string }

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

/** Strip ANSI escape sequences so captured output is searchable plain text. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g

export interface OutputMatch {
  /** Session the match came from. */
  sessionId: string
  /** Session name for display. */
  name: string
  /** 0-based line index within the captured buffer. */
  line: number
  /** The matching line text. */
  text: string
}

export class TerminalService {
  private sessions = new Map<string, Terminal>()
  /** Bounded plain-text scrollback per session, for history search/review. */
  private outputBuffers = new Map<string, string>()
  /** Max characters of scrollback retained per session. */
  private readonly maxBufferChars = 100_000
  private nextId = 1
  private mainWin: BrowserWindow | null = null
  private mcpConfigPath: string | null = null
  private mcpServerUrl: string | null = null
  private ccProjectsRoot = join(homedir(), ".claude", "projects")
  private defaultCommand = "claude"
  private defaultArgs = ["--dangerously-skip-permissions"]
  /** Quiet period after which a live session is considered idle (waiting). */
  private readonly idleThresholdMs = 1500
  private idleTimer: ReturnType<typeof setInterval> | null = null

  private eventListeners = new Set<(e: TerminalEvent) => void>()

  /** Subscribe to in-process terminal lifecycle events. Returns an unsubscribe fn. */
  onEvent(cb: (e: TerminalEvent) => void): () => void {
    this.eventListeners.add(cb)
    return () => this.eventListeners.delete(cb)
  }

  private emitEvent(e: TerminalEvent): void {
    for (const cb of this.eventListeners) cb(e)
  }

  setMainWindow(win: BrowserWindow) {
    this.mainWin = win
    this.startIdleMonitor()
  }

  /**
   * Poll for sessions that have gone quiet and flip them active → idle. A single
   * shared timer covers every session, so cost is O(sessions) once per second.
   */
  private startIdleMonitor() {
    if (this.idleTimer) return
    this.idleTimer = setInterval(() => {
      const now = Date.now()
      for (const session of this.sessions.values()) {
        if (session.state === "active" && now - session.lastActivity > this.idleThresholdMs) {
          session.state = "idle"
          this.sendToRenderer("session:state", session.id, "idle")
          this.emitEvent({ type: "state", id: session.id, state: "idle" })
        }
      }
    }, 1000)
  }

  /** Record output activity and flip a session back to active if it was idle. */
  private markActive(session: Terminal) {
    session.lastActivity = Date.now()
    if (session.state === "idle") {
      session.state = "active"
      this.sendToRenderer("session:state", session.id, "active")
      this.emitEvent({ type: "state", id: session.id, state: "active" })
    }
  }

  setMcpConfigPath(path: string) {
    this.mcpConfigPath = path
  }

  /** Base SSE URL (e.g. http://127.0.0.1:PORT/sse) used to mint per-terminal,
   *  identity-bound MCP configs so a spawned terminal's tools know its own ids. */
  setMcpServerUrl(url: string) {
    this.mcpServerUrl = url
  }

  /**
   * Write a per-terminal MCP config whose SSE URL carries this terminal's
   * identity (sid/tid), and return its path. Falls back to the shared config
   * (no identity) when we don't have a server URL or a work-session id yet.
   */
  private mcpConfigFor(terminalId: string, sessionId?: string): string | null {
    if (!this.mcpServerUrl || !sessionId) return this.mcpConfigPath
    const configDir = join(tmpdir(), "claudetui")
    mkdirSync(configDir, { recursive: true })
    const path = join(configDir, `mcp-config-${terminalId}.json`)
    const url = `${this.mcpServerUrl}?sid=${encodeURIComponent(sessionId)}&tid=${encodeURIComponent(terminalId)}`
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { claudetui: { type: "sse", url } } }, null, 2),
    )
    return path
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
      this.captureOutput(session.id, data)
      this.markActive(session)
    })

    session.pty.onExit(() => {
      session.state = "dead"
      this.sendToRenderer("session:exit", session.id)
      this.emitEvent({ type: "exit", id: session.id })

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
          session.lastActivity = Date.now()
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

  create(name?: string, cwd?: string, sessionId?: string, resumeConvId?: string): TerminalInfo {
    // Unique, collision-proof id. Must NOT be a resettable counter: nextId
    // resets to 1 on every app restart, so a counter-based id collides with
    // terminal refs persisted by prior runs — two work sessions would then
    // share an id and reconcile() would fold one terminal's state into the
    // wrong session (the shared-green-dot bug). The display name keeps the
    // friendly per-run sequence.
    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const sessionName = name || `session-${this.nextId++}`
    const sessionCwd = cwd || process.cwd()

    const args = [...this.defaultArgs]
    for (const a of resumeArgs(this.ccProjectsRoot, sessionCwd, resumeConvId)) args.push(a)
    // Prefer a per-terminal, identity-bound MCP config so this terminal's
    // work-session tools default to its own ids; fall back to the shared config.
    const mcpConfig = this.mcpConfigFor(id, sessionId)
    if (mcpConfig) {
      args.push("--mcp-config", mcpConfig)
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
        ...(sessionId ? { CLAUDETUI_SESSION_ID: sessionId } : {}),
        CLAUDETUI_TERMINAL_ID: id,
      } as Record<string, string>,
    })

    const session: Terminal = {
      id,
      name: sessionName,
      cwd: sessionCwd,
      pty: proc,
      state: "active",
      lastActivity: Date.now(),
    }

    this.sessions.set(id, session)
    this.attachPtyListeners(session)

    const info: TerminalInfo = { id, name: sessionName, cwd: sessionCwd, state: "active" }
    this.sendToRenderer("session:created", info)
    this.emitEvent({ type: "created", info })
    this.captureConversationId(id, sessionCwd, Date.now())
    return info
  }

  /**
   * Poll briefly for the Claude Code transcript this terminal just started
   * writing, and emit a `convo` event once found so the container can record
   * ccConversationId for --resume. Best-effort: gives up after a few seconds
   * (the durable session record, not CC internals, is the source of truth).
   */
  private captureConversationId(id: string, cwd: string, spawnedAt: number): void {
    let attempts = 0
    const timer = setInterval(() => {
      attempts++
      const convoId = resolveTranscriptId(this.ccProjectsRoot, cwd, spawnedAt)
      if (convoId) {
        this.emitEvent({ type: "convo", id, ccConversationId: convoId })
        clearInterval(timer)
      } else if (attempts >= 10 || !this.sessions.has(id)) {
        clearInterval(timer)
      }
    }, 1000)
  }

  kill(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.pty.kill()
    this.sessions.delete(id)
    this.outputBuffers.delete(id)
    return true
  }

  /** Append stripped terminal output to a session's bounded scrollback buffer. */
  private captureOutput(id: string, data: string): void {
    const clean = data.replace(ANSI_RE, "")
    if (!clean) return
    const prev = this.outputBuffers.get(id) ?? ""
    let next = prev + clean
    if (next.length > this.maxBufferChars) {
      next = next.slice(next.length - this.maxBufferChars)
    }
    this.outputBuffers.set(id, next)
  }

  /** Return the tail of a session's captured output, or null if unknown. */
  getOutput(id: string, maxChars = 8000): string | null {
    const buf = this.outputBuffers.get(id)
    if (buf == null) return this.sessions.has(id) ? "" : null
    return buf.length > maxChars ? buf.slice(buf.length - maxChars) : buf
  }

  /**
   * Search captured session output for `query` (case-insensitive). Scoped to one
   * session when `sessionId` is given, otherwise across all sessions. Returns the
   * matching lines so a user can review what Claude did while they were away.
   */
  searchOutput(query: string, sessionId?: string, limit = 50): OutputMatch[] {
    const needle = query.toLowerCase()
    const ids = sessionId ? [sessionId] : Array.from(this.outputBuffers.keys())
    const results: OutputMatch[] = []
    for (const id of ids) {
      const buf = this.outputBuffers.get(id)
      if (!buf) continue
      const name = this.sessions.get(id)?.name ?? id
      const lines = buf.split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          results.push({ sessionId: id, name, line: i, text: lines[i].trimEnd() })
          if (results.length >= limit) return results
        }
      }
    }
    return results
  }

  list(): TerminalInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      state: s.state,
    }))
  }

  /**
   * Per-session activity snapshot: which sessions are actively working vs. idle
   * (waiting for input), and how long each has been quiet. Lets a user — or
   * Claude itself — tell at a glance which background session needs attention.
   */
  getActivity(): TerminalActivity[] {
    const now = Date.now()
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      name: s.name,
      state: s.state,
      idleMs: now - s.lastActivity,
    }))
  }

  /**
   * Block until a session has been quiet for `quietMs` (i.e. finished working),
   * or `timeoutMs` elapses. The orchestration primitive: optionally inject
   * `input` first, then wait for the session to settle — so a caller can
   * delegate a task to a session and wait for it to complete instead of polling.
   *
   * Injecting input resets the quiet clock, which sidesteps the startup race
   * where a freshly-prompted session hasn't produced its first output yet.
   *
   * `notBefore`: don't treat the session as idle until it has produced output
   * AT OR AFTER this timestamp. A caller that injected a prompt out-of-band
   * (e.g. a deferred boot-delayed write) passes the prompt's send time so the
   * pre-prompt welcome-screen quiet can't be mistaken for "finished the work".
   */
  waitForIdle(
    id: string,
    opts: { input?: string; submit?: boolean; quietMs?: number; timeoutMs?: number; notBefore?: number } = {},
  ): Promise<{ idle: boolean; timedOut: boolean; reason?: string }> {
    const session = this.sessions.get(id)
    if (!session) return Promise.resolve({ idle: false, timedOut: false, reason: "not found" })
    if (session.state === "dead") {
      return Promise.resolve({ idle: false, timedOut: false, reason: "dead" })
    }

    const quietMs = opts.quietMs ?? this.idleThresholdMs
    const timeoutMs = opts.timeoutMs ?? 120_000
    const notBefore = opts.notBefore ?? 0

    if (opts.input != null) {
      // Start the quiet clock now so we wait for output that follows our input.
      session.lastActivity = Date.now()
      if (session.state === "idle") {
        session.state = "active"
        this.sendToRenderer("session:state", id, "active")
        this.emitEvent({ type: "state", id, state: "active" })
      }
      session.pty.write(opts.submit ? opts.input + "\r" : opts.input)
    }

    const start = Date.now()
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const s = this.sessions.get(id)
        if (!s || s.state === "dead") {
          clearInterval(timer)
          resolve({ idle: false, timedOut: false, reason: "ended" })
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer)
          resolve({ idle: false, timedOut: true })
        } else if (Date.now() - s.lastActivity >= quietMs && s.lastActivity >= notBefore) {
          clearInterval(timer)
          resolve({ idle: true, timedOut: false })
        }
      }, 250)
    })
  }

  rename(id: string, newName: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.name = newName
    this.sendToRenderer("session:renamed", id, newName)
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
    // Switching the visible tab is a renderer concern — tell it to activate this
    // session (so the MCP focus_session tool actually changes the active tab).
    if (!this.sessions.has(id)) return false
    this.sendToRenderer("session:focus", id)
    return true
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
    this.outputBuffers.clear()
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
  }
}
