/**
 * Tool-run COLLAPSE — a pure, display-only view-model pass that folds a maximal run
 * of CONSECUTIVE tool calls into ONE collapsible group. A long autonomous turn is
 * dominated by tool bursts (read/grep/edit/bash ×20-30 in a row); rendered raw, the
 * transcript history is a wall of tool rows that buries the agent's actual prose. This
 * module groups those bursts so the default view is calm and the burst is one line the
 * user can expand.
 *
 * DISPLAY-ONLY + PURE: it runs over the already-folded {@link TranscriptBlock}[] the
 * reducer produced (never mutates it), so tool correlation, per-tool status, the
 * context meter, windowing, and streaming are all untouched — only HOW the blocks are
 * grouped for the DOM changes. Zero React/Electron imports → unit-testable in node,
 * the same seam pattern as transcriptWindow.ts / scrollStick.ts.
 *
 * Grouping rule (matches the user's ask — "continually accepts new tool calls until
 * there's a different kind of output"):
 *   - a run STARTS at a `tool` block and extends over subsequent `tool` blocks;
 *   - a `raw` block (e.g. a stray `rate_limit_event`) is TRANSPARENT — it neither
 *     starts nor breaks a run, so a burst isn't fragmented into "10 tools / raw / 14
 *     tools". Interleaved raws are absorbed into the group body (never lost); a run's
 *     TRAILING raws are trimmed back out so the group is always bounded by tools;
 *   - ANY other block kind (assistant / thinking / user / result / error / …) breaks
 *     the run;
 *   - a run of fewer than {@link TOOL_GROUP_MIN_RUN} tools is left inline (collapsing a
 *     lone tool call buys nothing but an extra click).
 */

import type { TranscriptBlock, ToolBlock, ToolStatus } from "./agentTranscript"

/** The minimum number of tool calls in a consecutive run before it collapses into a
 *  group. A run below this renders inline as individual rows (a single tool tied to a
 *  line of narration reads fine; a burst does not). */
export const TOOL_GROUP_MIN_RUN = 2

/** One `name ×count` entry of a group's per-tool-name breakdown. */
export interface ToolNameCount {
  name: string
  count: number
}

/** A collapsed run of consecutive tool calls (a display item, NOT a transcript block). */
export interface ToolGroupItem {
  kind: "tool-group"
  /** Stable React key — the id of the run's FIRST tool block (creation-ordered, so it
   *  is invariant as more tools stream into the run). */
  id: string
  /** Every block the run absorbed, in order — the tool blocks PLUS any transparent raw
   *  events interleaved between them. Rendered in the expandable body (nothing lost). */
  items: TranscriptBlock[]
  /** Just the tool blocks (drives the count + name breakdown). */
  tools: ToolBlock[]
  /** Number of tool calls (== tools.length; the header's "N tool calls"). */
  count: number
  /** How many tools are still running (a live burst). */
  running: number
  /** How many tools errored (surfaced in the header so failures aren't hidden). */
  errored: number
  /** Aggregate status: `error` if any errored, else `running` if any running, else `done`. */
  status: ToolStatus
  /** Per-tool-name counts, most-frequent first (ties broken alphabetically). */
  breakdown: ToolNameCount[]
}

/** A single item in the display list: either a plain block or a collapsed tool group. */
export type DisplayItem = { kind: "block"; block: TranscriptBlock } | ToolGroupItem

/** Blocks that are TRANSPARENT to a tool run — present but neither start nor break it. */
function isTransparent(b: TranscriptBlock): boolean {
  return b.kind === "raw"
}

/** Build a {@link ToolGroupItem} from a run whose FIRST element is a tool block and
 *  whose LAST element is a tool block (trailing transparents already trimmed). */
function buildGroup(items: TranscriptBlock[]): ToolGroupItem {
  const tools = items.filter((b): b is ToolBlock => b.kind === "tool")
  let running = 0
  let errored = 0
  const counts = new Map<string, number>()
  for (const t of tools) {
    if (t.status === "running") running++
    else if (t.status === "error") errored++
    const name = t.name || "tool"
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const status: ToolStatus = errored > 0 ? "error" : running > 0 ? "running" : "done"
  const breakdown: ToolNameCount[] = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  return {
    kind: "tool-group",
    id: items[0].id,
    items,
    tools,
    count: tools.length,
    running,
    errored,
    status,
    breakdown,
  }
}

/**
 * Fold consecutive tool runs in `blocks` into {@link ToolGroupItem}s (see the module
 * doc for the exact rule). Pure — returns a fresh display list, never mutates the input.
 * A run of fewer than `minRun` tools is emitted as inline `block` items unchanged.
 */
export function groupToolRuns(
  blocks: readonly TranscriptBlock[],
  minRun: number = TOOL_GROUP_MIN_RUN,
): DisplayItem[] {
  const out: DisplayItem[] = []
  const n = blocks.length
  let i = 0
  while (i < n) {
    const b = blocks[i]
    // A run can only START at a tool block; anything else passes through as-is.
    if (b.kind !== "tool") {
      out.push({ kind: "block", block: b })
      i++
      continue
    }
    // Extend the run over tools + transparent raws, tracking the LAST tool so we can
    // trim trailing transparents back into the main flow (the group stays tool-bounded).
    let j = i
    let lastTool = i
    while (j < n && (blocks[j].kind === "tool" || isTransparent(blocks[j]))) {
      if (blocks[j].kind === "tool") lastTool = j
      j++
    }
    const run = blocks.slice(i, lastTool + 1)
    const toolCount = run.reduce((c, x) => c + (x.kind === "tool" ? 1 : 0), 0)
    if (toolCount >= minRun) {
      out.push(buildGroup(run))
    } else {
      for (const x of run) out.push({ kind: "block", block: x })
    }
    i = lastTool + 1
  }
  return out
}

/**
 * A compact `Read ×10 · Grep ×6 · Edit ×5` summary of a group's tool mix, capped at
 * `maxNames` distinct names (the rest folded into a `+N more` tail). Pure + string-only.
 */
export function summarizeToolGroup(group: ToolGroupItem, maxNames = 4): string {
  const shown = group.breakdown.slice(0, maxNames).map((b) => `${b.name} ×${b.count}`)
  const rest = group.breakdown.length - maxNames
  if (rest > 0) shown.push(`+${rest} more`)
  return shown.join(" · ")
}

/**
 * The name of the tool the group is CURRENTLY running (the most-recent still-running
 * tool), or null when the burst has settled. Drives the header's live "Running X…"
 * label so a collapsed live burst keeps its activity signal.
 */
export function activeToolLabel(group: ToolGroupItem): string | null {
  if (group.running === 0) return null
  for (let i = group.tools.length - 1; i >= 0; i--) {
    if (group.tools[i].status === "running") return group.tools[i].name || "tool"
  }
  return null
}
