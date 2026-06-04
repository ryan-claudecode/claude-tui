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

  plan(id: string, tasks: Array<{ title: string; detail?: string }>): Mission | undefined {
    const m = this.missions.get(id)
    if (!m) return undefined
    m.tasks = tasks.map((t, i) => ({
      id: `t${i + 1}-${Math.random().toString(36).slice(2, 6)}`,
      title: t.title,
      detail: t.detail,
      status: "pending" as TaskStatus,
      attempts: 0,
    }))
    if (m.status === "planning") m.status = "running"
    this.log(m, "task", `Planned ${tasks.length} task(s)`)
    this.persist(m)
    return m
  }

  /** Spawn (or reuse) a worker for a task, inject its prompt, mark in-progress. */
  dispatch(missionId: string, taskId: string, prompt: string): { sessionId: string } | undefined {
    const m = this.missions.get(missionId)
    const task = m?.tasks.find((t) => t.id === taskId)
    if (!m || !task) return undefined
    const info = this.sessions.create(`${m.goal.slice(0, 20)} · ${task.title.slice(0, 20)}`, m.cwd)
    this.sessions.write(info.id, `${prompt}\r`)
    task.status = "in-progress"
    task.assignedTo = info.id
    task.attempts += 1
    if (!m.workers.some((w) => w.sessionId === info.id)) {
      m.workers.push({ sessionId: info.id, currentTaskId: taskId })
    }
    this.log(m, "worker", `Dispatched "${task.title}" to ${info.id}`)
    this.persist(m)
    return { sessionId: info.id }
  }

  /** Block until the task's worker goes idle; return its recent output. */
  async await(
    missionId: string,
    taskId: string,
    timeoutMs?: number,
  ): Promise<{ idle: boolean; timedOut: boolean; output: string } | undefined> {
    const m = this.missions.get(missionId)
    const task = m?.tasks.find((t) => t.id === taskId)
    if (!m || !task || !task.assignedTo) return undefined
    const r = await this.sessions.waitForIdle(task.assignedTo, { timeoutMs })
    const output = this.sessions.getOutput(task.assignedTo, 8000) ?? ""
    if (r.idle) {
      task.status = "review"
      this.persist(m)
    }
    return { idle: r.idle, timedOut: r.timedOut, output }
  }

  resolve(missionId: string, taskId: string, status: "done" | "failed", result?: string): Mission | undefined {
    const m = this.missions.get(missionId)
    const task = m?.tasks.find((t) => t.id === taskId)
    if (!m || !task) return undefined
    task.status = status
    task.result = result
    const worker = m.workers.find((w) => w.currentTaskId === taskId)
    if (worker) worker.currentTaskId = undefined
    this.log(m, "review", `Task "${task.title}" → ${status}${result ? `: ${result}` : ""}`)
    if (m.tasks.length > 0 && m.tasks.every((t) => t.status === "done")) {
      m.status = "done"
      this.log(m, "info", "All tasks done — mission complete")
    } else if (m.tasks.every((t) => t.status === "done" || t.status === "failed")) {
      m.status = "blocked"
      this.log(m, "error", "Remaining tasks failed — mission blocked")
      this.notify?.(`Mission blocked: ${m.goal}`, "warning")
    }
    this.persist(m)
    return m
  }

  logEvent(missionId: string, kind: EventKind, text: string): Mission | undefined {
    const m = this.missions.get(missionId)
    if (!m) return undefined
    this.log(m, kind, text)
    this.persist(m)
    return m
  }

  stop(missionId: string): Mission | undefined {
    const m = this.missions.get(missionId)
    if (!m) return undefined
    for (const w of m.workers) this.sessions.kill(w.sessionId)
    if (m.conductorSessionId) this.sessions.kill(m.conductorSessionId)
    m.workers = []
    m.conductorSessionId = undefined
    m.status = "stopped"
    this.log(m, "info", "Mission stopped by user")
    this.persist(m)
    return m
  }

  finish(id: string): Mission | undefined {
    const m = this.missions.get(id)
    if (!m) return undefined
    m.status = "done"
    this.log(m, "info", "Mission finished")
    this.persist(m)
    return m
  }

  start(): void { if (!this.timer) this.timer = setInterval(() => this.tick(), 5000) }
  pause(id: string, resumeAt?: number): Mission | undefined { return undefined }
  resume(id: string): Mission | undefined { return undefined }
  tick(): void {}
  stopTimer(): void { if (this.timer) { clearInterval(this.timer); this.timer = null } }
}
