import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "fs"
import { join } from "path"
import { homedir } from "os"

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
}

export class SessionService {
  private sessions = new Map<string, WorkSession>()
  private dir: string
  private now: () => number

  constructor(opts: SessionServiceOpts = {}) {
    this.dir = opts.dir ?? join(homedir(), ".claude-tui", "sessions")
    this.now = opts.now ?? (() => Date.now())
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
    this.persist(s)
    return note
  }

  setSummary(sessionId: string, summary: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.summary = summary
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
