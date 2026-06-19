import { readdirSync, rmSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { TerminalInfo, TerminalActivity } from "./terminals"
import { WorktreeService, type MergeResult } from "./worktree"
import { logWarn } from "../log"
import { loadVersioned, saveVersioned, type Migration } from "../persist"

/** The slice of TerminalService that MissionService drives. A fake is used in tests. */
export interface SessionDriver {
  create(name?: string, cwd?: string): TerminalInfo
  write(id: string, data: string): void
  waitForIdle(
    id: string,
    opts: { input?: string; submit?: boolean; quietMs?: number; timeoutMs?: number; notBefore?: number },
  ): Promise<{ idle: boolean; timedOut: boolean; reason?: string }>
  getActivity(): TerminalActivity[]
  getOutput(id: string, maxChars?: number): string | null
  kill(id: string): boolean
}

/**
 * The slice of WorktreeService (WW-1) that MissionService drives for isolated
 * workers. Injectable so mission.test.ts uses a FAKE with scripted clean/conflict
 * results — real git stays in worktree.test.ts. Mirrors the WW-1 signatures
 * exactly so the production `new WorktreeService()` satisfies it structurally.
 */
export interface WorktreeLike {
  isGitRepo(cwd: string): boolean
  headSha(cwd: string): string | null
  create(args: { repoCwd: string; branch: string; base: string; path: string }): { path: string; branch: string } | null
  commitAll(worktreePath: string, message: string): { ok: boolean }
  diff(worktreePath: string, base: string): string
  merge(args: { repoCwd: string; branch: string }): MergeResult
  remove(args: { repoCwd: string; path: string; deleteBranch?: string }): { ok: boolean }
  reapOrphans(repoCwd: string, keepBranches: string[]): { removed: string[] }
}

export type Autonomy = "hands-off" | "checkpoints" | "supervised"
export type MissionStatus = "planning" | "running" | "paused" | "blocked" | "done" | "stopped"
export type TaskStatus =
  | "pending"
  | "assigned"
  | "in-progress"
  | "review"
  | "awaiting-review"
  | "merge-conflict"
  | "done"
  | "failed"
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
  /** Isolated-worker (WW-2) fields, set only when the mission has
   *  `isolateWorkers`. The worker runs in this private worktree/branch; on
   *  resolve-done its diff vs `baseRef` is captured for review before merge. */
  worktreePath?: string
  branch?: string
  /** The mission-cwd HEAD SHA at dispatch time — the immutable base the review
   *  diff compares against (not a moving HEAD a sibling merge may advance). */
  baseRef?: string
  /** The captured review diff (worker branch vs baseRef), set on resolve-done. */
  diff?: string
  /** Merge-conflict summary (on `merge-conflict`) or rejection reason (on a
   *  reject back to `pending`) — a short human-readable note for the dashboard. */
  reviewReason?: string
}
export interface MissionWorker { sessionId: string; role?: string; currentTaskId?: string; startedAt?: number }
export interface MissionEvent { time: number; kind: EventKind; text: string }

/**
 * The service-level event seam (distinct from a Mission's own `eventLog`
 * `MissionEvent`s). Callback-set style, like TerminalService/PanelService —
 * subscribers (the renderer push in ipc.ts, AttentionService) react to live
 * mission mutations instead of polling. `updated` fires once per `persist()`
 * with the full Mission snapshot (it already serializes to JSON for disk, so
 * tasks/workers/eventLog ride along — the dashboard panel needs them anyway).
 *
 * `removed` fires when `deleteMission` durably removes a terminal-state mission:
 * its `<id>.json` is unlinked and it's dropped from the in-memory map, so it
 * cannot reappear on reload (nor be resurrected by `tick()`, which only iterates
 * live in-memory missions). The renderer drops the row on this event. `stop` /
 * `finish` still only flip `status` (a terminal-state mission lingers until the
 * user deletes it).
 */
export type MissionServiceEvent =
  | { type: "updated"; mission: Mission }
  | { type: "removed"; id: string }

export interface Mission {
  id: string
  goal: string
  cwd: string
  autonomy: Autonomy
  status: MissionStatus
  /** Opt-in (WW-2): when true, each worker spawns into a private git worktree and
   *  its work is review-gated before merge. Default off — non-isolated missions
   *  are byte-identical to the pre-WW-2 flow. */
  isolateWorkers?: boolean
  /**
   * WS-C — the workspace this mission is scoped to, stamped at mint time from the
   * active workspace (undefined when "All" mode is active). OPTIONAL/additive: old
   * persisted missions predate the field and load with `workspaceId === undefined`
   * (→ the "All" bucket), so no migration / schemaVersion bump is needed.
   */
  workspaceId?: string
  conductorSessionId?: string
  resumeAt?: number
  tasks: MissionTask[]
  workers: MissionWorker[]
  eventLog: MissionEvent[]
  createdAt: number
  updatedAt: number
}

const TERMINAL: MissionStatus[] = ["done", "stopped"]

// The statuses a mission may be DELETED from (the sidebar ✕). Mirrors the
// renderer's `isMissionDismissable` set (missionRow.ts TERMINAL_STATUSES) —
// `blocked` is dismissable/deletable there too, even though it's not in the
// `status()`-fallback TERMINAL set above. A live mission (running/planning/
// paused) is never deletable from a row; stopping it is the separate `stop` path.
const TERMINAL_DELETABLE: MissionStatus[] = ["done", "blocked", "stopped"]

/** Persistence schema version. v1 = today's Mission shape verbatim. */
const SCHEMA_VERSION = 1
const MIGRATIONS: Migration[] = []

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
  /** WW-2 worktree primitives. Default: a real `WorktreeService`. Tests inject a
   *  fake with scripted clean/conflict results — real git stays in worktree.test.ts. */
  worktree?: WorktreeLike
  /**
   * WS-C — active-workspace getter, stamped onto every freshly-minted mission
   * (default = active workspace id, undefined in "All" mode). Injected as a
   * callback (not the WorkspaceService) to keep this service decoupled +
   * testable; `ipc.ts` wires it to `workspaceService.getActiveId()`. Absent →
   * every mission is untagged (the "All" bucket), so existing call sites/tests
   * are unaffected.
   */
  getActiveWorkspaceId?: () => string | null | undefined
}

export class MissionService {
  private dir: string
  private now: () => number
  private seedDelayMs: number
  private enterDelayMs: number
  private workerStallMs: number
  private usageBackoffMs: number
  private notify?: (text: string, level?: string) => void
  private worktree: WorktreeLike
  /** WS-C — active-workspace getter, stamped onto every freshly-minted mission. */
  private getActiveWorkspaceId: () => string | null | undefined
  private missions = new Map<string, Mission>()
  private timer: ReturnType<typeof setInterval> | null = null
  private eventListeners = new Set<(e: MissionServiceEvent) => void>()

  constructor(private sessions: SessionDriver, opts: MissionServiceOpts = {}) {
    this.dir = opts.dir ?? join(homedir(), ".claude-tui", "missions")
    this.now = opts.now ?? (() => Date.now())
    this.seedDelayMs = opts.seedDelayMs ?? 4000
    this.enterDelayMs = opts.enterDelayMs ?? 600
    this.workerStallMs = opts.workerStallMs ?? 10 * 60_000
    this.usageBackoffMs = opts.usageBackoffMs ?? 60 * 60_000
    this.notify = opts.notify
    this.worktree = opts.worktree ?? new WorktreeService()
    this.getActiveWorkspaceId = opts.getActiveWorkspaceId ?? (() => undefined)
    this.loadAll()
    this.reapOrphanWorktrees()
  }

  /**
   * Best-effort reap of orphaned worktrees left by a crashed run, on load. For
   * each isolated mission whose cwd is a git repo, prune managed worktrees whose
   * branch isn't held by a live task. Logged, never throws — a git hiccup here
   * must not block startup. Non-isolated missions (no `isolateWorkers`) are
   * skipped entirely, so this is a true no-op for the byte-identical path.
   */
  private reapOrphanWorktrees(): void {
    for (const m of this.missions.values()) {
      if (!m.isolateWorkers) continue
      try {
        if (!this.worktree.isGitRepo(m.cwd)) continue
        const keep = m.tasks.map((t) => t.branch).filter((b): b is string => !!b)
        const { removed } = this.worktree.reapOrphans(m.cwd, keep)
        if (removed.length) this.log(m, "info", `Reaped ${removed.length} orphan worktree(s) on load`)
      } catch (err) {
        logWarn("missions", `orphan reap failed for ${m.id}: ${err}`)
      }
    }
  }

  private loadAll(): void {
    try {
      for (const f of readdirSync(this.dir)) {
        if (!f.endsWith(".json")) continue
        // loadVersioned read-repairs a legacy (envelope-less) file to v1 and
        // warns (instead of silently swallowing) on corrupt JSON.
        const m = loadVersioned<Mission>(join(this.dir, f), SCHEMA_VERSION, MIGRATIONS)
        if (m) this.missions.set(m.id, m)
      }
    } catch (err) {
      // ENOENT = missions dir not created yet (expected on first run); stay
      // silent. Any other readdir failure is worth surfacing.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logWarn("missions", `could not read missions dir: ${err}`)
      }
    }
  }

  /** Subscribe to live mission mutations. Returns an unsubscribe fn. */
  onEvent(cb: (e: MissionServiceEvent) => void): () => void {
    this.eventListeners.add(cb)
    return () => this.eventListeners.delete(cb)
  }

  private emitEvent(e: MissionServiceEvent): void {
    for (const cb of this.eventListeners) cb(e)
  }

  private persist(m: Mission): void {
    // Chokepoint guard against resurrection: an in-flight async op (e.g. await()'s
    // suspended waitForIdle) can capture a live `m`, then try to persist it AFTER
    // deleteMission() dropped it from the map + unlinked its file. Re-writing the
    // JSON here would resurrect the mission on the next boot (loadAll seed) and
    // re-surface the deleted row live via the `updated` event. If the mission is no
    // longer tracked, never re-write and never re-emit. (create() adds to
    // this.missions BEFORE its first persist(), so this can't break creation.)
    if (!this.missions.has(m.id)) return
    m.updatedAt = this.now()
    // Write-then-rename (in saveVersioned): a crash mid-write leaves the
    // stale-but-valid file intact rather than a truncated one. The mission JSON
    // is the durable source of truth, so a corrupt write would lose the mission.
    saveVersioned(join(this.dir, `${m.id}.json`), SCHEMA_VERSION, m)
    // The choke point every mutation routes through — emit exactly one
    // `updated` per persist so subscribers see one event per mutation.
    this.emitEvent({ type: "updated", mission: m })
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

  create(goal: string, cwd: string, autonomy: Autonomy = "hands-off", isolateWorkers = false): Mission {
    // Isolation requires git — refuse loudly rather than silently downgrade, so
    // the Conductor/user knows isolation isn't actually in effect (Decision 6 /
    // Error handling).
    if (isolateWorkers && !this.worktree.isGitRepo(cwd)) {
      throw new Error(`Cannot isolate workers: ${cwd} is not a git repository (worktree isolation requires git).`)
    }
    const t = this.now()
    // WS-C — stamp the active workspace at mint time (default = active workspace
    // id). When no workspace is active ("All" mode), leave `workspaceId` UNSET via
    // the conditional spread (undefined → the "All" bucket) so the persisted JSON
    // is additive/byte-identical to the pre-WS-C shape for untagged missions.
    const activeWorkspaceId = this.getActiveWorkspaceId() ?? undefined
    const m: Mission = {
      id: `mission-${t}-${Math.random().toString(36).slice(2, 8)}`,
      goal, cwd, autonomy,
      status: "planning",
      ...(isolateWorkers ? { isolateWorkers: true } : {}),
      ...(activeWorkspaceId ? { workspaceId: activeWorkspaceId } : {}),
      tasks: [], workers: [], eventLog: [],
      createdAt: t, updatedAt: t,
    }
    this.log(m, "info", `Mission created: ${goal}${isolateWorkers ? " (isolated workers)" : ""}`)
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

  plan(
    id: string,
    tasks: Array<{ title: string; detail?: string }>,
    isolateWorkers?: boolean,
  ): Mission | undefined {
    const m = this.missions.get(id)
    if (!m) return undefined
    // Allow enabling isolation at plan time too (the Conductor may decide to
    // isolate after decomposing). Refuse on a non-git cwd, same as create.
    if (isolateWorkers !== undefined) {
      if (isolateWorkers && !this.worktree.isGitRepo(m.cwd)) {
        throw new Error(`Cannot isolate workers: ${m.cwd} is not a git repository (worktree isolation requires git).`)
      }
      m.isolateWorkers = isolateWorkers || undefined
    }
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

  /** A short, branch-safe slug of an id's trailing token (e.g. the random suffix). */
  private shortId(id: string): string {
    const tail = id.split("-").pop() ?? id
    return tail.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "x"
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
    // Isolated dispatch: carve a private git worktree for this task and spawn the
    // worker INTO it (instead of the shared mission cwd), so parallel workers
    // can't collide on the same tree. On a git failure, leave the task pending and
    // spawn nothing — the supervisor will retry on a later tick.
    let workerCwd = m.cwd
    if (m.isolateWorkers) {
      const baseRef = this.worktree.headSha(m.cwd) ?? "HEAD"
      const branch = `claudetui/mission/${this.shortId(m.id)}/${this.shortId(task.id)}`
      const wtPath = join(m.cwd, ".claude-tui", "worktrees", m.id, task.id)
      const created = this.worktree.create({ repoCwd: m.cwd, branch, base: "HEAD", path: wtPath })
      if (!created) {
        this.log(m, "error", `Worktree creation failed for "${task.title}"; task left pending`)
        this.persist(m)
        return undefined
      }
      task.worktreePath = created.path
      task.branch = created.branch
      task.baseRef = baseRef
      workerCwd = created.path
    }
    const info = this.sessions.create(`${m.goal.slice(0, 20)} · ${task.title.slice(0, 20)}`, workerCwd)
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

    // Isolated + "done": DON'T finish. Commit the worker's private tree, capture
    // its diff for review, and park the task at `awaiting-review` — nothing lands
    // unseen. The attention review entry is raised purely via the persist() event
    // seam (AttentionService is a pure subscriber); we never call it here.
    if (status === "done" && task.worktreePath) {
      this.worktree.commitAll(task.worktreePath, `wip: ${task.title}`)
      const baseRef = task.baseRef ?? "HEAD"
      task.diff = this.worktree.diff(task.worktreePath, baseRef)
      task.status = "awaiting-review"
      task.result = result
      const w = m.workers.find((x) => x.currentTaskId === taskId)
      if (w) w.currentTaskId = undefined
      this.log(m, "review", `Task "${task.title}" → awaiting-review (captured diff)`)
      // No completion recompute: an awaiting-review task is NOT done yet.
      this.persist(m)
      return m
    }

    // Isolated + "failed": discard the private worktree+branch before recording
    // the failure, so a rejected/failed task leaves no orphaned tree behind.
    if (status === "failed" && task.worktreePath) {
      this.worktree.remove({ repoCwd: m.cwd, path: task.worktreePath, deleteBranch: task.branch })
      task.worktreePath = undefined
      task.branch = undefined
      task.diff = undefined
      task.baseRef = undefined
    }

    task.status = status
    task.result = result
    const worker = m.workers.find((w) => w.currentTaskId === taskId)
    if (worker) worker.currentTaskId = undefined
    this.log(m, "review", `Task "${task.title}" → ${status}${result ? `: ${result}` : ""}`)
    this.recomputeCompletion(m)
    this.persist(m)
    return m
  }

  /**
   * Shared mission-completion tail, called from `resolve` (non-isolated/failed
   * paths) and `approveTask` (the isolated done path). All tasks done → mission
   * `done`; every task done-or-failed (with at least one failure) → `blocked`.
   * A task in any other state (pending/in-progress/awaiting-review/merge-conflict)
   * keeps the mission `running`. Mutates `m` in place — the caller persists.
   */
  private recomputeCompletion(m: Mission): void {
    if (m.tasks.length > 0 && m.tasks.every((t) => t.status === "done")) {
      m.status = "done"
      this.log(m, "info", "All tasks done — mission complete")
    } else if (m.tasks.length > 0 && m.tasks.every((t) => t.status === "done" || t.status === "failed")) {
      m.status = "blocked"
      this.log(m, "error", "Remaining tasks failed — mission blocked")
      this.notify?.(`Mission blocked: ${m.goal}`, "warning")
    }
  }

  /**
   * Approve an awaiting-review task: merge its branch into the mission cwd's
   * working branch. Clean → remove the worktree (keep nothing), mark `done`, and
   * recompute mission completion. Conflict → mark `merge-conflict`, KEEP the
   * worktree+branch for manual handling (NEVER auto-resolve), record the conflict
   * summary, notify, and persist. Returns the mission, or undefined if the task
   * isn't awaiting review.
   */
  approveTask(missionId: string, taskId: string): Mission | undefined {
    const m = this.missions.get(missionId)
    const task = m?.tasks.find((t) => t.id === taskId)
    if (!m || !task) return undefined
    if (task.status !== "awaiting-review" || !task.branch) return undefined
    const res = this.worktree.merge({ repoCwd: m.cwd, branch: task.branch })
    if (res.ok) {
      if (task.worktreePath) {
        this.worktree.remove({ repoCwd: m.cwd, path: task.worktreePath, deleteBranch: task.branch })
      }
      task.status = "done"
      task.worktreePath = undefined
      task.branch = undefined
      task.diff = undefined
      task.baseRef = undefined
      task.reviewReason = undefined
      this.log(m, "commit", `Approved & merged "${task.title}"`)
      this.recomputeCompletion(m)
      this.persist(m)
      return m
    }
    // Conflict: surfaced, never auto-resolved. Keep the worktree+branch so the
    // user/Conductor can resolve it by hand.
    task.status = "merge-conflict"
    task.reviewReason = res.conflict
    this.log(m, "error", `Merge conflict on "${task.title}" — branch preserved for manual handling`)
    this.notify?.(`Merge conflict: ${task.title} (${m.goal})`, "warning")
    this.persist(m)
    return m
  }

  /**
   * Reject an awaiting-review (or merge-conflict) task: discard its private
   * worktree+branch and set it back to `pending` (re-dispatchable). The rejection
   * reason is recorded in the event log + `task.reviewReason`. Nothing merges.
   */
  rejectTask(missionId: string, taskId: string, reason?: string): Mission | undefined {
    const m = this.missions.get(missionId)
    const task = m?.tasks.find((t) => t.id === taskId)
    if (!m || !task) return undefined
    if (task.status !== "awaiting-review" && task.status !== "merge-conflict") return undefined
    if (task.worktreePath) {
      this.worktree.remove({ repoCwd: m.cwd, path: task.worktreePath, deleteBranch: task.branch })
    }
    task.worktreePath = undefined
    task.branch = undefined
    task.diff = undefined
    task.baseRef = undefined
    task.status = "pending"
    task.assignedTo = undefined
    task.reviewReason = reason
    this.log(m, "review", `Rejected "${task.title}" — back to pending${reason ? `: ${reason}` : ""}`)
    this.persist(m)
    return m
  }

  /** List every awaiting-review task across all missions (the review queue). */
  reviewQueue(): Array<{ missionId: string; taskId: string; title: string; diff: string; reviewReason?: string }> {
    const out: Array<{ missionId: string; taskId: string; title: string; diff: string; reviewReason?: string }> = []
    for (const m of this.missions.values()) {
      for (const t of m.tasks) {
        if (t.status === "awaiting-review") {
          out.push({ missionId: m.id, taskId: t.id, title: t.title, diff: t.diff ?? "", reviewReason: t.reviewReason })
        }
      }
    }
    return out
  }

  logEvent(missionId: string, kind: EventKind, text: string): Mission | undefined {
    const m = this.missions.get(missionId)
    if (!m) return undefined
    this.log(m, kind, text)
    this.persist(m)
    return m
  }

  /**
   * Remove ALL of a mission's worktrees+branches (every task carrying a
   * worktreePath). Called on stop/finish so a terminated mission leaves no
   * orphaned trees. Best-effort and wrapped — a git failure can't block the
   * stop/finish. Clears the task's worktree fields so the persisted state is
   * clean. No-op for non-isolated missions (no task has a worktreePath).
   */
  private cleanupAllWorktrees(m: Mission): void {
    for (const t of m.tasks) {
      if (!t.worktreePath) continue
      try {
        this.worktree.remove({ repoCwd: m.cwd, path: t.worktreePath, deleteBranch: t.branch })
      } catch (err) {
        logWarn("missions", `worktree cleanup failed for ${m.id}/${t.id}: ${err}`)
      }
      t.worktreePath = undefined
      t.branch = undefined
      t.diff = undefined
      t.baseRef = undefined
    }
  }

  stop(missionId: string): Mission | undefined {
    const m = this.missions.get(missionId)
    if (!m) return undefined
    for (const w of m.workers) this.sessions.kill(w.sessionId)
    if (m.conductorSessionId) this.sessions.kill(m.conductorSessionId)
    this.cleanupAllWorktrees(m)
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
    this.cleanupAllWorktrees(m)
    m.status = "done"
    this.log(m, "info", "Mission finished")
    this.persist(m)
    return m
  }

  /**
   * Durably delete a mission: unlink its `<id>.json` and drop it from the
   * in-memory map, then emit a `removed` event so the renderer drops the row and
   * the dashboard panel STOPS REFRESHING. (It does NOT auto-close: the companion
   * dashboard panel keeps showing its last snapshot until the user closes its tab
   * — auto-close is intentionally out of scope here.) This is what the sidebar ✕
   * now does instead of the old renderer-only dismissed-ids Set — after deletion
   * `list()` / `loadAll()` no longer return it, so it CANNOT reappear on relaunch,
   * and the Supervisor `tick()` (which iterates this map) can't resurrect it.
   *
   * Gated to TERMINAL-state missions (done/blocked/stopped): a running/planning/
   * paused mission is never deletable from a row (matches the renderer gating;
   * stopping it is the separate `stop` path). Returns true iff a mission was
   * removed.
   *
   * Teardown order, mirroring `stop()`: a `done`/`blocked` mission was reached via
   * `finish()`/`recomputeCompletion()`, which do NOT kill processes, so its
   * Conductor + workers may still be LIVE PTYs. Kill them first — otherwise
   * dropping the record orphans those `claude.exe` processes (unreachable by
   * `stop()`/`tick()` once the row is gone). `sessions.kill` is a safe no-op on an
   * already-dead/unknown id (returns false), so this never double-kills the
   * already-cleared sessions of a `stopped` mission. Then best-effort worktree
   * cleanup so an isolated mission leaves no orphan trees (a no-op for
   * non-isolated missions).
   */
  deleteMission(id: string): boolean {
    const m = this.missions.get(id)
    if (!m) return false
    if (!TERMINAL_DELETABLE.includes(m.status)) return false
    // Tear down any still-live PTYs (no-op for an already-stopped mission).
    for (const w of m.workers) this.sessions.kill(w.sessionId)
    if (m.conductorSessionId) this.sessions.kill(m.conductorSessionId)
    // Best-effort: any per-task failure is logged inside cleanupAllWorktrees, so a
    // (best-effort) orphaned worktree leaves a trace. DEFERRED FOLLOW-UP: a
    // boot-time orphan-worktree prune-sweep (reapOrphans over the repo, keeping
    // live missions' branches) would reclaim trees stranded by a failed cleanup.
    this.cleanupAllWorktrees(m)
    this.missions.delete(id)
    // Remove the durable file so a fresh service load (boot seed) can't re-add it.
    // force:true → no throw if it's already gone (e.g. a manual delete).
    try {
      rmSync(join(this.dir, `${id}.json`), { force: true })
    } catch (err) {
      logWarn("missions", `could not delete mission file ${id}.json: ${err}`)
    }
    this.emitEvent({ type: "removed", id })
    return true
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
    const reviewGate = m.isolateWorkers
      ? `This mission has ISOLATED WORKERS: each worker runs in its own git worktree, and a resolved-done task enters review instead of finishing — call mission_review_queue to see pending diffs, then mission_approve_task (merge clean / surface conflict) or mission_reject_task (discard, back to pending). Tasks only count done once approved. `
      : ""
    return `You are the Conductor for ClaudeTUI mission "${m.id}". ` +
      `Call the mission_status MCP tool to load the goal and task list, then drive the mission: ` +
      `if planning, decompose the goal with mission_plan; otherwise pick the next pending task, ` +
      `mission_dispatch it to a worker, mission_await it, review the output, and mission_resolve it. ` +
      reviewGate +
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

  private reapStalledWorkers(m: Mission, activity: TerminalActivity[]): void {
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
