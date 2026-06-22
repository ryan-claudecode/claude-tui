import { useEffect, useRef, useState } from "react"
import type { TranscriptBlock } from "../lib/agentTranscript"
import { sumCost, formatCost, deriveNow, formatElapsed } from "../lib/agentRail"

interface Props {
  /** Effective open/collapsed (from useAgentRail → effectiveRailOpen). Open = full
   *  300px column; collapsed = the 32px spine. */
  open: boolean
  /** Toggle the rail open/closed (header chevron + the spine click). */
  onToggle: () => void
  /** Whether there is an active terminal at all (drives the NOW rest copy + COST). */
  hasTerminal: boolean
  /** The active terminal is generating a turn or parked on a permission prompt — the
   *  App's `isTerminalBusy(activeTerminalId)`. Drives the NOW pulse + the elapsed timer. */
  busy: boolean
  /** The active terminal's effective activity string (self-reported or the parsed
   *  last tool-call line) — the SAME signal the sidebar dot reads. */
  activity?: string | null
  /** The active terminal's folded transcript blocks, for the session-cumulative COST
   *  sum. Sourced renderer-side from the shared transcript cache (see App.tsx). */
  blocks: readonly TranscriptBlock[]
}

/**
 * Agent Rail (v1, Phase 1) — the persistent, narrow, collapsible RIGHT-edge column
 * for agent-initiated, present-tense state. A pure lens over EXISTING seams (no new
 * backend): NOW mirrors the busy/activity signals the sidebar dot already uses; COST
 * sums the per-turn ResultCost already parsed in agentTranscript.ts. See
 * docs/roadmap/agent-rail-design.md (§3, Phase 1).
 *
 * HARD RULES honored: every control (the collapse chevron, the spine reopen) is
 * ALWAYS visible — no hover-reveal (hover only tints). Warm Sand & Stone tokens only.
 * Purely additive — collapsed, it is a 32px spine and the center transcript reflows.
 *
 * The WORKING (mission lighthouse), KNOWS (context digest), and AWAITING (tier-2/3
 * signals + inline answer) sections are LATER phases — their slots are left as
 * clearly-commented placeholders below so the next phase drops in without re-laying
 * out the column.
 */
export default function AgentRail({
  open,
  onToggle,
  hasTerminal,
  busy,
  activity,
  blocks,
}: Props) {
  const now = deriveNow({ hasTerminal, busy, activity })
  const cost = sumCost(blocks)
  const costLabel = formatCost(cost)

  // Live elapsed clock for the NOW line — runs ONLY while busy. The clock starts at
  // the rising edge of `busy` (the start of the current turn) and ticks once a second.
  const [elapsedMs, setElapsedMs] = useState(0)
  const startRef = useRef<number | null>(null)
  useEffect(() => {
    if (!busy) {
      startRef.current = null
      setElapsedMs(0)
      return
    }
    // Rising edge: anchor the start, paint 0:00 immediately, then tick.
    startRef.current = Date.now()
    setElapsedMs(0)
    const id = setInterval(() => {
      if (startRef.current != null) setElapsedMs(Date.now() - startRef.current)
    }, 1000)
    return () => clearInterval(id)
  }, [busy])

  // COLLAPSED — the 32px spine. Always-visible reopen affordance (the whole spine is
  // the click target + an explicit chevron), a rotated "Agent Rail" label, and a calm
  // tier dot is reserved for a later phase (AWAITING unread). No hover-reveal.
  if (!open) {
    return (
      <div className="agent-rail collapsed" aria-label="Agent Rail (collapsed)">
        <button
          type="button"
          className="agent-rail-spine"
          onClick={onToggle}
          title="Open Agent Rail"
          aria-label="Open Agent Rail"
        >
          <span className="agent-rail-spine-chevron" aria-hidden="true">‹</span>
          <span className="agent-rail-spine-label">AGENT RAIL</span>
        </button>
      </div>
    )
  }

  const empty = now.state === "idle" && costLabel == null

  return (
    <aside className="agent-rail" aria-label="Agent Rail">
      {/* HEADER — label + ALWAYS-VISIBLE collapse chevron. Also a frameless-window
          drag region (the label area); the chevron is no-drag so it stays clickable. */}
      <div className="agent-rail-header">
        <span className="agent-rail-title">Agent Rail</span>
        <button
          type="button"
          className="agent-rail-collapse"
          onClick={onToggle}
          title="Collapse Agent Rail"
          aria-label="Collapse Agent Rail"
        >
          <span aria-hidden="true">›</span>
        </button>
      </div>

      <div className="agent-rail-body">
        {/* NOW — one live line for the active terminal: current action + running
            elapsed while busy, a calm rest state otherwise. */}
        <section className="agent-rail-section agent-rail-now">
          <div className="agent-rail-section-label">NOW</div>
          <div className={`agent-rail-now-line ${now.state}`}>
            <span
              className={`agent-rail-now-dot ${now.pulsing ? "pulsing" : ""}`}
              aria-hidden="true"
            />
            <span className="agent-rail-now-action" title={now.label}>
              {now.label}
            </span>
            {now.state === "busy" && (
              <span className="agent-rail-now-elapsed">{formatElapsed(elapsedMs)}</span>
            )}
          </div>
          {now.state === "busy" && (
            <div className="agent-rail-now-pulsebar" aria-hidden="true">
              <span className="agent-rail-now-pulsebar-fill" />
            </div>
          )}
        </section>

        {/* ── LATER-PHASE SEAMS (docs/roadmap/agent-rail-design.md §3) ──────────────
            Phase 2 — WORKING (mission lighthouse): goal excerpt + progress bar +
              status chip + worker count + "View board →" (window.api.showPanel
              'mission'), sourced from useMissions / mission:updated. Present only
              when a mission is active in the focused session.
            Phase 3 — KNOWS (context digest): findings/ruled-out/provisional count
              chips + 1-line summary + most-recent ruled-out + "Open context →"
              (the SessionOverview panel), from getWorkSessionContext / getOverview.
            Phase 4 — AWAITING (tier-2/3 only): tier-tinted dismissable rows scoped
              to the active terminal (tier-1 filtered out), with an inline mini-
              composer on an `asked` entry wired to sendAgentInput.
            Each slots in HERE, between NOW and COST, without re-laying out the column.
            ─────────────────────────────────────────────────────────────────────── */}

        {/* EMPTY STATE — calm resting copy when NOW is idle and there's no cost yet.
            In our voice, never a spinner; never auto-hides, never auto-expands. */}
        {empty && (
          <div className="agent-rail-empty">
            <div className="agent-rail-empty-title">All quiet</div>
            <div className="agent-rail-empty-hint">
              The agent's live state and spend will appear here.
            </div>
          </div>
        )}
      </div>

      {/* COST — session-cumulative spend for the active terminal, summed renderer-side
          from the per-turn ResultCost. Pinned to the footer; present only when there
          is turn data. Accepted v1 limitation: resets on transcript rehydrate / misses
          scrolled-out turns (design doc Q5) — a glance number, not an audit. */}
      <div className="agent-rail-footer">
        <div className="agent-rail-section-label">COST</div>
        <div className="agent-rail-cost" title="Session-cumulative cost for this terminal">
          {costLabel ?? "—"}
        </div>
      </div>
    </aside>
  )
}
