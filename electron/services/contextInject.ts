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
  // CAPP-97 — the SOURCE identity of this unit, carried so the launch stamp can be built
  // from ONLY the units that survived eviction (were actually injected). A finding evicted
  // under the cap therefore stays "new/updated" in the later delta and is never lost.
  wsSig?: string
  sessionSig?: string
  kind?: "instructions" | "summary"
}

interface InjectPlan {
  units: Unit[]
  /** Indices of `units` that survived eviction (were rendered into the payload). */
  kept: Set<number>
  omitted: number
  session?: InjectSessionTier
  header: string
}

/**
 * Assemble the priority-tagged units and run value-ordered eviction until the rendered
 * whole fits `maxBytes`. Returns `null` when there is nothing durable to inject. SHARED by
 * the renderer ({@link buildInjectedContext}) AND the launch stamp ({@link
 * computeContextStamp}) so the stamp reflects EXACTLY the findings that were injected — not
 * the uncapped input (which would silently drop evicted findings from the later delta).
 */
function planInject(input: InjectContextInput, opts: BuildOptions = {}): InjectPlan | null {
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
      kind: "instructions",
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
  for (const f of wsPinned) units.push({ priority: 0, line: renderWorkspaceFinding(f), wsSig: signWorkspaceFinding(f) })
  // (3) active workspace findings (oldest first).
  for (const f of wsUnpinned) units.push({ priority: 3, line: renderWorkspaceFinding(f), wsSig: signWorkspaceFinding(f) })
  // (6) ruled-out workspace findings — least valuable, dropped first.
  for (const f of wsRuledOut) units.push({ priority: 6, line: renderWorkspaceFinding(f), wsSig: signWorkspaceFinding(f) })

  // (2) session summary
  const session = input.session
  if (session?.summary.trim()) {
    units.push({ priority: 2, line: `__SESSION_SUMMARY__\n${capText(session.summary, INSTRUCTIONS_CAP)}`, kind: "summary" })
  }
  // (4) session active notes (newest first — most recent reasoning).
  if (session) {
    for (const n of [...session.active].reverse()) {
      units.push({ priority: 4, line: `- ${capText(n.text, FINDING_CAP)}`, sessionSig: signSessionActive(n) })
    }
    // (5) session ruled-out
    for (const n of session.ruledOut) {
      units.push({ priority: 5, line: renderRuledOut(n), sessionSig: signSessionRuledOut(n) })
    }
  }

  // Nothing durable at all → no plan (caller skips the file/flag + records no stamp).
  if (units.length === 0) return null

  // ── value-ordered eviction until the rendered whole fits ──────────────────────
  // Keep is stable in build order; we only DROP, never reorder, so render order stays
  // logical. Drop the single highest-priority (least valuable) kept unit each pass.
  const kept = new Set<number>(units.map((_, i) => i))
  let omitted = 0
  // A guard so the loop always terminates even in a degenerate case.
  for (let guard = 0; guard <= units.length; guard++) {
    if (byteLength(render(units, kept, omitted, session, header)) <= maxBytes) break
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
    // victim === -1: only pinned units remain and they STILL overflow — emit them anyway
    // (a pinned finding is never silently dropped; the cap is a soft guarantee against the
    // un-pinned firehose, honest about the rare all-pinned overflow).
    if (victim === -1) break
    kept.delete(victim)
    omitted++
  }
  return { units, kept, omitted, session, header }
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
  const plan = planInject(input, opts)
  if (!plan) return ""
  return render(plan.units, plan.kept, plan.omitted, plan.session, plan.header)
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

// ── CAPP-99 / E1 — the SHARED workspace-tier body (anti-drift) ──────────────────────

/**
 * Order the workspace findings the ONE canonical way both the inject and the export use:
 * pinned active first, then the remaining active (OLDEST first — foundational findings are
 * the load-bearing rules), then ruled-out last. EXTRACTED so the inject's `planInject`
 * priority ladder and the export's {@link buildWorkspacePrimerBody} can never disagree on
 * which findings appear in what order — the §B keystone "one shared finding set".
 */
export function orderWorkspaceFindings(
  findings: InjectWorkspaceFinding[],
): InjectWorkspaceFinding[] {
  const active = findings
    .filter((f) => f.status === "active")
    .sort((a, b) => a.createdAt - b.createdAt)
  const pinned = active.filter((f) => f.pinned)
  const unpinned = active.filter((f) => !f.pinned)
  const ruledOut = findings.filter((f) => f.status === "ruled-out")
  return [...pinned, ...unpinned, ...ruledOut]
}

/**
 * CAPP-99 / E1 — the SHARED workspace-tier body builder. Produces ONLY the workspace-tier
 * markdown (standing instructions + durable findings, pinned-first/active/ruled-out), with
 * NO header — the caller wraps it (the inject wraps it in the launch header; the export
 * wraps it in the §B.1 identity-marker header). The keystone of the export design's
 * anti-drift requirement: the inject (via {@link planInject}) and the exporter feed off the
 * SAME finding set ({@link orderWorkspaceFindings}) and the SAME renderers
 * ({@link renderWorkspaceFinding}), so a `claude` reading the exported file and a `claude`
 * reading the inject can never see a different workspace brain.
 *
 * Unlike the inject, the export is NOT byte-capped (a portable file the user owns has no
 * token budget) — it materializes the FULL workspace tier. Returns "" when there is nothing
 * durable (no instructions + no findings), so the exporter can decide whether to write.
 */
export function buildWorkspacePrimerBody(input: {
  instructions: string
  workspaceFindings: InjectWorkspaceFinding[]
}): string {
  const parts: string[] = []

  const instructions = input.instructions.trim()
  parts.push(`## Standing instructions\n${instructions || "_(none)_"}`)

  const ordered = orderWorkspaceFindings(input.workspaceFindings)
  if (ordered.length) {
    parts.push(
      `## Durable findings\n${ordered.map(renderWorkspaceFinding).join("\n")}`,
    )
  } else {
    parts.push("## Durable findings\n_(none)_")
  }

  // Nothing durable at all → empty, so the exporter can skip the write.
  if (!instructions && ordered.length === 0) return ""

  return parts.join("\n\n")
}

/** One recall workspace-memory entry as the inject mapping reads it (status carried so a
 *  ruled-out finding renders struck; `pinned` flows through so truncation honors it). */
export interface InjectSourceEntry {
  text: string
  status: "active" | "ruled-out" | "summary"
  correction?: string
  createdAt: number
  pinned?: boolean
}

/** The live-service reads `buildSessionInject` needs, INJECTED by the wiring layer so the
 *  assembly logic is unit-testable (one helper, called by both ipc.ts AND the wiring test,
 *  not re-implemented in each). */
export interface SessionInjectDeps {
  /** The spawning session's OWN workspace — NEVER the active selection. */
  workspaceIdOf: (sessionId: string) => string | undefined
  /** The workspace's durable standing instructions. */
  getInstructions: (workspaceId: string | null) => string
  /** The recall union @ scope:'workspace' (the durable memory tier) for a workspace. */
  workspaceTierEntries: (workspaceId: string | undefined) => InjectSourceEntry[]
  /** The spawning session's own context sections. */
  getSessionSections: (sessionId: string) => InjectSessionTier | undefined
}

/**
 * Assemble the session inject from the live services — the EXACT logic the spawn wiring
 * uses, extracted so it is unit-testable rather than re-implemented in ipc.ts and the
 * test (which had drifted). Scoped off the SPAWNING session's own workspace
 * (`deps.workspaceIdOf`), NEVER the active selection. A resume spawn → the short pointer;
 * a bare spawn (no sessionId) → "".
 */
export function buildSessionInject(
  sessionId: string | undefined,
  opts: { resume: boolean; maxBytes?: number },
  deps: SessionInjectDeps,
): string {
  return buildSessionInjectWithStamp(sessionId, opts, deps).payload
}

/**
 * CAPP-97 — the spawn-wiring primitive: the inject `payload` AND the launch `stamp` to
 * record, computed together from ONE assembly so they can never disagree. The single
 * tested source of three load-bearing rules:
 *   • RESUME spawn → only the short pointer, NO stamp (nothing to diff against).
 *   • EMPTY brain → "" payload, NO stamp (so a later get_session_context returns the FULL
 *     primer, never a false "no durable changes" over a spawn that loaded nothing).
 *   • a finding EVICTED under `maxBytes` → absent from the stamp (it was never injected), so
 *     the later delta surfaces it rather than swallowing it.
 * The caller records `stamp` (when present) keyed by the spawning terminal's id.
 */
export function buildSessionInjectWithStamp(
  sessionId: string | undefined,
  opts: { resume: boolean; maxBytes?: number },
  deps: SessionInjectDeps,
): { payload: string; stamp?: ContextStamp } {
  if (opts.resume) {
    return { payload: buildInjectedContext({ instructions: "", workspaceFindings: [] }, { resume: true }) }
  }
  const input = assembleInjectInput(sessionId, deps)
  if (!input) return { payload: "" }
  const payload = buildInjectedContext(input, { resume: false, maxBytes: opts.maxBytes })
  if (!payload) return { payload: "" }
  return { payload, stamp: computeContextStamp(input, { maxBytes: opts.maxBytes }) }
}

/**
 * CAPP-97 — assemble the structured {@link InjectContextInput} for a fresh spawn from
 * the live-service deps, extracted so BOTH the inject payload ({@link buildSessionInject})
 * AND the launch STAMP ({@link computeContextStamp}) read the EXACT same source. Returns
 * `undefined` when there's no sessionId (a bare spawn injects nothing → no stamp). This is
 * the single assembly point so the delta can never compare against a differently-shaped
 * snapshot than what was injected.
 */
export function assembleInjectInput(
  sessionId: string | undefined,
  deps: SessionInjectDeps,
): InjectContextInput | undefined {
  if (!sessionId) return undefined
  const workspaceId = deps.workspaceIdOf(sessionId)
  const workspaceFindings: InjectWorkspaceFinding[] = deps.workspaceTierEntries(workspaceId).map((e) => ({
    text: e.text,
    status: e.status === "ruled-out" ? "ruled-out" : "active",
    ...(e.correction ? { correction: e.correction } : {}),
    createdAt: e.createdAt,
    ...(e.pinned ? { pinned: true } : {}),
  }))
  return {
    instructions: deps.getInstructions(workspaceId ?? null),
    workspaceFindings,
    session: deps.getSessionSections(sessionId),
  }
}

// ── CAPP-97 — get_session_context DELTA vs the launch snapshot ──────────────────────

/**
 * A launch-snapshot STAMP for one terminal: enough to compute, on a later
 * `get_session_context`, ONLY what changed since the curated brain was auto-loaded at
 * spawn — so the pull doesn't re-load the same bytes the inject already pushed.
 *
 * It is the set of finding SIGNATURES that went in (a signature folds text + status +
 * correction, so an EDIT or a RULE-OUT both register as a change), plus the
 * instructions + summary strings (compared whole). Persisted per-terminal (keyed by the
 * SAME terminalId the inject wrote `<tid>.md` under) for the life of the terminal. A
 * terminal with NO stamp (xterm legacy, inject disabled, resume pointer, pre-existing
 * session) is the default-safe branch — `get_session_context` returns the FULL primer.
 */
export interface ContextStamp {
  /** The workspace standing instructions at launch (compared whole). */
  instructions: string
  /** The session summary at launch (compared whole). "" when there was no session tier. */
  summary: string
  /** Signatures of every workspace finding present at launch. */
  workspaceSignatures: string[]
  /** Signatures of every session finding (active + ruled-out) present at launch. */
  sessionSignatures: string[]
}

/** Fold a finding into a stable signature so text edits / status flips / correction
 *  changes all read as "changed". Newline-delimited fields (findings never contain a
 *  raw NUL, and text is trimmed) keep the parts unambiguous. */
function signWorkspaceFinding(f: InjectWorkspaceFinding): string {
  return `${f.status} ${f.text.trim()} ${(f.correction ?? "").trim()}`
}
function signSessionActive(n: { text: string }): string {
  return `active ${n.text.trim()} `
}
function signSessionRuledOut(n: { text: string; correction?: string }): string {
  return `ruled-out ${n.text.trim()} ${(n.correction ?? "").trim()}`
}

/**
 * Compute the launch stamp from the SAME assembled input the inject rendered — and,
 * crucially, ONLY from the units that SURVIVED eviction under `opts.maxBytes` (what was
 * actually injected). A finding dropped by the cap at spawn is therefore absent from the
 * stamp, so the later {@link buildContextDelta} surfaces it as "new/updated" rather than
 * silently swallowing it. An empty plan (nothing durable) yields an empty stamp.
 */
export function computeContextStamp(input: InjectContextInput, opts: BuildOptions = {}): ContextStamp {
  const plan = planInject(input, opts)
  if (!plan) return { instructions: "", summary: "", workspaceSignatures: [], sessionSignatures: [] }
  const keptUnits = [...plan.kept].map((i) => plan.units[i])
  return {
    instructions: keptUnits.some((u) => u.kind === "instructions") ? input.instructions.trim() : "",
    summary: keptUnits.some((u) => u.kind === "summary") ? (input.session?.summary.trim() ?? "") : "",
    workspaceSignatures: keptUnits.flatMap((u) => (u.wsSig ? [u.wsSig] : [])),
    sessionSignatures: keptUnits.flatMap((u) => (u.sessionSig ? [u.sessionSig] : [])),
  }
}

/** The stable header returned when nothing durable changed since launch. */
export const NO_DELTA_HEADER =
  "# Context for this session\n" +
  "> No durable changes since launch — the curated context was auto-loaded at spawn."

/**
 * Render the DELTA between the CURRENT assembled context and the launch `stamp`: only
 * new/edited workspace + session findings (a changed signature), ruled-out findings that
 * weren't ruled-out at launch (their changed signature already counts as new), and the
 * summary/instructions ONLY when they changed. When nothing changed, returns
 * {@link NO_DELTA_HEADER}. Reuses the inject renderers ({@link renderWorkspaceFinding} /
 * {@link renderRuledOut}) so a finding reads identically in the delta and the launch payload.
 *
 * Pure over (current input, stamp) — the wiring layer fetches the current input from the
 * same deps and looks up the stamp by terminalId.
 */
export function buildContextDelta(input: InjectContextInput, stamp: ContextStamp): string {
  const launchWs = new Set(stamp.workspaceSignatures)
  const launchSession = new Set(stamp.sessionSignatures)

  const parts: string[] = [
    "# Context updates since launch\n" +
      "> The curated context below was auto-loaded at spawn — only what CHANGED since is shown here.",
  ]

  // Instructions — show only when the whole string changed.
  const instructions = input.instructions.trim()
  if (instructions && instructions !== stamp.instructions) {
    parts.push(`## Workspace standing instructions (changed)\n${capText(instructions, INSTRUCTIONS_CAP)}`)
  }

  // Workspace findings new/edited since launch (signature not in the launch set).
  const wsNew = input.workspaceFindings.filter((f) => !launchWs.has(signWorkspaceFinding(f)))
  if (wsNew.length) {
    parts.push(`## Durable workspace findings (new/updated)\n${wsNew.map(renderWorkspaceFinding).join("\n")}`)
  }

  // Session tier — summary changed + new/edited findings.
  const session = input.session
  const sessionParts: string[] = []
  if (session) {
    const summary = session.summary.trim()
    if (summary && summary !== stamp.summary) {
      sessionParts.push(`### Summary (changed)\n${capText(summary, INSTRUCTIONS_CAP)}`)
    }
    const activeNew = session.active.filter((n) => !launchSession.has(signSessionActive(n)))
    if (activeNew.length) {
      sessionParts.push(`### Findings (new/updated)\n${activeNew.map((n) => `- ${capText(n.text, FINDING_CAP)}`).join("\n")}`)
    }
    const ruledNew = session.ruledOut.filter((n) => !launchSession.has(signSessionRuledOut(n)))
    if (ruledNew.length) {
      sessionParts.push(`### Ruled out / corrected (new/updated)\n${ruledNew.map(renderRuledOut).join("\n")}`)
    }
  }
  if (sessionParts.length) {
    parts.push([`## This session: ${session!.name}`, ...sessionParts].join("\n\n"))
  }

  // Nothing changed → the stable "no changes" header (so the agent doesn't re-load bytes).
  if (parts.length === 1) return NO_DELTA_HEADER
  return parts.join("\n\n")
}
