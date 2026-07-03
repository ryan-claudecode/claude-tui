import { useEffect, useRef, useState } from "react"
import type { TranscriptBlock } from "../lib/agentTranscript"
import {
  sumCost,
  formatCost,
  deriveNow,
  formatElapsed,
  type RailKnows,
  type RuledOutLine,
} from "../lib/agentRail"
import { resolveClick, type ActionButtonView } from "../lib/actionButtonRow"

interface Props {
  /** Effective open/collapsed (from useAgentRail → effectiveRailOpen). Open = full
   *  300px column; collapsed = the 32px spine. */
  open: boolean
  /** Toggle the rail open/closed (header chevron + the spine click). */
  onToggle: () => void
  /** Whether there is an active terminal at all (drives the NOW rest copy + COST). */
  hasTerminal: boolean
  /** The ACTIVE terminal's id — used to re-anchor the elapsed clock on a terminal
   *  switch, so switching between two concurrently-busy terminals doesn't show one
   *  terminal's accumulated elapsed under another. */
  terminalId?: string | null
  /** The active terminal is generating a turn or parked on a permission prompt — the
   *  App's `isTerminalBusy(activeTerminalId)`. Drives the NOW pulse + the elapsed timer. */
  busy: boolean
  /** The active terminal's effective activity string (self-reported or the parsed
   *  last tool-call line) — the SAME signal the sidebar dot reads. */
  activity?: string | null
  /** The active terminal's folded transcript blocks, for the session-cumulative COST
   *  sum. Sourced renderer-side from the shared transcript cache (see App.tsx). */
  blocks: readonly TranscriptBlock[]
  /** KNOWS (Phase 3) — the two shaped context digests for the active session/
   *  workspace (this-session overview + cross-session recall). Sourced from the
   *  EXISTING getSessionOverview + recallSummary accessors via useAgentRailKnows;
   *  shaped by the pure deriveKnows. The section renders ONLY when it has content
   *  (knows.hasContent) so an empty session never clutters the calm column. */
  knows?: RailKnows
  /** Open the active session's SessionOverview companion panel ("Open context →").
   *  Reuses the EXISTING openOverview path (the ⊕ sidebar button). Absent when there
   *  is no active session to open. */
  onOpenContext?: () => void
  /** Open the cross-session RecallPanel companion view ("Open Recall →"). Reuses the
   *  EXISTING `show_panel` "recall" type (CAPP-86 v1). */
  onOpenRecall?: () => void
  /** CAPP-101 (P1) — the propagation nudge. True when the ACTIVE terminal's owning session's
   *  WORKSPACE memory changed AFTER it spawned (its frozen launch inject is now stale). Drives
   *  a quiet, STATICALLY-VISIBLE KNOWS-tier "re-prime to pull" affordance (NOT a tier-1 gate —
   *  those never go in the rail). */
  memoryUpdated?: boolean
  /** CAPP-101 (P1) — the re-prime action: PROMPTS the running agent to pull the
   *  get_session_context delta (it does NOT itself inject the finding). Absent → no live
   *  terminal to re-prime (the affordance renders disabled). */
  onReprime?: () => void
  /** CAPP-104 (AB-1) — the BUTTONS group: the ALREADY-DERIVED visible subset (the active
   *  session's buttons ∪ its workspace's buttons, via deriveVisibleButtons in App.tsx).
   *  Absent/empty → the group doesn't render. */
  actionButtons?: readonly ActionButtonView[]
  /** Dispatch a button's stored prompt to its owning session's live agent terminal
   *  (spawning a fresh one if none is alive). */
  onDispatchButton?: (button: ActionButtonView) => void
  /** Remove a button (the row ✕). App.tsx routes to the actionbuttons:remove IPC. */
  onRemoveButton?: (button: ActionButtonView) => void
}

/**
 * Agent Rail (v1, Phase 1) — the persistent, narrow, collapsible RIGHT-edge column
 * for agent-initiated, present-tense state. A pure lens over EXISTING seams (no new
 * backend): NOW mirrors the busy/activity signals the sidebar dot already uses; COST
 * sums the per-turn ResultCost already parsed in agentTranscript.ts. See
 * docs/roadmap/agent-rail-design.md (§3, Phase 1).
 *
 * HARD RULES honored: every control (the collapse chevron, the spine reopen, the
 * KNOWS "Open context →" / "Open Recall →" links) is ALWAYS visible — no hover-reveal
 * (hover only tints). Warm Sand & Stone tokens only. Purely additive — collapsed, it
 * is a 32px spine and the center transcript reflows.
 *
 * Phase 3 — KNOWS (context digest) is now wired (CAPP-84 × CAPP-86 v1.5): two digests
 * (this-session overview + cross-session recall) slotted into the placeholder below,
 * rendered ONLY when there's content so the empty rail stays byte-identical/calm.
 *
 * The WORKING (mission lighthouse) and AWAITING (tier-2/3 signals + inline answer)
 * sections remain LATER phases — their slot stays a clearly-commented placeholder so
 * the next phase drops in without re-laying out the column.
 */
export default function AgentRail({
  open,
  onToggle,
  hasTerminal,
  terminalId,
  busy,
  activity,
  blocks,
  knows,
  onOpenContext,
  onOpenRecall,
  memoryUpdated,
  onReprime,
  actionButtons,
  onDispatchButton,
  onRemoveButton,
}: Props) {
  const now = deriveNow({ hasTerminal, busy, activity })
  const cost = sumCost(blocks)
  const costLabel = formatCost(cost)

  // CAPP-104 (AB-1) — the two-step inline-confirm state, KEYED BY BUTTON ID so an armed
  // confirm can never leak across rows (the CAPP-115 lesson). Cleared whenever the
  // visible set changes so a removed/re-scoped button can't leave a stale arm behind.
  const [armedButtonId, setArmedButtonId] = useState<string | null>(null)
  const buttons = actionButtons ?? []
  const buttonsKey = buttons.map((b) => b.id).join(",")
  useEffect(() => {
    setArmedButtonId(null)
  }, [buttonsKey])

  const handleButtonClick = (button: ActionButtonView) => {
    const outcome = resolveClick(button, armedButtonId)
    setArmedButtonId(outcome.armedId)
    if (outcome.dispatch) onDispatchButton?.(button)
  }
  const handleButtonRemove = (button: ActionButtonView) => {
    // Remove is ALWAYS confirmed (design): a small conventional ✕ + a window.confirm.
    if (!window.confirm(`Remove the "${button.label}" button?`)) return
    setArmedButtonId((cur) => (cur === button.id ? null : cur))
    onRemoveButton?.(button)
  }

  // Live elapsed clock for the NOW line — runs ONLY while busy. Re-anchors on the
  // busy rising edge AND on an active-terminal switch (the `terminalId` dep): without
  // that, switching from busy terminal A to busy terminal B keeps `busy === true`, so
  // the effect wouldn't re-run and B would show A's accumulated, ever-growing elapsed.
  // (It resets to 0:00 on switch — it does not recover B's true earlier turn start,
  // which would need a backend per-terminal turn-start timestamp.)
  const [elapsedMs, setElapsedMs] = useState(0)
  const startRef = useRef<number | null>(null)
  useEffect(() => {
    if (!busy) {
      startRef.current = null
      setElapsedMs(0)
      return
    }
    // (Re)anchor the start, paint 0:00 immediately, then tick.
    startRef.current = Date.now()
    setElapsedMs(0)
    const id = setInterval(() => {
      if (startRef.current != null) setElapsedMs(Date.now() - startRef.current)
    }, 1000)
    return () => clearInterval(id)
  }, [busy, terminalId])

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
          aria-expanded={false}
        >
          <span className="agent-rail-spine-chevron" aria-hidden="true">‹</span>
          <span className="agent-rail-spine-label">AGENT RAIL</span>
        </button>
      </div>
    )
  }

  const showKnows = open && !!knows?.hasContent
  // CAPP-101 (P1) — the propagation nudge renders only when this terminal is marked.
  const showReprime = open && memoryUpdated === true
  // CAPP-104 (AB-1) — the BUTTONS group renders only when the active session/workspace
  // has at least one visible button.
  const showButtons = open && buttons.length > 0
  // The resting "All quiet" copy shows only when EVERY surface is empty — NOW idle,
  // no cost yet, KNOWS has nothing, no pending re-prime nudge, AND no buttons.
  const empty =
    now.state === "idle" && costLabel == null && !showKnows && !showReprime && !showButtons

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
          aria-expanded={true}
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

        {/* CAPP-101 (P1) — the PROPAGATION NUDGE. The workspace memory changed AFTER this
            terminal spawned, so its frozen launch inject is stale. A quiet, STATICALLY-VISIBLE
            KNOWS-tier affordance (no hover-reveal) with an honest label + a "Re-prime" action.
            HONEST: re-prime PROMPTS the agent to pull the get_session_context delta — it does
            NOT itself inject the finding. NOT a tier-1 blocking gate (those never go in the
            rail). Slots between NOW and KNOWS. */}
        {showReprime && (
          <section
            className="agent-rail-section agent-rail-reprime"
            aria-label="Workspace memory updated"
          >
            <div className="agent-rail-section-label">KNOWS</div>
            <div className="agent-rail-reprime-card">
              <div className="agent-rail-reprime-text">
                Workspace memory updated — re-prime to pull
              </div>
              <button
                type="button"
                className="agent-rail-reprime-btn"
                onClick={onReprime}
                disabled={!onReprime}
                title="Ask the running agent to pull the latest workspace memory (get_session_context)"
              >
                Re-prime
              </button>
            </div>
          </section>
        )}

        {/* KNOWS (Phase 3 — CAPP-84 × CAPP-86 v1.5) — the context digest. TWO
            sub-sections for the active session/workspace, each present only when it
            has content: "This session" (overview) + "Across sessions" (recall). Both
            carry an ALWAYS-VISIBLE "Open …→" link (no hover-reveal) to the matching
            companion panel. Slots HERE, between NOW and COST. */}
        {showKnows && knows && (
          <section className="agent-rail-section agent-rail-knows">
            <div className="agent-rail-section-label">KNOWS</div>

            {knows.session && (
              <div className="agent-rail-knows-group">
                <div className="agent-rail-knows-head">
                  <span className="agent-rail-knows-scope">This session</span>
                  <button
                    type="button"
                    className="agent-rail-knows-open"
                    onClick={onOpenContext}
                    disabled={!onOpenContext}
                    title="Open the Session Overview panel"
                  >
                    Open context →
                  </button>
                </div>
                <KnowsChips
                  findings={knows.session.findings}
                  ruledOut={knows.session.ruledOut}
                  provisional={knows.session.provisional}
                />
                {knows.session.summary && (
                  <div className="agent-rail-knows-summary" title={knows.session.summary}>
                    {knows.session.summary}
                  </div>
                )}
                {knows.session.recentRuledOut && (
                  <RuledOutOneLiner line={knows.session.recentRuledOut} />
                )}
              </div>
            )}

            {knows.recall && (
              <div className="agent-rail-knows-group">
                <div className="agent-rail-knows-head">
                  <span className="agent-rail-knows-scope">
                    Across {knows.recall.sessions}{" "}
                    {knows.recall.sessions === 1 ? "session" : "sessions"}
                  </span>
                  <button
                    type="button"
                    className="agent-rail-knows-open"
                    onClick={onOpenRecall}
                    disabled={!onOpenRecall}
                    title="Open the cross-session Recall panel"
                  >
                    Open Recall →
                  </button>
                </div>
                <KnowsChips
                  findings={knows.recall.findings}
                  ruledOut={knows.recall.ruledOut}
                />
                {knows.recall.recentRuledOut && (
                  <RuledOutOneLiner
                    line={knows.recall.recentRuledOut}
                    from={knows.recall.recentRuledOut.sessionName}
                  />
                )}
              </div>
            )}

            {/* Workspace memory — the durable, always-present tier (CAPP-87 / U4),
                surfaced as its OWN third group (independent of how many sessions
                contributed). "Open Recall →" reuses the same cross-session Recall panel
                (which now unions workspace memory too). No hover-reveal. */}
            {knows.workspaceMemory && (
              <div className="agent-rail-knows-group">
                <div className="agent-rail-knows-head">
                  <span className="agent-rail-knows-scope">Workspace memory</span>
                  <button
                    type="button"
                    className="agent-rail-knows-open"
                    onClick={onOpenRecall}
                    disabled={!onOpenRecall}
                    title="Open the cross-session Recall panel"
                  >
                    Open Recall →
                  </button>
                </div>
                <KnowsChips
                  findings={knows.workspaceMemory.findings}
                  ruledOut={knows.workspaceMemory.ruledOut}
                />
              </div>
            )}
          </section>
        )}

        {/* BUTTONS (CAPP-104 / AB-1) — agent-generated rail action buttons. The union of
            the ACTIVE session's buttons + its workspace's buttons (derived in App.tsx).
            Each row is a STATICALLY-VISIBLE text button (the label — words over icons) + a
            small conventional ✕ (remove, always window.confirm-guarded). A confirm:true
            button interposes a two-step inline confirm ON THE BUTTON, keyed by id so an
            armed confirm never leaks across rows. Clicking dispatches the stored prompt to
            the session's live agent terminal. NEVER a tier-1 gate — buttons are
            affordances. Slots between KNOWS and COST. No hover-reveal. */}
        {showButtons && (
          <section className="agent-rail-section agent-rail-buttons" aria-label="Action buttons">
            <div className="agent-rail-section-label">BUTTONS</div>
            <div className="agent-rail-buttons-list">
              {buttons.map((button) => {
                const armed = armedButtonId === button.id
                return (
                  <div className="agent-rail-button-row" key={button.id}>
                    <button
                      type="button"
                      className={`agent-rail-button ${armed ? "armed" : ""}`}
                      onClick={() => handleButtonClick(button)}
                      title={armed ? "Click again to confirm" : button.prompt}
                    >
                      {armed ? "Confirm?" : button.label}
                    </button>
                    <button
                      type="button"
                      className="agent-rail-button-remove"
                      onClick={() => handleButtonRemove(button)}
                      title={`Remove "${button.label}"`}
                      aria-label={`Remove ${button.label}`}
                    >
                      ✕
                    </button>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* ── LATER-PHASE SEAMS (docs/roadmap/agent-rail-design.md §3) ──────────────
            Phase 2 — WORKING (mission lighthouse): goal excerpt + progress bar +
              status chip + worker count + "View board →" (window.api.showPanel
              'mission'), sourced from useMissions / mission:updated. Present only
              when a mission is active in the focused session.
            Phase 4 — AWAITING (tier-2/3 only): tier-tinted dismissable rows scoped
              to the active terminal (tier-1 filtered out), with an inline mini-
              composer on an `asked` entry wired to sendAgentInput.
            Each slots in HERE, between KNOWS and COST, without re-laying out the column.
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

      {/* COST — spend for the active terminal's CURRENT SPAWN, summed renderer-side from
          the per-turn ResultCost (CAPP-125: per-turn deltas off the cumulative
          total_cost_usd, so no triangular overcount). Pinned to the footer; present only
          when there is turn data. Labeled "this spawn": it resets on a respawn/interrupt
          and misses scrolled-out turns (design doc Q5) — a glance number, not an audit. */}
      <div className="agent-rail-footer">
        <div className="agent-rail-section-label">
          COST <span className="agent-rail-cost-scope">· this spawn</span>
        </div>
        <div
          className="agent-rail-cost"
          title="Spend for this terminal's current spawn (per-turn, summed). Resets on respawn/interrupt."
        >
          {costLabel ?? "—"}
        </div>
      </div>
    </aside>
  )
}

/**
 * The KNOWS count chips — findings / ruled-out / (optional) provisional. A chip is
 * rendered for every count (including 0 for findings/ruled-out so the digest reads
 * as a complete picture); provisional is shown only when the seam has any (it stays
 * dormant for most sessions). Always visible — no hover-reveal.
 */
function KnowsChips({
  findings,
  ruledOut,
  provisional,
}: {
  findings: number
  ruledOut: number
  provisional?: number
}) {
  return (
    <div className="agent-rail-knows-chips">
      <span className="agent-rail-knows-chip findings" title="Active findings">
        {findings} {findings === 1 ? "finding" : "findings"}
      </span>
      <span className="agent-rail-knows-chip ruled-out" title="Ruled-out / corrected">
        {ruledOut} ruled out
      </span>
      {provisional != null && (
        <span className="agent-rail-knows-chip provisional" title="Provisional findings">
          {provisional} provisional
        </span>
      )}
    </div>
  )
}

/**
 * The most-recent ruled-out one-liner, rendered as the `~~old~~ → new` correction
 * pair (matching the SessionOverview / RecallPanel rendering) so a glance shows what
 * was DISPROVEN and what replaced it. Optionally tagged with the owning session name
 * (the cross-session digest), so a recall hit reads as "from <that session>".
 */
function RuledOutOneLiner({ line, from }: { line: RuledOutLine; from?: string }) {
  return (
    <div className="agent-rail-knows-ruled" title={line.text}>
      <span className="agent-rail-knows-struck">{line.text}</span>
      {line.correction && (
        <span className="agent-rail-knows-correction"> → {line.correction}</span>
      )}
      {from && <span className="agent-rail-knows-from"> · {from}</span>}
    </div>
  )
}
