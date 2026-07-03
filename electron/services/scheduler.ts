import { readdirSync, rmSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { logWarn } from "../log"
import { loadVersioned, saveVersioned, type Migration } from "../persist"
import { computeNextRun, isDue, type Recurrence } from "./scheduleMath"

export type { Recurrence } from "./scheduleMath"

/**
 * SCHED-1 (CAPP-114) — the on-device scheduler. Mirrors the MissionService /
 * Supervisor shape: durable one-file-per-schedule state at
 * `~/.claude-tui/schedules/<id>.json`, a single 30s `setInterval` tick, every
 * mutation routed through `persist()` → one `schedule:updated` event.
 *
 * ALL external effects are behind the injected {@link SchedulerDeps} (terminals,
 * sessions, attention, now()) so the test suite drives it with fakes — no real
 * spawns, no timers left running. `fire()` lazily ensures the schedule's durable
 * work session (one per schedule), spawns a structured terminal into it, delivers
 * the prompt over the stdin sink, and records a {@link RunRecord} when the run ends
 * (a `result` event or the terminal exiting), timing out a hung run after
 * `maxRuntimeMs` by killing ONLY the terminal it spawned.
 */

const SCHEMA_VERSION = 1
const MIGRATIONS: Migration[] = []

/** Newest-first cap on a schedule's run-history ring. */
const RUN_HISTORY_MAX = 50
/** CAPP-115 — char cap on a per-run note (the last assistant line / error excerpt),
 *  so a chatty final message can't bloat the persisted ring or the panel's history. */
const RUN_NOTE_MAX = 200
/** Machine-wide cap on concurrent scheduler-initiated runs (laptop-friendly). */
const MAX_CONCURRENT_SCHEDULED = 2
/** Default per-run runtime ceiling — a hung run is killed after this. */
const DEFAULT_MAX_RUNTIME_MS = 30 * 60_000
/** The single tick cadence. */
const TICK_MS = 30_000

/** Cap a run note at {@link RUN_NOTE_MAX} chars (ellipsis-marked when clipped). */
function truncateNote(note: string): string {
  if (note.length <= RUN_NOTE_MAX) return note
  return `${note.slice(0, RUN_NOTE_MAX - 1).trimEnd()}…`
}

export type RunStatus =
  | "ok"
  | "error"
  | "timeout"
  | "skipped-overlap"
  | "skipped-missed"
  | "killed"

export interface RunRecord {
  /** ISO time the record was written. */
  at: string
  status: RunStatus
  durationMs?: number
  sessionId?: string
  terminalId?: string
  /** Last assistant summary line / error excerpt. */
  note?: string
}

export interface Schedule {
  id: string
  name: string
  /** Seeded into the spawned run terminal. */
  prompt: string
  /** Spawn dir (defaults: workspace folder → home). */
  cwd?: string
  /** Scoping + sidebar filtering (undefined = the untagged "All" bucket). */
  workspaceId?: string
  recurrence: Recurrence
  enabled: boolean
  /** Per-run structured spawn opts (default config defaults). */
  model?: string
  effort?: string
  ultracode?: boolean
  /** Per-run runtime ceiling override (default DEFAULT_MAX_RUNTIME_MS). */
  maxRuntimeMs?: number
  /** Missed-while-closed → run ONCE at launch (default false). */
  catchUp: boolean
  /** false (default) = retire the run terminal when it finishes; keep the session. */
  keepTerminal: boolean
  /** The durable work session this schedule's runs spawn into (one per schedule,
   *  created lazily on the first fire). Reused across restarts. */
  sessionId?: string
  /** Capped ring, newest first (RUN_HISTORY_MAX). */
  runHistory: RunRecord[]
  /** Derived + persisted for display; null = exhausted one-shot. */
  nextRunAt: string | null
  createdAt: string
}

/** The input shape for `create` (id/history/nextRunAt/createdAt are service-owned). */
export interface ScheduleInput {
  name: string
  prompt: string
  recurrence: Recurrence
  cwd?: string
  workspaceId?: string
  enabled?: boolean
  model?: string
  effort?: string
  ultracode?: boolean
  maxRuntimeMs?: number
  catchUp?: boolean
  keepTerminal?: boolean
}

/** The mutable subset `update` accepts (all optional; only present keys apply). */
export type ScheduleUpdate = Partial<ScheduleInput>

export type SchedulerServiceEvent =
  | { type: "updated"; schedule: Schedule }
  | { type: "removed"; id: string }

/** A run terminal signalling it finished — a turn `result` or a process exit. */
export interface RunEnd {
  terminalId: string
  kind: "result" | "exit"
  /** For a `result`: whether the turn ended in error. */
  isError?: boolean
  /** For a `result`: the final assistant text (recorded as the run note). */
  note?: string
}

/**
 * Every external effect the scheduler needs, injected so tests use fakes. The
 * production wiring (ipc.ts) implements these over TerminalService /
 * SessionService / AttentionService.
 */
export interface SchedulerDeps {
  /**
   * Ensure the schedule's durable work session exists and return its id (or
   * undefined on failure). Given the current (persisted) sessionId so it can
   * REUSE an existing session across restarts; when it's missing/gone the impl
   * creates a fresh workspace-scoped, named session. Idempotent per schedule.
   */
  ensureSession(opts: { scheduleId: string; name: string; workspaceId?: string; sessionId?: string }): string | undefined
  /**
   * Spawn a structured (headless) run terminal into the schedule's session with
   * its model/effort/ultracode; return the new terminal id (or undefined on failure).
   * `workspaceId` is the SCHEDULE's workspace (never the active selection) — the
   * wiring resolves the spawn-cwd fallback chain from it: explicit `cwd` → the
   * schedule's workspace folder → the user's home dir (design: "defaults:
   * workspace folder → home").
   */
  spawnRun(opts: {
    scheduleId: string
    sessionId: string
    name: string
    cwd?: string
    workspaceId?: string
    model?: string
    effort?: string
    ultracode?: boolean
  }): string | undefined
  /** Deliver the schedule's prompt to a spawned run terminal (the stdin sink —
   *  NOT a PTY write + delay). */
  sendPrompt(terminalId: string, prompt: string): boolean
  /** Kill ONLY the given run terminal id (the timeout reaper / overlap cleanup). */
  killTerminal(terminalId: string): void
  /** Retire the run terminal after recording (keepTerminal:false); keeps the session. */
  retireTerminal(sessionId: string, terminalId: string): void
  /** Is this terminal still alive (not dead / gone)? Drives the overlap guard. */
  isTerminalAlive(terminalId: string): boolean
  /**
   * Subscribe once to run-terminal END signals (a turn `result` or the terminal
   * exiting); the scheduler routes by terminalId. Returns an unsubscribe fn.
   */
  onRunEnd(cb: (end: RunEnd) => void): () => void
  /** Raise a tier-2 attention entry attributed to the schedule's session (error/timeout). */
  raiseAttention(opts: { sessionId: string; terminalId?: string; reason: string }): void
}

/** An in-flight scheduler-initiated run, keyed by its terminal id. */
interface ActiveRun {
  scheduleId: string
  sessionId: string
  terminalId: string
  startedAt: number
  maxRuntimeMs: number
}

export class SchedulerService {
  private dir: string
  private now: () => number
  private maxConcurrent: number
  private schedules = new Map<string, Schedule>()
  private timer: ReturnType<typeof setInterval> | null = null
  private eventListeners = new Set<(e: SchedulerServiceEvent) => void>()
  /**
   * In-flight runs keyed by terminal id (drives the overlap guard + timeout reaper).
   * DELIBERATELY in-memory only (accepted tradeoff): a run still in flight when the
   * app quits gets NO RunRecord and is invisible to the overlap guard after restart.
   * The tradeoff direction is "never double-fire, may under-record" — app quit kills
   * every terminal (`before-quit` → killAll), so a forgotten run cannot still be
   * alive after a restart; the restarted app simply derives the next fire.
   * Persisting in-flight run state isn't worth the resurrection complexity.
   */
  private activeRuns = new Map<string, ActiveRun>()
  private deps: SchedulerDeps
  private offRunEnd: (() => void) | null = null
  private caughtUp = false

  constructor(deps: SchedulerDeps, opts: { dir?: string; now?: () => number; maxConcurrent?: number } = {}) {
    this.deps = deps
    this.dir = opts.dir ?? join(homedir(), ".claude-tui", "schedules")
    this.now = opts.now ?? (() => Date.now())
    this.maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT_SCHEDULED
    this.loadAll()
    // Subscribe once; the scheduler routes each end signal by terminal id.
    this.offRunEnd = this.deps.onRunEnd((end) => this.onRunEnd(end))
  }

  private loadAll(): void {
    try {
      for (const f of readdirSync(this.dir)) {
        if (!f.endsWith(".json")) continue
        const s = loadVersioned<Schedule>(join(this.dir, f), SCHEMA_VERSION, MIGRATIONS)
        if (s) this.schedules.set(s.id, s)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logWarn("scheduler", `could not read schedules dir: ${err}`)
      }
    }
  }

  /** Subscribe to live schedule mutations. Returns an unsubscribe fn. */
  onEvent(cb: (e: SchedulerServiceEvent) => void): () => void {
    this.eventListeners.add(cb)
    return () => this.eventListeners.delete(cb)
  }

  private emitEvent(e: SchedulerServiceEvent): void {
    for (const cb of this.eventListeners) cb(e)
  }

  /** The choke point every mutation routes through: persist + emit exactly once. */
  private persist(s: Schedule): void {
    // Guard against resurrecting a deleted schedule (a late async op capturing a
    // now-removed `s`). Mirrors MissionService.persist.
    if (!this.schedules.has(s.id)) return
    saveVersioned(join(this.dir, `${s.id}.json`), SCHEMA_VERSION, s)
    this.emitEvent({ type: "updated", schedule: s })
  }

  private deriveNext(s: Schedule, from: Date): string | null {
    const next = computeNextRun(s.recurrence, from)
    return next ? next.toISOString() : null
  }

  // ---- CRUD ---------------------------------------------------------------

  create(input: ScheduleInput): Schedule {
    const nowMs = this.now()
    const s: Schedule = {
      id: `schedule-${nowMs}-${Math.random().toString(36).slice(2, 8)}`,
      name: input.name,
      prompt: input.prompt,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      recurrence: input.recurrence,
      enabled: input.enabled !== false,
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.ultracode ? { ultracode: true } : {}),
      ...(input.maxRuntimeMs ? { maxRuntimeMs: input.maxRuntimeMs } : {}),
      catchUp: input.catchUp === true,
      keepTerminal: input.keepTerminal === true,
      runHistory: [],
      nextRunAt: null,
      createdAt: new Date(nowMs).toISOString(),
    }
    s.nextRunAt = s.enabled ? this.deriveNext(s, new Date(nowMs)) : null
    this.schedules.set(s.id, s)
    this.persist(s)
    return s
  }

  get(id: string): Schedule | undefined {
    return this.schedules.get(id)
  }

  /** All schedules, newest-created first. */
  list(): Schedule[] {
    return [...this.schedules.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
  }

  update(id: string, patch: ScheduleUpdate): Schedule | undefined {
    const s = this.schedules.get(id)
    if (!s) return undefined
    const wasEnabled = s.enabled
    if (patch.name !== undefined) s.name = patch.name
    if (patch.prompt !== undefined) s.prompt = patch.prompt
    if (patch.recurrence !== undefined) s.recurrence = patch.recurrence
    if (patch.cwd !== undefined) s.cwd = patch.cwd || undefined
    if (patch.workspaceId !== undefined) s.workspaceId = patch.workspaceId || undefined
    if (patch.model !== undefined) s.model = patch.model || undefined
    if (patch.effort !== undefined) s.effort = patch.effort || undefined
    if (patch.ultracode !== undefined) s.ultracode = patch.ultracode === true
    if (patch.maxRuntimeMs !== undefined) s.maxRuntimeMs = patch.maxRuntimeMs || undefined
    if (patch.catchUp !== undefined) s.catchUp = patch.catchUp === true
    if (patch.keepTerminal !== undefined) s.keepTerminal = patch.keepTerminal === true
    if (patch.enabled !== undefined) s.enabled = patch.enabled === true
    // Re-derive nextRunAt when the recurrence changed, or when (re)enabling.
    if (patch.recurrence !== undefined || (patch.enabled !== undefined && s.enabled)) {
      s.nextRunAt = s.enabled ? this.deriveNext(s, new Date(this.now())) : s.nextRunAt
    }
    // A freshly re-enabled schedule that had no nextRunAt gets one; a disabled one
    // keeps its last value (describeNext shows "paused" either way).
    if (!wasEnabled && s.enabled && !s.nextRunAt) s.nextRunAt = this.deriveNext(s, new Date(this.now()))
    this.persist(s)
    return s
  }

  delete(id: string): boolean {
    const s = this.schedules.get(id)
    if (!s) return false
    // Kill any in-flight run for this schedule so it can't record after removal.
    // Delete from activeRuns BEFORE killing so the kill's re-entrant `exit` end
    // signal finds no run and no-ops (no stray record for a deleted schedule).
    for (const [tid, run] of [...this.activeRuns]) {
      if (run.scheduleId !== id) continue
      this.activeRuns.delete(tid)
      this.deps.killTerminal(tid)
    }
    this.schedules.delete(id)
    try {
      rmSync(join(this.dir, `${id}.json`), { force: true })
    } catch (err) {
      logWarn("scheduler", `could not delete schedule file ${id}.json: ${err}`)
    }
    this.emitEvent({ type: "removed", id })
    return true
  }

  // ---- Lifecycle ----------------------------------------------------------

  start(): void {
    if (this.timer) return
    // Defensive belt+braces: catchUpOnLaunch is internally per-schedule throw-safe,
    // but start() runs synchronously inside the awaited setupIpc BEFORE the IPC
    // handlers register — a throw escaping here would leave the app with NO IPC
    // handlers. Nothing may abort start().
    try {
      this.catchUpOnLaunch()
    } catch (err) {
      logWarn("scheduler", `launch catch-up failed: ${err}`)
    }
    this.timer = setInterval(() => this.tick(), TICK_MS)
    // Never keep the process alive on the tick alone (parity with idle monitors).
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * CAPP-115 — apply the config `scheduler.maxConcurrent` override to the machine-wide
   * concurrent-run cap. Tolerant (mirrors the models block): a non-positive / non-finite
   * / non-number value is IGNORED so a malformed config can never silently drop the cap
   * to 0 and stall every schedule. Wired in ipc.ts off the resolved config.
   */
  setMaxConcurrent(n: number | undefined): void {
    if (typeof n === "number" && Number.isFinite(n) && n > 0) this.maxConcurrent = Math.floor(n)
  }

  /**
   * Launch catch-up (once): a schedule whose `nextRunAt` passed while the app was
   * closed either records `skipped-missed` (default, nextRunAt re-derived from now)
   * or, when `catchUp`, is LEFT DUE — nextRunAt stays in the past so the normal
   * concurrency-capped tick() drains it: at most `maxConcurrent` catch-up runs in
   * flight, the rest stay due and retry next tick (never a boot thundering-herd
   * while session auto-restore is also spawning). fire() advances nextRunAt from
   * the fire time, so each catchUp schedule still gets EXACTLY ONE catch-up run —
   * never one per missed slot. Nothing spawns synchronously here (a boot-time
   * throw could otherwise abort setupIpc before the IPC handlers register); each
   * schedule is individually throw-safe so one bad file can't starve the rest.
   */
  private catchUpOnLaunch(): void {
    if (this.caughtUp) return
    this.caughtUp = true
    const nowMs = this.now()
    const now = new Date(nowMs)
    for (const s of this.schedules.values()) {
      try {
        if (!s.enabled || !s.nextRunAt) continue
        if (new Date(s.nextRunAt).getTime() > nowMs) continue
        // catchUp:true → leave it due; the capped tick() fires the ONE catch-up run.
        if (s.catchUp) continue
        this.recordRun(s, { status: "skipped-missed", note: "Missed while the app was closed" })
        s.nextRunAt = this.deriveNext(s, now)
        this.persist(s)
      } catch (err) {
        logWarn("scheduler", `catch-up failed for schedule ${s.id}: ${err}`)
      }
    }
  }

  // ---- Tick ---------------------------------------------------------------

  tick(): void {
    const nowMs = this.now()
    // Every per-run / per-schedule body below is individually throw-safe: the
    // production deps sit on fs + spawn paths that CAN throw (ENOSPC/EACCES), and
    // one bad schedule aborting the loop would starve every schedule after it in
    // the Map — forever, since tick() re-runs the same order every 30s.

    // 1. Reap runs past their runtime ceiling — kill ONLY the recorded terminal id.
    for (const [tid, run] of [...this.activeRuns]) {
      try {
        if (nowMs - run.startedAt <= run.maxRuntimeMs) continue
        // Delete BEFORE killing so the kill's re-entrant `exit` end signal no-ops
        // (otherwise a timeout would double-record as timeout AND error).
        this.activeRuns.delete(tid)
        this.deps.killTerminal(tid)
        const s = this.schedules.get(run.scheduleId)
        if (!s) continue
        this.recordRun(s, {
          status: "timeout",
          sessionId: run.sessionId,
          terminalId: tid,
          durationMs: nowMs - run.startedAt,
          note: "Exceeded max runtime",
        })
        this.persist(s)
        this.deps.raiseAttention({
          sessionId: run.sessionId,
          terminalId: tid,
          reason: `Scheduled run "${s.name}" timed out`,
        })
      } catch (err) {
        logWarn("scheduler", `timeout reap failed for run ${tid}: ${err}`)
      }
    }

    // 2. Fire due schedules (overlap-guarded + concurrency-capped).
    const now = new Date(nowMs)
    for (const s of [...this.schedules.values()]) {
      try {
        if (!isDue(s, now)) continue
        if (this.hasLiveRun(s.id)) {
          // Previous run still alive — don't stack; record + advance instead.
          this.recordRun(s, { status: "skipped-overlap" })
          s.nextRunAt = this.deriveNext(s, now)
          this.persist(s)
          continue
        }
        if (this.activeRuns.size >= this.maxConcurrent) continue // over cap → stay due, retry next tick
        this.fire(s)
      } catch (err) {
        logWarn("scheduler", `tick failed for schedule ${s.id}: ${err}`)
      }
    }
  }

  /** Whether this schedule has a still-alive in-flight run (cleans up stale entries). */
  private hasLiveRun(scheduleId: string): boolean {
    for (const [tid, run] of [...this.activeRuns]) {
      if (run.scheduleId !== scheduleId) continue
      if (this.deps.isTerminalAlive(tid)) return true
      // The terminal died without an end signal — drop the stale entry and proceed.
      this.activeRuns.delete(tid)
    }
    return false
  }

  // ---- Fire ---------------------------------------------------------------

  /** Fire a schedule now (ignoring due-ness), still overlap-guarded. */
  runNow(id: string): boolean {
    const s = this.schedules.get(id)
    if (!s) return false
    if (this.hasLiveRun(s.id)) {
      this.recordRun(s, { status: "skipped-overlap" })
      this.persist(s)
      return false
    }
    this.fire(s)
    return true
  }

  private fire(s: Schedule): void {
    const startedAt = this.now()
    const from = new Date(startedAt)
    // Tracked across the try so the catch can attribute + clean up: the production
    // deps THROW (ensureSession/spawnRun sit on saveVersioned→writeFileSync, which
    // throws on ENOSPC/EACCES; createHeadless can throw too) — the graceful
    // `undefined` returns below are the polite half, the catch is the real net.
    let sessionId: string | undefined
    let spawnedTid: string | undefined
    try {
      sessionId = this.deps.ensureSession({
        scheduleId: s.id,
        name: s.name,
        workspaceId: s.workspaceId,
        sessionId: s.sessionId,
      })
      if (!sessionId) {
        this.recordRun(s, { status: "error", note: "Could not create the schedule's work session" })
        s.nextRunAt = this.deriveNext(s, from)
        this.persist(s)
        return
      }
      // Remember the session so a later fire (and a restart) reuses it.
      if (s.sessionId !== sessionId) s.sessionId = sessionId

      const terminalId = this.deps.spawnRun({
        scheduleId: s.id,
        sessionId,
        name: s.name,
        cwd: s.cwd,
        // The SCHEDULE's workspace — the wiring resolves the spawn-cwd chain
        // (explicit cwd → workspace folder → home) from it, never the active selection.
        workspaceId: s.workspaceId,
        model: s.model,
        effort: s.effort,
        ultracode: s.ultracode,
      })
      if (!terminalId) {
        this.recordRun(s, { status: "error", sessionId, note: "Could not spawn the run terminal" })
        s.nextRunAt = this.deriveNext(s, from)
        this.persist(s)
        this.deps.raiseAttention({ sessionId, reason: `Scheduled run "${s.name}" failed to start` })
        return
      }
      spawnedTid = terminalId

      // A failed prompt delivery leaves a terminal that will never do anything —
      // kill it and record the error rather than tracking a 30-minute zombie the
      // timeout reaper would eventually sweep.
      if (!this.deps.sendPrompt(terminalId, s.prompt)) {
        this.deps.killTerminal(terminalId)
        this.recordRun(s, { status: "error", sessionId, terminalId, note: "Could not deliver the prompt" })
        s.nextRunAt = this.deriveNext(s, from)
        this.persist(s)
        this.deps.raiseAttention({ sessionId, terminalId, reason: `Scheduled run "${s.name}" failed to start` })
        return
      }

      this.activeRuns.set(terminalId, {
        scheduleId: s.id,
        sessionId,
        terminalId,
        startedAt,
        maxRuntimeMs: s.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS,
      })
      // Advance nextRunAt anchored to this fire (a `once` recurrence → null = exhausted).
      s.nextRunAt = this.deriveNext(s, from)
      this.persist(s)
    } catch (err) {
      // NEVER let a throw escape fire(): nextRunAt would not advance, so the
      // schedule would re-throw every 30s forever (and, pre-guard, abort the tick
      // loop / setupIpc). Make the designed error path the real one.
      if (spawnedTid) {
        // The throw happened AFTER the spawn (possibly after activeRuns.set, e.g.
        // the final persist): untrack it and best-effort kill our own terminal so
        // no orphaned/ghost run survives outside the guard.
        this.activeRuns.delete(spawnedTid)
        try {
          this.deps.killTerminal(spawnedTid)
        } catch {
          /* best-effort */
        }
      }
      const msg = err instanceof Error ? err.message : String(err)
      this.recordRun(s, { status: "error", sessionId, terminalId: spawnedTid, note: msg })
      s.nextRunAt = this.deriveNext(s, from)
      try {
        this.persist(s)
      } catch (persistErr) {
        // Disk is the likely thrower in the first place — in-memory state is
        // already advanced, so the schedule won't hot-loop; just leave a trace.
        logWarn("scheduler", `persist after failed fire of ${s.id} also failed: ${persistErr}`)
      }
      try {
        this.deps.raiseAttention({
          sessionId: sessionId ?? "",
          terminalId: spawnedTid,
          reason: `Scheduled run "${s.name}" failed: ${msg}`,
        })
      } catch {
        /* best-effort */
      }
      logWarn("scheduler", `fire failed for schedule ${s.id}: ${msg}`)
    }
  }

  /** A tracked run terminal finished (result) or exited — record the outcome. */
  private onRunEnd(end: RunEnd): void {
    const run = this.activeRuns.get(end.terminalId)
    if (!run) return
    // Delete FIRST so the retire→kill→exit re-entrant callback finds no run and no-ops.
    this.activeRuns.delete(end.terminalId)
    const s = this.schedules.get(run.scheduleId)
    if (!s) return
    const durationMs = this.now() - run.startedAt
    // A healthy run ends with a `result` (intercepted first, which removes the
    // active run); reaching here via a bare `exit` means the terminal died BEFORE
    // completing its turn → error.
    const status: RunStatus = end.kind === "exit" ? "error" : end.isError ? "error" : "ok"
    this.recordRun(s, {
      status,
      sessionId: run.sessionId,
      terminalId: end.terminalId,
      durationMs,
      note: end.note ?? (end.kind === "exit" ? "Run terminal exited before completing" : undefined),
    })
    // Retire the run terminal (keepTerminal:false) — only on a `result` (the
    // terminal is still alive); an `exit` already tore it down.
    if (end.kind === "result" && !s.keepTerminal) {
      this.deps.retireTerminal(run.sessionId, end.terminalId)
    }
    this.persist(s)
    if (status === "error") {
      this.deps.raiseAttention({
        sessionId: run.sessionId,
        terminalId: end.terminalId,
        reason: `Scheduled run "${s.name}" ended with an error`,
      })
    }
  }

  /** Prepend a run record (newest first) and cap the ring. Caller persists. */
  private recordRun(
    s: Schedule,
    rec: { status: RunStatus; durationMs?: number; sessionId?: string; terminalId?: string; note?: string },
  ): void {
    const record: RunRecord = {
      at: new Date(this.now()).toISOString(),
      status: rec.status,
      ...(rec.durationMs != null ? { durationMs: rec.durationMs } : {}),
      ...(rec.sessionId ? { sessionId: rec.sessionId } : {}),
      ...(rec.terminalId ? { terminalId: rec.terminalId } : {}),
      ...(rec.note ? { note: truncateNote(rec.note) } : {}),
    }
    s.runHistory.unshift(record)
    if (s.runHistory.length > RUN_HISTORY_MAX) s.runHistory.length = RUN_HISTORY_MAX
  }
}
