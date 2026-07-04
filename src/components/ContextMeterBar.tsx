import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { ContextMeter } from "../lib/contextMeter"

/**
 * CAPP-127 — the live context-meter bar: a slim, statically-visible segmented bar
 * pinned across the bottom of the structured chat surface (between AgentView and the
 * composer). It shows how full the model's context window is, filling as `result`
 * events land — the three colored segments (baseline / conversation history / this
 * turn) tile the current total under the model's cap, and the remainder tints
 * warning-amber past 70% and error-red past 90%.
 *
 * CLICK (not hover — per the project's no-hover rule) opens a compact legend popover
 * anchored above the bar, explaining each color with its live token count and
 * offering two visible TEXT actions: "Compact" (sends /compact through the agent-input
 * path) and "Handoff" (retire-and-continue, the same as Ctrl+Shift+H). The popover is
 * position:fixed so no ancestor overflow (.terminal-container is overflow:hidden) can
 * clip it, and closes on click-outside or Escape.
 *
 * The meter is per-terminal derived state, so it resets naturally on handoff / a fresh
 * terminal, and rehydrates for free on a restored transcript (its input is the same
 * folded blocks the transcript renders). Rendered ONLY for structured terminals and
 * ONLY once at least one usage-bearing result exists (`meter != null`).
 */
interface Props {
  /** The derived meter, or null when there's nothing to show yet (bar hides). */
  meter: ContextMeter | null
  /** The agent is generating a turn / parked on a permission — disables Compact
   *  (a /compact would write into a stdin the parked turn can't read). */
  busy?: boolean
  /** Send `/compact` to the agent (through the same input path the composer uses). */
  onCompact: () => void
  /** Retire-and-continue this terminal (same mechanism as Ctrl+Shift+H). */
  onHandoff: () => void
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString()
}

function pctLabel(fraction: number): string {
  return `${(fraction * 100).toFixed(fraction >= 0.1 ? 0 : 1)}%`
}

export default function ContextMeterBar({ meter, busy = false, onCompact, onHandoff }: Props) {
  const [open, setOpen] = useState(false)
  const barRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  // Fixed-position anchor for the popover (computed from the bar's rect so no ancestor
  // overflow clips it). left = bar's left; bottom = viewport height − bar top (so the
  // popover sits directly ABOVE the bar).
  const [anchor, setAnchor] = useState<{ left: number; bottom: number; width: number } | null>(null)

  const placeAnchor = useCallback(() => {
    const el = barRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setAnchor({ left: r.left, bottom: window.innerHeight - r.top + 6, width: r.width })
  }, [])

  // Recompute the anchor whenever the popover opens (and on resize/scroll while open).
  useLayoutEffect(() => {
    if (!open) return
    placeAnchor()
    window.addEventListener("resize", placeAnchor)
    window.addEventListener("scroll", placeAnchor, true)
    return () => {
      window.removeEventListener("resize", placeAnchor)
      window.removeEventListener("scroll", placeAnchor, true)
    }
  }, [open, placeAnchor])

  // Close on click-outside (bar + popover excluded) and on Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (barRef.current?.contains(t) || popRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        setOpen(false)
      }
    }
    // capture on Escape so this popover claims it before the composer's interrupt arm.
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey, true)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey, true)
    }
  }, [open])

  const doCompact = useCallback(() => {
    onCompact()
    setOpen(false)
  }, [onCompact])
  const doHandoff = useCallback(() => {
    onHandoff()
    setOpen(false)
  }, [onHandoff])

  if (!meter) return null

  const { baseline, history, lastTurn, total, cap, pct, zone } = meter
  // Segment widths as a fraction of the CAP (so the empty remainder is visible).
  const wBase = Math.max(0, baseline / cap)
  const wHist = Math.max(0, history / cap)
  const wLast = Math.max(0, lastTurn / cap)

  const legendRows: { key: string; cls: string; label: string; value: number }[] = [
    { key: "baseline", cls: "context-meter-swatch-baseline", label: "Baseline (system + tools)", value: baseline },
    { key: "history", cls: "context-meter-swatch-history", label: "Conversation history", value: history },
    { key: "lastTurn", cls: "context-meter-swatch-last", label: "Last turn", value: lastTurn },
  ]

  return (
    <div className="context-meter-wrap">
      <button
        type="button"
        ref={barRef}
        className={`context-meter context-meter-zone-${zone}${open ? " open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Context: ${fmt(total)} of ${fmt(cap)} tokens (${pctLabel(pct)}). Click for details.`}
        title={`Context ${pctLabel(pct)} — ${fmt(total)} / ${fmt(cap)} tokens · click for details`}
      >
        <span className="context-meter-track">
          <span
            className="context-meter-seg context-meter-seg-baseline"
            style={{ width: `${wBase * 100}%` }}
          />
          <span
            className="context-meter-seg context-meter-seg-history"
            style={{ width: `${wHist * 100}%` }}
          />
          <span
            className="context-meter-seg context-meter-seg-last"
            style={{ width: `${wLast * 100}%` }}
          />
        </span>
      </button>

      {open && (
        <div
          className="context-meter-popover"
          role="dialog"
          aria-label="Context usage"
          ref={popRef}
          style={
            anchor
              ? { position: "fixed", left: anchor.left, bottom: anchor.bottom, minWidth: Math.min(320, anchor.width) }
              : undefined
          }
        >
          <div className="context-meter-pop-head">
            <span className="context-meter-pop-title">Context usage</span>
            <button
              type="button"
              className="context-meter-pop-x"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </div>

          <ul className="context-meter-legend">
            {legendRows.map((r) => (
              <li className="context-meter-legend-row" key={r.key}>
                <span className={`context-meter-swatch ${r.cls}`} aria-hidden="true" />
                <span className="context-meter-legend-label">{r.label}</span>
                <span className="context-meter-legend-value">{fmt(r.value)}</span>
              </li>
            ))}
          </ul>

          <div className="context-meter-total">
            <span className="context-meter-total-text">
              {fmt(total)} of {fmt(cap)} tokens
            </span>
            <span className={`context-meter-total-pct context-meter-zone-${zone}`}>{pctLabel(pct)}</span>
          </div>

          <p className="context-meter-caveat">Estimate from the last turn's reported usage.</p>

          <div className="context-meter-actions">
            <button
              type="button"
              className="context-meter-action"
              onClick={doCompact}
              disabled={busy}
              title={
                busy
                  ? "Stop the agent before compacting"
                  : "Ask the agent to /compact the conversation to free context"
              }
            >
              Compact
            </button>
            <button
              type="button"
              className="context-meter-action"
              onClick={doHandoff}
              title="Retire this terminal and continue in a fresh one (Ctrl+Shift+H)"
            >
              Handoff
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
