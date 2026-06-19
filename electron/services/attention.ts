import type { PanelService, PanelEvent } from "./panels"
import type { TerminalService, TerminalEvent } from "./terminals"
import type { NotificationService, NotificationState } from "./notifications"
import type { MissionService, MissionServiceEvent, MissionStatus, MissionTask } from "./mission"

/**
 * One thing that wants the user's attention. Ordered tier-ascending then
 * `since`-ascending (oldest first within a tier). See attention-queue-design.md.
 */
export interface AttentionEntry {
  /** Stable per (kind, terminalId) — e.g. "blocked:term-3". Anonymous forms key
   *  on their panel id instead, e.g. "blocked:panel-7". */
  id: string
  tier: 1 | 2 | 3
  kind: "blocked" | "asked" | "error" | "finished" | "mission"
  /** Owning work-session (may be empty for an unattributed form). */
  sessionId: string
  terminalId?: string
  /** Set on mission entries (keyed `mission:<id>`, session-less). Lets the
   *  renderer route the jump to the dashboard panel instead of a terminal. */
  missionId?: string
  /** Set on worktree-review entries (keyed `review:<missionId>:<taskId>`). Lets
   *  WW-2b route the jump to the worktree-review panel for that task. */
  taskId?: string
  /** Display reason: "form waiting", "asked you", an error excerpt, etc. */
  reason: string
  /** Epoch ms the entry first appeared; wait time derives from this. Preserved
   *  across higher-tier upgrades so the wait clock stays honest. */
  since: number
}

/**
 * Tier of each kind. For the fixed-tier kinds this is authoritative and each
 * entry's `tier` field mirrors it. `mission` is the exception — a mission entry
 * carries tier 2 (paused/blocked) OR 3 (done) depending on the transition, so
 * the replacement policy compares each entry's own `tier` field (which always
 * equals the value here for fixed-tier kinds) rather than re-deriving from kind.
 * The `2` below is just the floor for a mission entry.
 */
const KIND_TIER: Record<AttentionEntry["kind"], 1 | 2 | 3> = {
  blocked: 1,
  asked: 2,
  error: 2,
  finished: 3,
  mission: 2,
}

/**
 * A terminal must have sustained an active burst of at least this long before an
 * idle transition counts as `finished`. Filters out fresh spawns and one-line
 * blips so the queue isn't noise. (Spec decision 1, tier 3.)
 */
const FINISHED_BURST_GUARDRAIL_MS = 10_000

/** Trim a reason string so a long error message stays a one-liner in the UI. */
function excerpt(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean
}

/** Injected so window-focus and the OS notification are fakeable in tests. */
export interface AttentionDeps {
  /** Push the full snapshot to the main renderer (`attention:updated`). */
  sendToRenderer: (channel: string, ...args: unknown[]) => void
  /** Map a live terminal id to its owning work-session id (SessionService seam). */
  sessionOf: (terminalId: string) => string | undefined
  /** True when the app's main window currently has OS focus. */
  isWindowFocused: () => boolean
  /** Whether `attention.osNotifications` is enabled (config, default true). */
  osNotificationsEnabled: () => boolean
  /** Raise an in-app toast (NotificationService.notify). Tier-1 only. */
  notify: (message: string, level: "info" | "success" | "warning" | "error", title?: string) => void
  /**
   * Show a Windows native notification. Injected (rather than constructing an
   * Electron `Notification` directly) so tests never touch Electron. The click
   * handler focuses the app + jumps to the entry; failures are swallowed by the
   * caller. Returns nothing.
   */
  showOsNotification?: (opts: { title: string; body: string; onClick: () => void }) => void
  /** Log a swallowed OS-notification failure (best-effort). */
  logWarn?: (message: string) => void
}

/**
 * AttentionService — the single source of truth for "who needs me?". Subscribes
 * to PanelService (form pending/resolved → blocked), TerminalService (idle burst
 * + prompt detection → asked/finished), and NotificationService (attributed
 * error/warning → error), applies the tiered one-entry-per-terminal policy, and
 * emits a full `attention:updated` snapshot on every change. Runtime-only state
 * (no persistence — the queue rebuilds from live signals after a restart).
 */
export class AttentionService {
  private entries = new Map<string, AttentionEntry>()
  /** Map an open form's panel id → the blocked entry it created, so a resolve
   *  event clears exactly that entry. */
  private blockedByPanel = new Map<string, string>()
  /** Last status seen per mission. Drives the transition detection: the FIRST
   *  sight of any mission (including every mission loaded at app start) seeds
   *  this SILENTLY — only a later status change enqueues. */
  private missionStatus = new Map<string, MissionStatus>()
  private deps: AttentionDeps
  private now: () => number

  constructor(
    panels: PanelService,
    terminals: TerminalService,
    notifications: NotificationService,
    missions: MissionService,
    deps: AttentionDeps,
    opts: { now?: () => number } = {},
  ) {
    this.deps = deps
    this.now = opts.now ?? (() => Date.now())

    panels.onEvent((e) => this.onPanelEvent(e))
    terminals.onEvent((e) => this.onTerminalEvent(e))
    notifications.onNotification((n) => this.onNotification(n))
    missions.onEvent((e) => this.onMissionEvent(e))
  }

  // ---- Public API ---------------------------------------------------------

  /** Snapshot, ordered tier-ascending then since-ascending (oldest first). */
  list(): AttentionEntry[] {
    return [...this.entries.values()].sort(
      (a, b) => a.tier - b.tier || a.since - b.since,
    )
  }

  /** Manually drop an entry (the hover × in the sidebar). */
  dismiss(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    this.entries.delete(id)
    if (entry.kind === "blocked") this.dropBlockedPanelLink(id)
    this.publish()
    return true
  }

  /**
   * A terminal was focused — clear its tier-2/3 entries (asked/error/finished).
   * Tier-1 (blocked) does NOT clear on focus; it clears only when the form
   * resolves (spec decision 2).
   */
  seen(terminalId: string): void {
    let changed = false
    for (const [id, entry] of this.entries) {
      if (entry.terminalId === terminalId && entry.tier !== 1) {
        this.entries.delete(id)
        changed = true
      }
    }
    if (changed) this.publish()
  }

  /**
   * The mission dashboard was opened for `missionId` — clear its tier-2/3 entry
   * (the mission analogue of `seen`). Mission entries are session-less and keyed
   * `mission:<id>`, so this targets that key directly.
   */
  seenMission(missionId: string): void {
    if (this.entries.delete(`mission:${missionId}`)) this.publish()
  }

  /**
   * Agent-initiated tier-2 entry ("I need you"). Reason is prefixed so the user
   * can tell a self-request from a parsed one. Mirrors the work-session tools'
   * identity defaulting at the call site.
   */
  request(sessionId: string, terminalId: string | undefined, reason: string): AttentionEntry {
    const entry: AttentionEntry = {
      id: `asked:${terminalId ?? sessionId}`,
      tier: 2,
      kind: "asked",
      sessionId,
      terminalId,
      reason: `Agent asked: ${excerpt(reason)}`,
      since: this.now(),
    }
    this.upsert(entry)
    this.publish()
    return entry
  }

  /** Clean up a killed terminal's entries (terminal/session kill). */
  clearTerminal(terminalId: string): void {
    let changed = false
    for (const [id, entry] of this.entries) {
      if (entry.terminalId === terminalId) {
        this.entries.delete(id)
        if (entry.kind === "blocked") this.dropBlockedPanelLink(id)
        changed = true
      }
    }
    if (changed) this.publish()
  }

  /** Clean up every entry owned by a killed work-session. */
  clearSession(sessionId: string): void {
    let changed = false
    for (const [id, entry] of this.entries) {
      if (entry.sessionId === sessionId) {
        this.entries.delete(id)
        if (entry.kind === "blocked") this.dropBlockedPanelLink(id)
        changed = true
      }
    }
    if (changed) this.publish()
  }

  // ---- Event handlers -----------------------------------------------------

  private onPanelEvent(e: PanelEvent): void {
    if (e.type === "form-pending") {
      const terminalId = e.origin.terminalId
      const sessionId = e.origin.sessionId ?? (terminalId ? this.deps.sessionOf(terminalId) : undefined) ?? ""
      // Key blocked entries on the terminal when known (so one terminal shows one
      // blocked entry), else on the panel (anonymous forms get their own entry).
      const id = terminalId ? `blocked:${terminalId}` : `blocked:${e.panelId}`
      const entry: AttentionEntry = {
        id,
        tier: 1,
        kind: "blocked",
        sessionId,
        terminalId,
        reason: "Form waiting for you",
        since: this.now(),
      }
      this.upsert(entry)
      this.blockedByPanel.set(e.panelId, id)
      this.fireTier1(entry)
      this.publish()
    } else if (e.type === "form-resolved") {
      const id = this.blockedByPanel.get(e.panelId)
      if (!id) return
      this.blockedByPanel.delete(e.panelId)
      if (this.entries.delete(id)) this.publish()
    }
  }

  private onTerminalEvent(e: TerminalEvent): void {
    if (e.type === "exit") {
      this.clearTerminal(e.id)
      return
    }
    if (e.type !== "state" || e.state !== "idle") return
    // An active→idle transition: enqueue asked (prompt detected) or finished
    // (sustained burst, no prompt). Fresh spawns/blips (burst < guardrail) and
    // non-prompt short bursts never enqueue.
    const sessionId = this.deps.sessionOf(e.id) ?? ""
    if (e.promptDetected) {
      this.upsert({
        id: `asked:${e.id}`,
        tier: 2,
        kind: "asked",
        sessionId,
        terminalId: e.id,
        reason: "Waiting for your reply",
        since: this.now(),
      })
      this.publish()
    } else if ((e.burstMs ?? 0) >= FINISHED_BURST_GUARDRAIL_MS) {
      this.upsert({
        id: `finished:${e.id}`,
        tier: 3,
        kind: "finished",
        sessionId,
        terminalId: e.id,
        reason: "Finished working",
        since: this.now(),
      })
      this.publish()
    }
  }

  private onNotification(n: NotificationState): void {
    // Only attributed error/warning toasts enqueue; everything else is unchanged.
    if (!n.sessionId) return
    if (n.level !== "error" && n.level !== "warning") return
    this.upsert({
      id: `error:${n.sessionId}`,
      tier: 2,
      kind: "error",
      sessionId: n.sessionId,
      reason: excerpt(n.title ? `${n.title}: ${n.message}` : n.message),
      since: this.now(),
    })
    this.publish()
  }

  /**
   * Mission status changes feed the queue, but only TRANSITIONS observed live —
   * never the state a mission was already in. The first `updated` for any mission
   * (including every mission loaded at app start, whose first event arrives once
   * the supervisor tick persists it, or whose status we record on first sight
   * here) seeds the tracker SILENTLY: no enqueue for state that predates this app
   * session. Stale "finished 3 days ago" noise on every launch would be worse
   * than missing old news (spec — Error handling).
   *
   * Transition matrix (tier-2/3 only — checkpoint forms cover tier-1 already):
   *   → paused  : tier 2  "Mission paused — waiting"
   *   → blocked : tier 2  "Mission blocked — tasks failed"
   *   → done    : tier 3  "Mission finished"
   *   → running : clears any existing entry (a resume).
   * Mission entries are tier-2/3, so they NEVER hit `fireTier1` — no OS
   * notification, per existing policy.
   */
  private onMissionEvent(e: MissionServiceEvent): void {
    if (e.type === "removed") {
      // No delete path exists today (see MissionServiceEvent docs); handle it
      // defensively so a future one clears the entry + tracker cleanly.
      let changed = this.entries.delete(`mission:${e.id}`)
      // Also drop any review entries for that mission's tasks.
      for (const [id, entry] of this.entries) {
        if (entry.kind === "mission" && entry.taskId && entry.missionId === e.id) {
          this.entries.delete(id)
          changed = true
        }
      }
      if (changed) this.publish()
      this.missionStatus.delete(e.id)
      return
    }
    const m = e.mission
    // A status TRANSITION may enqueue/clear a mission-status entry. Separately —
    // and on EVERY mission `updated`, transition or not — reconcile the
    // worktree-review entries against the mission's current awaiting-review tasks.
    // A task can flip to awaiting-review while the mission stays `running`, so the
    // review signal can't ride the status path. Both publish at most once.
    const statusChanged = this.handleMissionStatus(m)
    const reviewChanged = this.reconcileReviewEntries(m)
    if (statusChanged || reviewChanged) this.publish()
  }

  /**
   * Mission-status transition handling. Mutates `this.entries`; returns whether
   * a change was made (the caller publishes once). First sight seeds silently;
   * a no-op persist (same status) does nothing.
   */
  private handleMissionStatus(m: { id: string; status: MissionStatus }): boolean {
    const prev = this.missionStatus.get(m.id)
    this.missionStatus.set(m.id, m.status)
    // First sight: seed silently. No prior status means we can't know whether
    // this is a fresh transition or pre-existing state — assume the latter.
    if (prev === undefined) return false
    // Not a transition (a persist that didn't change status — e.g. a logEvent, a
    // tick re-save, or a task flipping to awaiting-review): nothing to enqueue here.
    if (prev === m.status) return false

    const id = `mission:${m.id}`
    if (m.status === "running") {
      // Resumed — clear any lingering paused/blocked/done entry for this mission.
      return this.entries.delete(id)
    }
    if (m.status === "paused") {
      this.upsert({ id, tier: 2, kind: "mission", sessionId: "", missionId: m.id, reason: "Mission paused — waiting", since: this.now() })
      return true
    } else if (m.status === "blocked") {
      this.upsert({ id, tier: 2, kind: "mission", sessionId: "", missionId: m.id, reason: "Mission blocked — tasks failed", since: this.now() })
      return true
    } else if (m.status === "done") {
      this.upsert({ id, tier: 3, kind: "mission", sessionId: "", missionId: m.id, reason: "Mission finished", since: this.now() })
      return true
    }
    // Other statuses (planning, stopped) carry no entry.
    return false
  }

  /**
   * Reconcile this mission's worktree-review entries against its CURRENT set of
   * awaiting-review tasks — the pure-subscriber review signal (WW-2). For each
   * task in `awaiting-review`, ensure a tier-1 `review:<missionId>:<taskId>`
   * entry exists; for each existing review entry whose task is no longer
   * awaiting-review (approved/rejected/gone), drop it. MissionService never calls
   * AttentionService — this derives everything from the mission snapshot it
   * already publishes. Returns whether anything changed.
   */
  private reconcileReviewEntries(m: { id: string; tasks?: MissionTask[] }): boolean {
    // The mission snapshot always carries its full task list (it serializes to
    // disk). Guard `tasks` defensively for minimal test stubs.
    const tasks = m.tasks ?? []
    const wanted = new Map<string, MissionTask>()
    for (const t of tasks) {
      if (t.status === "awaiting-review") wanted.set(`review:${m.id}:${t.id}`, t)
    }
    let changed = false
    // Drop review entries for this mission whose task is no longer awaiting-review.
    for (const [id, entry] of this.entries) {
      if (entry.kind !== "mission" || !entry.taskId || entry.missionId !== m.id) continue
      if (!wanted.has(id)) {
        this.entries.delete(id)
        changed = true
      }
    }
    // Add a review entry for each awaiting-review task that doesn't have one yet.
    for (const [id, t] of wanted) {
      if (this.entries.has(id)) continue
      this.entries.set(id, {
        id,
        tier: 1,
        kind: "mission",
        sessionId: "",
        missionId: m.id,
        taskId: t.id,
        reason: `Review: ${excerpt(t.title)}`,
        since: this.now(),
      })
      changed = true
    }
    return changed
  }

  // ---- Policy + plumbing --------------------------------------------------

  /**
   * Insert or replace a terminal's entry under the tier policy:
   * - A higher-tier signal REPLACES the existing entry but PRESERVES its `since`
   *   so the wait clock keeps running honestly.
   * - An equal/lower-tier re-trigger only refreshes the `reason` (and keeps the
   *   old, higher tier + original since).
   * Entries for different terminals coexist; this dedup is per entry-owner only
   * when they target the same terminal at a different tier.
   */
  private upsert(next: AttentionEntry): void {
    // Find any existing entry for the same terminal (the "one entry per terminal"
    // rule). Anonymous (no terminalId) entries dedup by exact id only.
    const existing = next.terminalId
      ? [...this.entries.values()].find((x) => x.terminalId === next.terminalId)
      : this.entries.get(next.id)

    if (!existing) {
      this.entries.set(next.id, next)
      return
    }

    // Compare each entry's own `tier` (not KIND_TIER[kind]) so a `mission` entry,
    // whose tier varies with the transition (paused/blocked → 2, done → 3), is
    // ranked correctly. For fixed-tier kinds these are identical by construction.
    const nextTier = next.tier
    const existingTier = existing.tier

    if (nextTier < existingTier) {
      // Higher priority (lower number) — replace, preserving the original since.
      this.entries.delete(existing.id)
      this.entries.set(next.id, { ...next, since: existing.since })
    } else if (nextTier === existingTier && existing.id === next.id) {
      // Same tier + same identity — just refresh the reason, keep since.
      existing.reason = next.reason
    } else if (nextTier === existingTier && existing.id !== next.id) {
      // Same tier, different kind/id for the same terminal (e.g. error replacing
      // asked): replace in place, preserving since, so still one entry per terminal.
      this.entries.delete(existing.id)
      this.entries.set(next.id, { ...next, since: existing.since })
    }
    // Else (next is strictly lower priority): keep the existing higher-tier entry.
  }

  /** Tier-1 side effects: an in-app toast always, an OS notification when the
   *  window is unfocused and config allows it. Failures are swallowed. */
  private fireTier1(entry: AttentionEntry): void {
    this.deps.notify(entry.reason, "warning", "Needs you")
    if (this.deps.isWindowFocused()) return
    if (!this.deps.osNotificationsEnabled()) return
    if (!this.deps.showOsNotification) return
    try {
      this.deps.showOsNotification({
        title: "ClaudeTUI — needs you",
        body: entry.reason,
        onClick: () => this.deps.sendToRenderer("attention:jump", entry.id),
      })
    } catch (err) {
      this.deps.logWarn?.(`attention OS notification failed: ${String(err)}`)
    }
  }

  /** Forget the panel→entry link(s) pointing at a removed blocked entry. */
  private dropBlockedPanelLink(entryId: string): void {
    for (const [panelId, id] of this.blockedByPanel) {
      if (id === entryId) this.blockedByPanel.delete(panelId)
    }
  }

  private publish(): void {
    this.deps.sendToRenderer("attention:updated", this.list())
  }
}
