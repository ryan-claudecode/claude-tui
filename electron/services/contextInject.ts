/**
 * CAPP-96 (Slice 1) — the auto-loaded "brain" payload builder.
 *
 * The CAPP-87 durable brain (workspace memory ∪ live session findings) is PULL today
 * (an agent must call `get_session_context`/`recall`). This makes it PUSH: a fresh
 * session inherits its curated workspace + session context behind the scenes, injected
 * via `--append-system-prompt-file <path>` — a seam our own stream-json reducer
 * provably never surfaces (see `streamEvents.ts` + the visibility regression test).
 *
 * This module is PURE: it assembles the markdown from already-fetched data (the
 * spawning session's workspace tier + session tier), value-orders + caps it under a
 * byte budget, and renders. NO I/O, NO service refs — the wiring layer (ipc.ts) reads
 * the warmed RecallService index + the WorkspaceMemoryService cache and hands the data
 * in, then the TerminalService writes the result to `~/.claude-tui/context/<tid>.md`.
 *
 * Design: `docs/roadmap/context-autoload-sync-design.md` §A + §B.
 */

import { DEFAULT_INJECT_MAX_BYTES } from "../config"

/** A workspace-tier finding for the payload (from the recall union @ scope:'workspace'). */
export interface InjectWorkspaceFinding {
  text: string
  status: "active" | "ruled-out"
  /** For a ruled-out finding: the corrector's text (rendered `~~old~~ → new`). */
  correction?: string
  /** Recency stamp — used ONLY for value-ordering (active workspace findings keep
   *  OLDEST first, because foundational findings are often the load-bearing rules). */
  createdAt: number
  /** Never evicted under the cap (DECISION 7). */
  pinned?: boolean
}

/** The session-tier sections (mirrors `SessionService.getSessionContextSections`). */
export interface InjectSessionTier {
  name: string
  summary: string
  active: { text: string }[]
  ruledOut: { text: string; correction?: string }[]
}

/** Everything the builder needs, fetched by the wiring layer. */
export interface InjectContextInput {
  /** The workspace's durable standing instructions (`getMemory(W).instructions`). */
  instructions: string
  /** The durable workspace findings (recall union, scope:'workspace', the memory tier). */
  workspaceFindings: InjectWorkspaceFinding[]
  /** The spawning session's own context sections (undefined → no session tier). */
  session?: InjectSessionTier
}

export interface BuildOptions {
  /** A RESUME spawn injects a SHORT pointer, not the full snapshot (DECISION 6). */
  resume?: boolean
  /** The hard byte cap (default {@link DEFAULT_INJECT_MAX_BYTES}). */
  maxBytes?: number
}

/** Per-item caps (design doc §B.3) — one essay-finding can't dominate the budget. */
const INSTRUCTIONS_CAP = 1500
const FINDING_CAP = 400

/**
 * The SHORT stamped pointer injected on a RESUME spawn (DECISION 6). A `--resume`
 * replays a transcript that already absorbed the ORIGINAL launch snapshot; re-appending
 * a current-disk snapshot layers contradictions over prior reasoning and re-pays the
 * budget. So on resume we inject only this minimal nudge to the live pull path.
 */
export const RESUME_POINTER =
  "# Context for this session\n" +
  "> Auto-loaded by Mission Control.\n\n" +
  "Durable context may have changed since this conversation started — call " +
  "`get_session_context` for the live view."

/** Byte length under UTF-8 (the real on-disk + token cost, not the char count). */
export function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8")
}

/** Hard-truncate a string to at most `cap` chars, appending an ellipsis marker when cut. */
function capText(text: string, cap: number): string {
  const t = text.trim()
  if (t.length <= cap) return t
  return t.slice(0, cap).trimEnd() + " …"
}

/** Render one workspace finding line (pinned marker / strikethrough+correction). */
function renderWorkspaceFinding(f: InjectWorkspaceFinding): string {
  const body = capText(f.text, FINDING_CAP)
  if (f.status === "ruled-out") {
    return f.correction ? `- ~~${body}~~ → ${capText(f.correction, FINDING_CAP)}` : `- ~~${body}~~`
  }
  return f.pinned ? `- 📌 ${body}` : `- ${body}`
}

/** Render one session ruled-out line. */
function renderRuledOut(n: { text: string; correction?: string }): string {
  const body = capText(n.text, FINDING_CAP)
  return n.correction ? `- ~~${body}~~ → ${capText(n.correction, FINDING_CAP)}` : `- ~~${body}~~`
}

/**
 * A truncation UNIT — one renderable block plus its EVICTION PRIORITY. A higher
 * `priority` number is dropped FIRST when the payload exceeds the cap; `pinned`
 * (priority 0) is never dropped. The builder renders all units, then drops the
 * highest-priority units one at a time until the rendered whole fits.
 *
 * Priority ladder (design doc §B.3, value not recency):
 *   0 pinned workspace findings           — NEVER evicted
 *   1 workspace instructions
 *   2 session summary
 *   3 active workspace findings (oldest first — foundational findings survive)
 *   4 session active notes (newest first)
 *   5 session ruled-out
 *   6 workspace ruled-out (least valuable — last)
 */
interface Unit {
  priority: number
  line: string
}

/**
 * Build the auto-loaded context markdown for a fresh session, OR the short resume
 * pointer. Pure over the fetched input. Stays under `maxBytes` (default 8 KB) by
 * value-ordered eviction — pinned findings are never dropped. Renders an omission
 * marker when anything was dropped, signalling a `get_session_context` call.
 *
 * Returns "" when there is nothing to inject (empty workspace + session) on a fresh
 * spawn, so the caller can skip writing a file / adding the flag entirely.
 */
export function buildInjectedContext(input: InjectContextInput, opts: BuildOptions = {}): string {
  if (opts.resume) return RESUME_POINTER

  const maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_INJECT_MAX_BYTES

  const header =
    "# Context for this session\n" +
    "> Auto-loaded by Mission Control. Launch snapshot — call get_session_context for the live view."

  // ── assemble the priority-tagged units ────────────────────────────────────────
  const units: Unit[] = []

  // (1) workspace standing instructions
  const instructions = input.instructions.trim()
  if (instructions) {
    units.push({
      priority: 1,
      line: `## Workspace standing instructions\n${capText(instructions, INSTRUCTIONS_CAP)}`,
    })
  }

  // Workspace findings split by pin/status. Active findings keep OLDEST first
  // (foundational findings are often the load-bearing HARD RULES).
  const wsActive = input.workspaceFindings
    .filter((f) => f.status === "active")
    .sort((a, b) => a.createdAt - b.createdAt)
  const wsPinned = wsActive.filter((f) => f.pinned)
  const wsUnpinned = wsActive.filter((f) => !f.pinned)
  const wsRuledOut = input.workspaceFindings.filter((f) => f.status === "ruled-out")

  // (0) pinned workspace findings — never evicted.
  for (const f of wsPinned) units.push({ priority: 0, line: renderWorkspaceFinding(f) })
  // (3) active workspace findings (oldest first).
  for (const f of wsUnpinned) units.push({ priority: 3, line: renderWorkspaceFinding(f) })
  // (6) ruled-out workspace findings — least valuable, dropped first.
  for (const f of wsRuledOut) units.push({ priority: 6, line: renderWorkspaceFinding(f) })

  // (2) session summary
  const session = input.session
  if (session?.summary.trim()) {
    units.push({ priority: 2, line: `__SESSION_SUMMARY__\n${capText(session.summary, INSTRUCTIONS_CAP)}` })
  }
  // (4) session active notes (newest first — most recent reasoning).
  if (session) {
    for (const n of [...session.active].reverse()) {
      units.push({ priority: 4, line: `- ${capText(n.text, FINDING_CAP)}` })
    }
    // (5) session ruled-out
    for (const n of session.ruledOut) {
      units.push({ priority: 5, line: renderRuledOut(n) })
    }
  }

  // Nothing durable at all → no payload (skip the file/flag).
  if (units.length === 0) return ""

  // ── value-ordered eviction until the rendered whole fits ──────────────────────
  // Keep is stable in build order; we only DROP, never reorder, so render order stays
  // logical. Drop the single highest-priority (least valuable) kept unit each pass.
  const kept = new Set<number>(units.map((_, i) => i))
  let omitted = 0
  // A guard so the function always terminates even in a degenerate case.
  for (let guard = 0; guard <= units.length; guard++) {
    const rendered = render(units, kept, omitted, session, header)
    if (byteLength(rendered) <= maxBytes) return rendered
    // Find the highest-priority (largest number) DROPPABLE (priority > 0) kept unit;
    // among equal priority, drop the LAST kept index (oldest-first survives for active
    // findings; newest-first survives for session notes — both already encoded by build
    // order, so "last kept" is the lowest-value within the tier).
    let victim = -1
    let victimPriority = -1
    for (const i of kept) {
      if (units[i].priority === 0) continue
      if (units[i].priority >= victimPriority) {
        victimPriority = units[i].priority
        victim = i
      }
    }
    if (victim === -1) {
      // Only pinned units remain and they STILL overflow — emit them anyway (a pinned
      // finding is never silently dropped; the cap is a soft guarantee against the
      // un-pinned firehose, honest about the rare all-pinned overflow).
      return render(units, kept, omitted, session, header)
    }
    kept.delete(victim)
    omitted++
  }
  return render(units, kept, omitted, session, header)
}

/**
 * Render the kept units into the two-tier markdown shape (design doc §B.1). Section
 * headers are emitted only when the tier has at least one kept unit. The synthetic
 * `__SESSION_SUMMARY__` sentinel marks the summary line so it renders under the
 * session's `### Summary` sub-header.
 */
function render(
  units: Unit[],
  kept: Set<number>,
  omitted: number,
  session: InjectSessionTier | undefined,
  header: string,
): string {
  const parts: string[] = [header]

  // Workspace tier: instructions (priority 1) + findings (0/3/6).
  const instr = units.find((u, i) => kept.has(i) && u.priority === 1)
  if (instr) parts.push(instr.line)

  const wsFindingLines = units
    .map((u, i) => ({ u, i }))
    .filter(({ u, i }) => kept.has(i) && (u.priority === 0 || u.priority === 3 || u.priority === 6))
    .map(({ u }) => u.line)
  if (wsFindingLines.length) {
    parts.push(`## Durable workspace findings\n${wsFindingLines.join("\n")}`)
  }

  // Session tier.
  if (session) {
    const summary = units.find((u, i) => kept.has(i) && u.priority === 2)
    const activeLines = units
      .map((u, i) => ({ u, i }))
      .filter(({ u, i }) => kept.has(i) && u.priority === 4)
      .map(({ u }) => u.line)
    const ruledLines = units
      .map((u, i) => ({ u, i }))
      .filter(({ u, i }) => kept.has(i) && u.priority === 5)
      .map(({ u }) => u.line)

    if (summary || activeLines.length || ruledLines.length) {
      const sessionParts: string[] = [`## This session: ${session.name}`]
      if (summary) sessionParts.push(`### Summary\n${summary.line.replace(/^__SESSION_SUMMARY__\n/, "")}`)
      if (activeLines.length) sessionParts.push(`### Findings\n${activeLines.join("\n")}`)
      if (ruledLines.length) sessionParts.push(`### Ruled out / corrected\n${ruledLines.join("\n")}`)
      parts.push(sessionParts.join("\n\n"))
    }
  }

  if (omitted > 0) {
    parts.push(
      `_(${omitted} older finding${omitted === 1 ? "" : "s"} omitted — call get_session_context to see all)_`,
    )
  }

  return parts.join("\n\n")
}
