import { useEffect, useRef, useState } from "react"
import { formatCost, deriveNow, formatElapsed, type RailCost } from "../lib/agentRail"
import {
  shouldPinToNewest,
  outputGlyph,
  outputRowAction,
  formatOutputTime,
} from "../lib/agentRailOutputs"
import type { RailOutput } from "../../electron/services/streamProtocol"

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
  /** CAPP-129 — the active terminal's DURABLE per-terminal cost total (conversation-
   *  lineage, surviving respawns + app restarts). Derived in App.tsx from the active
   *  terminal ref via `railCostFromTerminal`. */
  cost: RailCost
  /** CAPP-132 — the ACTIVE SESSION's durable OUTPUTS feed (all its terminals),
   *  chronological FIFO. Unlike NOW/COST (active-terminal-scoped) this is session-scoped.
   *  The section is ABSENT when empty. */
  outputs: RailOutput[]
  /** CAPP-132 — remove one output entry (the row ✕). */
  onRemoveOutput: (outputId: string) => void
  /** CAPP-132 — clear the whole OUTPUTS feed (the section header Clear button). */
  onClearOutputs: () => void
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
 * The AWAITING (tier-2/3 signals + inline answer) section remains a LATER phase —
 * its slot stays a clearly-commented placeholder so the next phase drops in without
 * re-laying out the column.
 */
export default function AgentRail({
  open,
  onToggle,
  hasTerminal,
  terminalId,
  busy,
  activity,
  cost,
  outputs,
  onRemoveOutput,
  onClearOutputs,
}: Props) {
  const now = deriveNow({ hasTerminal, busy, activity })
  const costLabel = formatCost(cost)

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

  // The resting "All quiet" copy shows only when EVERY surface is empty — NOW idle,
  // no cost yet, AND no outputs in the session's feed.
  const empty = now.state === "idle" && costLabel == null && outputs.length === 0

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

        {/* OUTPUTS (CAPP-132) — the SESSION's durable FIFO feed of deliverables (links,
            files, notes), chronological (oldest top → newest bottom). Absent when empty;
            no arrival animation (stable ids as keys, monotonic list). Sits between NOW and
            COST. See docs/roadmap/rail-outputs-feed-design.md §6. */}
        {outputs.length > 0 && (
          <OutputsSection
            outputs={outputs}
            onRemove={onRemoveOutput}
            onClear={onClearOutputs}
          />
        )}

        {/* ── LATER-PHASE SEAMS (docs/roadmap/agent-rail-design.md §3) ──────────────
            Phase 4 — AWAITING (tier-2/3 only): tier-tinted dismissable rows scoped
              to the active terminal (tier-1 filtered out), with an inline mini-
              composer on an `asked` entry wired to sendAgentInput.
            Slots in HERE, between NOW and COST, without re-laying out the column.
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

      {/* COST — CAPP-129: the DURABLE per-terminal total, read off the active terminal's
          SessionService ref (per-turn deltas accumulated in the main process; CAPP-125
          cumulative→delta so no triangular overcount). It is the conversation-LINEAGE total
          — it SURVIVES respawns/interrupts/model-switches AND app restarts (no longer the
          per-spawn figure). Pinned to the footer; present only when there is turn data. */}
      <div className="agent-rail-footer">
        <div className="agent-rail-section-label">
          COST <span className="agent-rail-cost-scope">· this terminal</span>
        </div>
        <div
          className="agent-rail-cost"
          title="Total spend for this terminal's conversation — across every respawn and app restart (per-turn, summed)."
        >
          {costLabel ?? "—"}
        </div>
      </div>
    </aside>
  )
}

/**
 * CAPP-132 — the OUTPUTS section: a header (label + count + always-visible Clear) and a
 * scrollable, chronological FIFO list (oldest top → newest bottom) with a max-height so
 * COST stays pinned. Autoscroll follows the newest entry ONLY while the user is pinned to
 * the bottom (a scroll-up de-arms it — pure {@link shouldPinToNewest} decision). No
 * hover-reveal (every control is always visible); no arrival animation (stable ids as keys).
 */
function OutputsSection({
  outputs,
  onRemove,
  onClear,
}: {
  outputs: RailOutput[]
  onRemove: (id: string) => void
  onClear: () => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  // Follow the newest entry while pinned to the bottom; leave the viewport alone if the
  // user scrolled up to read history. Re-runs when the list grows (or an entry is removed).
  useEffect(() => {
    const el = listRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [outputs.length])

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    pinnedRef.current = shouldPinToNewest({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    })
  }

  return (
    <section className="agent-rail-section agent-rail-outputs">
      <div className="agent-rail-outputs-head">
        <span className="agent-rail-section-label">
          OUTPUTS <span className="agent-rail-outputs-count">{outputs.length}</span>
        </span>
        <button
          type="button"
          className="agent-rail-outputs-clear"
          onClick={onClear}
          title="Clear all outputs"
        >
          Clear
        </button>
      </div>
      <div className="agent-rail-outputs-list" ref={listRef} onScroll={onScroll}>
        {outputs.map((o) => (
          <OutputRow key={o.id} output={o} onRemove={() => onRemove(o.id)} />
        ))}
      </div>
    </section>
  )
}

/** One OUTPUTS row: kind glyph + title + compact time, an always-visible primary action
 *  (link → open externally; file → reveal in the OS file manager; note → inline expand),
 *  and an always-visible ✕ remove. No hover-reveal. */
function OutputRow({ output, onRemove }: { output: RailOutput; onRemove: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const action = outputRowAction(output)

  const runAction = () => {
    if (output.kind === "link" && output.url) void window.api.openExternalUrl(output.url)
    else if (output.kind === "file" && output.path) void window.api.revealPath(output.path)
  }

  return (
    <div className={`agent-rail-output kind-${output.kind}`}>
      <div className="agent-rail-output-main">
        <span className="agent-rail-output-glyph" aria-hidden="true">
          {outputGlyph(output.kind)}
        </span>
        <span className="agent-rail-output-title" title={output.url ?? output.path ?? output.title}>
          {output.title}
        </span>
        <span className="agent-rail-output-time" aria-hidden="true">
          {formatOutputTime(output.ts)}
        </span>
      </div>
      <div className="agent-rail-output-actions">
        {output.kind === "note" ? (
          <button
            type="button"
            className="agent-rail-output-action"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            title={expanded ? "Collapse note" : "Expand note"}
          >
            <span className="agent-rail-output-chevron" aria-hidden="true">
              {expanded ? "▾" : "▸"}
            </span>
            {expanded ? "Hide" : "Show"}
          </button>
        ) : (
          <button
            type="button"
            className="agent-rail-output-action"
            onClick={runAction}
            title={output.kind === "link" ? "Open in browser" : "Reveal in file manager"}
          >
            {action.label}
          </button>
        )}
        <button
          type="button"
          className="agent-rail-output-remove"
          onClick={onRemove}
          title="Remove from outputs"
          aria-label="Remove output"
        >
          ✕
        </button>
      </div>
      {output.kind === "note" && expanded && output.text && (
        <pre className="agent-rail-output-note">{output.text}</pre>
      )}
    </div>
  )
}
