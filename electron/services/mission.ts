import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { SessionInfo, SessionActivity } from "./sessions"

/** The slice of SessionService that MissionService drives. A fake is used in tests. */
export interface SessionDriver {
  create(name?: string, cwd?: string): SessionInfo
  write(id: string, data: string): void
  waitForIdle(
    id: string,
    opts: { input?: string; submit?: boolean; quietMs?: number; timeoutMs?: number },
  ): Promise<{ idle: boolean; timedOut: boolean; reason?: string }>
  getActivity(): SessionActivity[]
  getOutput(id: string, maxChars?: number): string | null
  kill(id: string): boolean
}

export type Autonomy = "hands-off" | "checkpoints" | "supervised"
export type MissionStatus = "planning" | "running" | "paused" | "blocked" | "done" | "stopped"
export type TaskStatus = "pending" | "assigned" | "in-progress" | "review" | "done" | "failed"
export type EventKind = "info" | "task" | "worker" | "review" | "commit" | "pause" | "error"

export interface MissionTask {
  id: string
  title: string
  detail?: string
  status: TaskStatus
  assignedTo?: string
  result?: string
  attempts: number
}
export interface MissionWorker { sessionId: string; role?: string; currentTaskId?: string }
export interface MissionEvent { time: number; kind: EventKind; text: string }

export interface Mission {
  id: string
  goal: string
  cwd: string
  autonomy: Autonomy
  status: MissionStatus
  conductorSessionId?: string
  resumeAt?: number
  tasks: MissionTask[]
  workers: MissionWorker[]
  eventLog: MissionEvent[]
  createdAt: number
  updatedAt: number
}

const TERMINAL: MissionStatus[] = ["done", "stopped"]

export interface MissionServiceOpts {
  dir?: string
  now?: () => number
  seedDelayMs?: number
  notify?: (text: string, level?: string) => void
}

export class MissionService {
  private dir: string
  private now: () => number
  private seedDelayMs: number
  private notify?: (text: string, level?: string) => void
  private missions = new Map<string, Mission>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private sessions: SessionDriver, opts: MissionServiceOpts = {}) {
    this.dir = opts.dir ?? join(homedir(), ".claude-tui", "missions")
    this.now = opts.now ?? (() => Date.now())
    this.seedDelayMs = opts.seedDelayMs ?? 4000
    this.notify = opts.notify
    this.loadAll()
  }

  private loadAll(): void {
    try {
      for (const f of readdirSync(this.dir)) {
        if (!f.endsWith(".json")) continue
        try {
          const m = JSON.parse(readFileSync(join(this.dir, f), "utf-8")) as Mission
          this.missions.set(m.id, m)
        } catch { /* skip corrupt file */ }
      }
    } catch { /* dir absent yet */ }
  }

  private persist(m: Mission): void {
    m.updatedAt = this.now()
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(join(this.dir, `${m.id}.json`), JSON.stringify(m, null, 2))
  }

  private log(m: Mission, kind: EventKind, text: string): void {
    m.eventLog.push({ time: this.now(), kind, text })
  }

  create(goal: string, cwd: string, autonomy: Autonomy = "hands-off"): Mission {
    const t = this.now()
    const m: Mission = {
      id: `mission-${t}-${Math.random().toString(36).slice(2, 8)}`,
      goal, cwd, autonomy,
      status: "planning",
      tasks: [], workers: [], eventLog: [],
      createdAt: t, updatedAt: t,
    }
    this.log(m, "info", `Mission created: ${goal}`)
    this.missions.set(m.id, m)
    this.persist(m)
    return m
  }

  get(id: string): Mission | undefined { return this.missions.get(id) }

  list(): Mission[] {
    return Array.from(this.missions.values()).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** With no id: the most-recently-updated non-terminal mission. */
  status(id?: string): Mission | undefined {
    if (id) return this.missions.get(id)
    return this.list().find((m) => !TERMINAL.includes(m.status))
  }

  finish(id: string): Mission | undefined {
    const m = this.missions.get(id)
    if (!m) return undefined
    m.status = "done"
    this.log(m, "info", "Mission finished")
    this.persist(m)
    return m
  }
}
