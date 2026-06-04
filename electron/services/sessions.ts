import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "fs"
import { join } from "path"
import { homedir } from "os"

export interface TerminalRef {
  id: string
  name: string
  cwd: string
  ccConversationId?: string
  lastState: "active" | "idle" | "dead"
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

  private persist(s: WorkSession): void {
    s.updatedAt = this.now()
    mkdirSync(this.dir, { recursive: true })
    const dest = join(this.dir, `${s.id}.json`)
    const tmp = `${dest}.tmp`
    writeFileSync(tmp, JSON.stringify(s, null, 2))
    renameSync(tmp, dest)
  }
}
