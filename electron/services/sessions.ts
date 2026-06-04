import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { parseActivityLine } from "./terminals"

export interface TerminalRef {
  id: string
  name: string
  cwd: string
  ccConversationId?: string
  lastState: "active" | "idle" | "dead"
  /** Rich-presence "what this terminal is doing now" line (Claude self-reports it). */
  activity?: string
  /** Epoch ms when `activity` was last set. */
  activityAt?: number
}

export interface Note {
  id: string
  text: string
  createdAt: number
  source: "self" | "observer"
  status: "active" | "superseded"
  supersededBy?: string
}

export interface WorkSession {
  id: string
  name: string
  status: "active" | "stopped"
  workspaceId?: string
  summary: string
  notes: Note[]
  provisionalFindings: Note[]
  terminals: TerminalRef[]
  createdAt: number
  updatedAt: number
}

export interface SessionServiceOpts {
  dir?: string
  now?: () => number
  idleFlushGraceMs?: number
}

/** The slice of TerminalService the container drives. */
export interface TerminalLike {
  create(name?: string, cwd?: string, sessionId?: string, resumeConvId?: string): { id: string; name: string; cwd: string; state: string }
  kill(id: string): boolean
  write(id: string, data: string): void
  getOutput(id: string, maxChars?: number): string | null
  onEvent(cb: (e: { type: "created" | "state" | "exit" | "convo"; id?: string; state?: "active" | "idle" | "dead"; info?: { id: string }; ccConversationId?: string }) => void): () => void
}

interface MainWinLike {
  webContents: { send: (channel: string, ...args: unknown[]) => void }
  isDestroyed(): boolean
}

export class SessionService {
  private sessions = new Map<string, WorkSession>()
  private dir: string
  private now: () => number

  private terminals?: TerminalLike
  private mainWin: MainWinLike | null = null

  /** Sessions with notes added since their last summary refresh. */
  private summaryDirty = new Set<string>()
  /** Last idle-flush injection time per session (debounce). */
  private lastFlushAt = new Map<string, number>()
  private readonly idleFlushMinIntervalMs = 60_000
  private idleFlushGraceMs: number

  constructor(opts: SessionServiceOpts = {}) {
    this.dir = opts.dir ?? join(homedir(), ".claude-tui", "sessions")
    this.now = opts.now ?? (() => Date.now())
    this.idleFlushGraceMs = opts.idleFlushGraceMs ?? 8000
  }

  attachTerminals(terminals: TerminalLike): void {
    this.terminals = terminals
    terminals.onEvent((e) => {
      if (e.type === "state" && e.id && e.state) this.reconcile(e.id, e.state)
      else if (e.type === "exit" && e.id) this.reconcile(e.id, "dead")
      else if (e.type === "convo" && e.id && e.ccConversationId) {
        this.recordConversationId(e.id, e.ccConversationId)
      }
    })
  }

  setMainWindow(win: MainWinLike): void { this.mainWin = win }

  private emit(channel: string, ...args: unknown[]): void {
    if (this.mainWin && !this.mainWin.isDestroyed()) this.mainWin.webContents.send(channel, ...args)
  }

  /** Find the session owning a live terminal id. */
  private sessionOf(terminalId: string): WorkSession | undefined {
    return [...this.sessions.values()].find((s) => s.terminals.some((t) => t.id === terminalId))
  }

  /** Persist Claude Code's conversation id onto the terminal ref for --resume. */
  private recordConversationId(terminalId: string, ccConversationId: string): void {
    const s = this.sessionOf(terminalId)
    if (!s) return
    const t = s.terminals.find((x) => x.id === terminalId)
    if (!t || t.ccConversationId === ccConversationId) return
    t.ccConversationId = ccConversationId
    this.persist(s)
  }

  /** Fold a live terminal's state into its ref + recompute session status; persist + emit. */
  private reconcile(terminalId: string, state: "active" | "idle" | "dead"): void {
    const s = this.sessionOf(terminalId)
    if (!s) return
    const t = s.terminals.find((x) => x.id === terminalId)
    if (!t) return
    t.lastState = state
    s.status = s.terminals.some((x) => x.lastState === "active" || x.lastState === "idle") ? "active" : "stopped"
    if (state === "idle") this.scheduleIdleFlush(s.id, terminalId)
    this.persist(s)
    this.emit("worksession:updated", this.withEffectiveActivity(s))
  }

  /**
   * After a terminal goes idle, refresh the session summary IF new notes have
   * landed since the last refresh. The terminal that did the work distills it —
   * we inject one prompt asking it to call set_session_summary. Debounced so we
   * never flush more than once per idleFlushMinIntervalMs, and gated on dirty so
   * an idle terminal with nothing new is left alone.
   */
  private scheduleIdleFlush(sessionId: string, terminalId: string): void {
    setTimeout(() => {
      const s = this.sessions.get(sessionId)
      if (!s || !this.terminals) return
      const t = s.terminals.find((x) => x.id === terminalId)
      if (!t || t.lastState !== "idle") return // moved on; don't interrupt
      if (!this.summaryDirty.has(sessionId)) return
      const last = this.lastFlushAt.get(sessionId)
      if (last !== undefined && this.now() - last < this.idleFlushMinIntervalMs) return

      this.summaryDirty.delete(sessionId)
      this.lastFlushAt.set(sessionId, this.now())
      const prompt =
        "Before you go quiet: fold any new findings into the session summary now. " +
        "Call set_session_summary with the updated goal + current-state blurb so a " +
        "fresh terminal inherits it. Keep it concise."
      this.terminals.write(terminalId, `\x1b[200~${prompt}\x1b[201~\r`)
    }, this.idleFlushGraceMs)
  }

  /** Create a session + spawn & register its first terminal. */
  openSession(cwd?: string): { session: WorkSession; terminalId: string } {
    const session = this.create()
    const terminalId = this.spawnInto(session, cwd)
    return { session, terminalId }
  }

  /** Spawn & register an additional terminal in an existing session. */
  addTerminalToSession(sessionId: string, cwd?: string): { terminalId: string } | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    const terminalId = this.spawnInto(s, cwd)
    return { terminalId }
  }

  /** Shared spawn path: create an identity-bound PTY, register a ref, persist + emit. */
  private spawnInto(s: WorkSession, cwd?: string): string {
    if (!this.terminals) throw new Error("terminals not attached")
    // Pass the work-session id so the PTY connects with an identity-bound MCP
    // config — the spawned Claude inherits context via SERVER_INSTRUCTIONS
    // (no visible seed paste) and its work-session tools default to its own ids.
    const info = this.terminals.create(undefined, cwd, s.id)
    s.terminals.push({ id: info.id, name: info.name, cwd: info.cwd, lastState: "active" })
    s.status = "active"
    this.persist(s)
    this.emit("worksession:updated", this.withEffectiveActivity(s))
    return info.id
  }

  /** Close a terminal: kill its PTY, drop the ref, keep the session alive (empty-but-live). */
  closeTerminal(sessionId: string, terminalId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    this.terminals?.kill(terminalId)
    s.terminals = s.terminals.filter((t) => t.id !== terminalId)
    s.status = s.terminals.some((t) => t.lastState === "active" || t.lastState === "idle") ? "active" : "stopped"
    this.persist(s)
    this.emit("worksession:updated", this.withEffectiveActivity(s))
  }

  /** Kill the whole session: every PTY + the on-disk record. */
  killSession(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    for (const t of s.terminals) this.terminals?.kill(t.id)
    this.sessions.delete(sessionId)
    try { unlinkSync(join(this.dir, `${sessionId}.json`)) } catch { /* already gone */ }
    this.emit("worksession:removed", sessionId)
  }

  /** Reopen a dead/stale terminal ref with a fresh primed PTY (3a: fresh, not --resume). */
  reopenTerminal(sessionId: string, terminalId: string): { terminalId: string } | undefined {
    const s = this.sessions.get(sessionId)
    if (!s || !this.terminals) return undefined
    const ref = s.terminals.find((t) => t.id === terminalId)
    if (!ref) return undefined
    const info = this.terminals.create(ref.name, ref.cwd, s.id, ref.ccConversationId)
    ref.id = info.id
    ref.lastState = "active"
    s.status = "active"
    this.persist(s)
    this.emit("worksession:updated", this.withEffectiveActivity(s))
    return { terminalId: info.id }
  }


  create(): WorkSession {
    const t = this.now()
    const s: WorkSession = {
      id: `session-${t}-${Math.random().toString(36).slice(2, 8)}`,
      name: "Untitled session",
      status: "active",
      summary: "",
      notes: [],
      provisionalFindings: [],
      terminals: [],
      createdAt: t,
      updatedAt: t,
    }
    this.sessions.set(s.id, s)
    this.persist(s)
    return s
  }

  get(id: string): WorkSession | undefined { return this.sessions.get(id) }
  list(): WorkSession[] { return [...this.sessions.values()] }

  /** Lookup by id; with no id, the most-recently-updated *active* session (resume entry point). */
  status(id?: string): WorkSession | undefined {
    if (id) return this.sessions.get(id)
    return [...this.sessions.values()]
      .filter((s) => s.status === "active")
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  }

  load(): void {
    let files: string[]
    try { files = readdirSync(this.dir) } catch { return }
    for (const f of files) {
      if (!f.endsWith(".json")) continue
      try {
        const s = JSON.parse(readFileSync(join(this.dir, f), "utf-8")) as WorkSession
        // Lazy spawn: no PTYs are live at boot, so every persisted terminal ref
        // is cold until reopened. Reflect that honestly instead of showing the
        // stale "active"/"idle" state from when the app last closed.
        for (const t of s.terminals) t.lastState = "dead"
        s.status = "stopped"
        this.sessions.set(s.id, s)
      } catch { /* skip malformed */ }
    }
  }

  addTerminal(sessionId: string, ref: TerminalRef): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    if (!s.terminals.some((t) => t.id === ref.id)) s.terminals.push(ref)
    this.persist(s)
  }

  removeTerminal(sessionId: string, terminalId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.terminals = s.terminals.filter((t) => t.id !== terminalId)
    this.persist(s)
  }

  nameTerminal(sessionId: string, terminalId: string, name: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const t = s.terminals.find((x) => x.id === terminalId)
    if (!t) return
    t.name = name
    // Session inherits its name from the FIRST terminal while still a placeholder.
    if (s.name === "Untitled session" && s.terminals[0]?.id === terminalId) s.name = name
    this.persist(s)
  }

  private readonly activityStaleMs = 20_000

  /**
   * The activity line to display for a terminal: the self-reported phrase when
   * it's fresh, otherwise the latest parsed CC tool-call line while the terminal
   * is still active (so a heads-down terminal never looks frozen).
   */
  effectiveActivity(sessionId: string, terminalId: string): string | undefined {
    const s = this.sessions.get(sessionId)
    const t = s?.terminals.find((x) => x.id === terminalId)
    if (!t) return undefined
    const fresh = t.activity && this.now() - (t.activityAt ?? 0) < this.activityStaleMs
    if (fresh) return t.activity
    if (t.lastState === "active" && this.terminals) {
      const parsed = parseActivityLine(this.terminals.getOutput(terminalId, 4000) ?? "")
      if (parsed) return parsed
    }
    return t.activity // last-known (may be stale) if nothing parsed
  }

  /** A copy of the session with each terminal's activity resolved for display. */
  private withEffectiveActivity(s: WorkSession): WorkSession {
    return {
      ...s,
      terminals: s.terminals.map((t) => ({ ...t, activity: this.effectiveActivity(s.id, t.id) })),
    }
  }

  setTerminalActivity(sessionId: string, terminalId: string, activity: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const t = s.terminals.find((x) => x.id === terminalId)
    if (!t) return
    t.activity = activity
    t.activityAt = this.now()
    this.persist(s)
  }

  setTerminalState(sessionId: string, terminalId: string, state: "active" | "idle" | "dead"): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const t = s.terminals.find((x) => x.id === terminalId)
    if (!t) return
    t.lastState = state
    this.persist(s)
  }

  setStatus(sessionId: string, status: "active" | "stopped"): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.status = status
    this.persist(s)
  }

  /** Human-readable session label derived from status + terminal states. */
  deriveStatus(sessionId: string): string {
    const s = this.sessions.get(sessionId)
    if (!s) return "Stopped"
    if (s.terminals.length === 0) return "Empty"
    if (s.status === "stopped") return "Stopped"
    const active = s.terminals.filter((t) => t.lastState === "active").length
    if (active > 0) return `${active} Terminal${active === 1 ? "" : "s"} Working`
    return "Idle"
  }

  addNote(sessionId: string, text: string, opts: { corrects?: string } = {}): Note | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    const note: Note = {
      id: `note-${this.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text,
      createdAt: this.now(),
      source: "self",
      status: "active",
    }
    if (opts.corrects) {
      const target = s.notes.find((n) => n.id === opts.corrects)
      if (target) {
        target.status = "superseded"
        target.supersededBy = note.id
      }
    }
    s.notes.push(note)
    this.summaryDirty.add(sessionId)
    this.persist(s)
    return note
  }

  setSummary(sessionId: string, summary: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.summary = summary
    this.summaryDirty.delete(sessionId)
    this.persist(s)
  }

  /** The primer a terminal pulls: summary, then active notes, then ruled-out (with corrections). */
  getContext(sessionId: string): string | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    const parts: string[] = []
    parts.push(`# Session: ${s.name}`)
    if (s.summary.trim()) parts.push(`## Summary\n${s.summary.trim()}`)

    const active = s.notes.filter((n) => n.status === "active")
    if (active.length) {
      parts.push(`## Findings\n` + active.map((n) => `- ${n.text}`).join("\n"))
    }

    const superseded = s.notes.filter((n) => n.status === "superseded")
    if (superseded.length) {
      const lines = superseded.map((n) => {
        const correction = s.notes.find((c) => c.id === n.supersededBy)
        return correction ? `- ~~${n.text}~~ → ${correction.text}` : `- ~~${n.text}~~`
      })
      parts.push(`## Ruled out / corrected\n` + lines.join("\n"))
    }
    return parts.join("\n\n")
  }

  private persist(s: WorkSession): void {
    s.updatedAt = this.now()
    mkdirSync(this.dir, { recursive: true })
    const dest = join(this.dir, `${s.id}.json`)
    const tmp = `${dest}.tmp`
    writeFileSync(tmp, JSON.stringify(s, null, 2))
    renameSync(tmp, dest)
  }
}
