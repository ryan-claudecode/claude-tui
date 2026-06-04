import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { SessionInfo, SessionActivity } from "./sessions"

/** The slice of SessionService that MissionService drives. A fake is used in tests. */
export interface SessionDriver {
  create(name?: string, cwd?: string): SessionInfo
  write(id: string, data: string): void
  waitForIdle(
    id: string,
    opts: { input?: string; submit?: boolean; quietMs?: number; timeoutMs?: number; notBefore?: number },
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
  /** When the worker's prompt is expected to land (now + boot delay). Used as
   *  the await() idle floor so a booting worker isn't marked done prematurely. */
  dispatchedAt?: number
}
export interface MissionWorker { sessionId: string; role?: string; currentTaskId?: string; startedAt?: number }
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

// Require a phrase that only appears when a limit is actually HIT — not the
// bare words "usage limit", which would false-positive on the Conductor's own
// seed prompt echoing in the terminal (it used to say "if you hit a usage
// limit…", which tripped this and paused the mission instantly).
const USAGE_LIMIT_RE = /limit reached|rate limit exceeded|too many requests/i
export function detectUsageLimit(text: string): { limited: boolean } {
  return { limited: USAGE_LIMIT_RE.test(text) }
}

export interface MissionServiceOpts {
  dir?: string
  now?: () => number
  seedDelayMs?: number
  enterDelayMs?: number
  workerStallMs?: number
  usageBackoffMs?: number
  notify?: (text: string, level?: string) => void
}

export class MissionService {
  private dir: string
  private now: () => number
  private seedDelayMs: number
  private enterDelayMs: number
  private workerStallMs: number
  private usageBackoffMs: number
  private notify?: (text: string, level?: string) => void
  private missions = new Map<string, Mission>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private sessions: SessionDriver, opts: MissionServiceOpts = {}) {
    this.dir = opts.dir ?? join(homedir(), ".claude-tui", "missions")
    this.now = opts.now ?? (() => Date.now())
    this.seedDelayMs = opts.seedDelayMs ?? 4000
    this.enterDelayMs = opts.enterDelayMs ?? 600
    this.workerStallMs = opts.workerStallMs ?? 10 * 60_000
    this.usageBackoffMs = opts.usageBackoffMs ?? 60 * 60_000
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
    // Write-then-rename: a crash mid-write leaves the stale-but-valid file
    // intact rather than a truncated one. The mission JSON is the durable
    // source of truth, so a corrupt write would lose the whole mission.
    const dest = join(this.dir, `${m.id}.json`)
    const tmp = `${dest}.tmp`
    writeFileSync(tmp, JSON.stringify(m, null, 2))
    renameSync(tmp, dest)
  }

  private log(m: Mission, kind: EventKind, text: string): void {
    m.eventLog.push({ time: this.now(), kind, text })
    // Cap the audit trail so a long unattended mission doesn't grow the JSON
    // (rewritten in full every 5s tick) without bound.
    const MAX_EVENTS = 500
    if (m.eventLog.length > MAX_EVENTS) m.eventLog.splice(0, m.eventLog.length - MAX_EVENTS)
  }

  /**
   * Send a prompt to a Claude session and submit it. Claude Code's TUI treats a
   * single "text\r" burst as a bracketed paste and swallows the trailing CR —
   * leaving the prompt typed but unsent. So we write the text, then send Enter
   * as a separate keystroke after a short beat so the TUI registers it.
   */
  private send(id: string, text: string): void {
    this.sessions.write(id, text)
    if (this.enterDelayMs > 0) setTimeout(() => this.sessions.write(id, "\r"), this.enterDelayMs)
    else this.sessions.write(id, "\r")
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
    // Idempotent: re-dispatching an in-progress task (a confused Conductor, or a
    // retry after a timed-out MCP call) must NOT spawn a second worker and
    // orphan the first — hand back the existing assignment instead.
    if (task.status === "in-progress" && task.assignedTo) return { sessionId: task.assignedTo }
    const info = this.sessions.create(`${m.goal.slice(0, 20)} · ${task.title.slice(0, 20)}`, m.cwd)
    // A freshly-spawned worker's Claude Code TUI needs a moment to boot before
    // it can accept input — the same boot delay the Conductor gets. Sending the
    // prompt immediately lands it mid-boot, where the Enter doesn't submit.
    if (this.seedDelayMs > 0) setTimeout(() => this.send(info.id, prompt), this.seedDelayMs)
    else this.send(info.id, prompt)
    task.status = "in-progress"
    task.assignedTo = info.id
    task.attempts += 1
    // The prompt lands ~seedDelayMs from now; await() uses this as the idle floor
    // so the pre-prompt welcome screen can't read as a finished task.
    task.dispatchedAt = this.now() + this.seedDelayMs
    if (!m.workers.some((w) => w.sessionId === info.id)) {
      m.workers.push({ sessionId: info.id, currentTaskId: taskId, startedAt: this.now() })
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
    const r = await this.sessions.waitForIdle(task.assignedTo, { timeoutMs, notBefore: task.dispatchedAt })
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
  stopTimer(): void { if (this.timer) { clearInterval(this.timer); this.timer = null } }

  pause(id: string, resumeAt?: number): Mission | undefined {
    const m = this.missions.get(id)
    if (!m) return undefined
    m.status = "paused"
    m.resumeAt = resumeAt
    this.log(m, "pause", resumeAt ? `Paused until ${new Date(resumeAt).toISOString()}` : "Paused")
    this.persist(m)
    return m
  }

  resume(id: string): Mission | undefined {
    const m = this.missions.get(id)
    if (!m) return undefined
    m.status = "running"
    m.resumeAt = undefined
    this.log(m, "info", "Resumed")
    this.persist(m)
    return m
  }

  private checkUsageLimit(m: Mission): boolean {
    // Scan only the Conductor's output. It's the long-lived brain whose hitting
    // a limit threatens continuity; a worker that hits one just times out its
    // await and gets retried. Scoping here also avoids a re-pause loop: a paused
    // mission keeps its workers (with the limit text still in their buffers), so
    // scanning them would re-trigger on resume — whereas the Conductor is killed
    // and respawned fresh, clearing its buffer.
    if (!m.conductorSessionId) return false
    const out = this.sessions.getOutput(m.conductorSessionId, 2000) ?? ""
    if (detectUsageLimit(out).limited) {
      this.pause(m.id, this.now() + this.usageBackoffMs)
      this.sessions.kill(m.conductorSessionId)
      m.conductorSessionId = undefined
      this.notify?.(`Mission paused (usage limit): ${m.goal}`, "warning")
      return true
    }
    return false
  }

  private conductorSeed(m: Mission): string {
    return `You are the Conductor for ClaudeTUI mission "${m.id}". ` +
      `Call the mission_status MCP tool to load the goal and task list, then drive the mission: ` +
      `if planning, decompose the goal with mission_plan; otherwise pick the next pending task, ` +
      `mission_dispatch it to a worker, mission_await it, review the output, and mission_resolve it. ` +
      `Commit completed work with the git_* tools. Loop until every task is done, then mission_finish. ` +
      `If the model becomes unavailable and you cannot continue, call mission_pause with a resumeAt timestamp. ` +
      `You may stop anytime — a fresh Conductor resumes from mission_status.`
  }

  private liveSessionIds(): Set<string> {
    return new Set(this.sessions.getActivity().filter((a) => a.state !== "dead").map((a) => a.id))
  }

  private ensureConductor(m: Mission, live: Set<string>): void {
    if (m.conductorSessionId && live.has(m.conductorSessionId)) return
    const info = this.sessions.create(`Conductor · ${m.goal.slice(0, 24)}`, m.cwd)
    m.conductorSessionId = info.id
    this.log(m, "info", `Conductor (re)spawned: ${info.id}`)
    const seed = this.conductorSeed(m)
    if (this.seedDelayMs > 0) setTimeout(() => this.send(info.id, seed), this.seedDelayMs)
    else this.send(info.id, seed)
    this.persist(m)
  }

  private reapStalledWorkers(m: Mission, activity: SessionActivity[]): void {
    const byId = new Map(activity.map((a) => [a.id, a]))
    const now = this.now()
    // A worker just spawned this/last tick may not appear in getActivity() yet —
    // without a grace window the "absent => stalled" rule would kill it before
    // it even boots. Protect young workers; real stalls surface after the grace.
    const bootGrace = Math.max(this.seedDelayMs * 2, 15_000)
    for (const w of [...m.workers]) {
      const a = byId.get(w.sessionId)
      const age = now - (w.startedAt ?? 0)
      const stalled = age >= bootGrace && (!a || a.idleMs > this.workerStallMs)
      if (w.currentTaskId && stalled) {
        const task = m.tasks.find((t) => t.id === w.currentTaskId)
        if (task && task.status === "in-progress") {
          task.status = "pending"
          task.assignedTo = undefined
        }
        this.sessions.kill(w.sessionId)
        m.workers = m.workers.filter((x) => x.sessionId !== w.sessionId)
        this.log(m, "error", `Reaped stalled worker ${w.sessionId}; task requeued`)
      }
    }
  }

  tick(): void {
    const now = this.now()
    const activity = this.sessions.getActivity()
    const live = new Set(activity.filter((a) => a.state !== "dead").map((a) => a.id))
    for (const m of this.missions.values()) {
      if (m.status === "paused") {
        if (m.resumeAt != null && now >= m.resumeAt) this.resume(m.id)
        continue
      }
      // "planning" missions need a Conductor too — it's the Conductor that
      // calls mission_plan to decompose the goal and flip status to "running".
      if (m.status !== "running" && m.status !== "planning") continue
      if (this.checkUsageLimit(m)) continue
      this.reapStalledWorkers(m, activity)
      this.ensureConductor(m, live)
      this.persist(m)
    }
  }
}
