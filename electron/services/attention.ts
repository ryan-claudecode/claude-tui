import type { PanelService, PanelEvent } from "./panels"
import type { TerminalService, TerminalEvent } from "./terminals"
import type { NotificationService, NotificationState } from "./notifications"

/**
 * One thing that wants the user's attention. Ordered tier-ascending then
 * `since`-ascending (oldest first within a tier). See attention-queue-design.md.
 */
export interface AttentionEntry {
  /** Stable per (kind, terminalId) — e.g. "blocked:term-3". Anonymous forms key
   *  on their panel id instead, e.g. "blocked:panel-7". */
  id: string
  tier: 1 | 2 | 3
  kind: "blocked" | "asked" | "error" | "finished"
  /** Owning work-session (may be empty for an unattributed form). */
  sessionId: string
  terminalId?: string
  /** Display reason: "form waiting", "asked you", an error excerpt, etc. */
  reason: string
  /** Epoch ms the entry first appeared; wait time derives from this. Preserved
   *  across higher-tier upgrades so the wait clock stays honest. */
  since: number
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
  private deps: AttentionDeps
  private now: () => number

  constructor(
    panels: PanelService,
    terminals: TerminalService,
    notifications: NotificationService,
    deps: AttentionDeps,
    opts: { now?: () => number } = {},
  ) {
    this.deps = deps
    this.now = opts.now ?? (() => Date.now())

    panels.onEvent((e) => this.onPanelEvent(e))
    terminals.onEvent((e) => this.onTerminalEvent(e))
    notifications.onNotification((n) => this.onNotification(n))
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
        // CAPP-107 — a first-class question (ask_user) supplies a quoted reason via the
        // form-pending event; a plain show_form leaves it undefined → the generic default.
        reason: e.reason ?? "Form waiting for you",
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

    // Compare each entry's own `tier` field so ranking is correct.
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
