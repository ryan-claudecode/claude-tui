/**
 * CAPP-132 — the PURE decision layer for the Agent Rail's OUTPUTS section. Zero
 * React / Electron imports (mirrors src/lib/agentRail.ts → AgentRail) so every
 * decision worth proving is unit-testable in the node-only test env.
 *
 * Holds: the autoscroll pin-to-newest decision (delegating to the shared
 * scroll-stick logic so it can't drift from AgentView's), and the row projection
 * helpers (kind glyph, action label, compact time).
 */
import { shouldStick, type ScrollMetrics } from "./scrollStick"
import type { RailOutput } from "../../electron/services/streamProtocol"

/**
 * Whether the OUTPUTS list should PIN to the newest entry (follow new content).
 * True IFF the viewport is at/near the bottom — so a NEW output pins to the
 * bottom while pinned, but does NOT yank the viewport if the user scrolled up to
 * read history. Delegates to {@link shouldStick} (the same threshold AgentView
 * uses) so the two can't drift.
 */
export function shouldPinToNewest(m: ScrollMetrics, threshold = 24): boolean {
  return shouldStick(m, threshold)
}

/** The kind glyph for an output row (link / file / note). */
export function outputGlyph(kind: RailOutput["kind"]): string {
  return kind === "link" ? "🔗" : kind === "file" ? "📄" : "📝"
}

/** The row's primary action: open a link, reveal a file, or expand a note inline. */
export interface OutputRowAction {
  kind: "open" | "reveal" | "expand"
  /** The action verb ("Open" / "Reveal"), or null for a note (chevron expand only). */
  label: string | null
}

export function outputRowAction(o: Pick<RailOutput, "kind">): OutputRowAction {
  if (o.kind === "link") return { kind: "open", label: "Open" }
  if (o.kind === "file") return { kind: "reveal", label: "Reveal" }
  return { kind: "expand", label: null }
}

/**
 * A compact "how long ago" label for an output row, relative to `now` (injectable
 * for deterministic tests): "now" (<1m), "5m", "2h", "3d". Kept relative rather
 * than an absolute clock so tests are timezone-independent.
 */
export function formatOutputTime(ts: number, now: number = Date.now()): string {
  const diffS = Math.floor(Math.max(0, now - ts) / 1000)
  if (diffS < 60) return "now"
  const m = Math.floor(diffS / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}
