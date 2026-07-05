/**
 * BO-2 — the PURE render-model reducer for a headless Claude session's
 * structured stream. Side-effect-free fold of an ordered `StreamEvent[]` (the
 * BO-1 transport's output) into render BLOCKS the AgentView renders. Zero React
 * / Electron imports — this is the unit-test seam (cf. src/lib/sessionRow.ts →
 * Sidebar).
 *
 * Responsibilities (each acceptance-bearing):
 *  - coalesce consecutive `assistant_delta` into one growing text block, with a
 *    STABLE block id, so streaming never re-flashes settled text;
 *  - correlate a `tool_use` with its later `tool_result` (by tool-call id) into
 *    ONE tool block whose status flips running → done/error;
 *  - emit distinct `thinking`, `error`, and turn-complete `result` blocks;
 *  - surface a `result`'s token / cost / duration off its raw payload;
 *  - turn any unrecognized / `unknown` variant (or an orphan tool_result) into a
 *    benign `raw` block. NEVER throw.
 *
 * The `StreamEvent` type is IMPORTED from the canonical BO-1 contract — never
 * redefined. It's a type-only import (erased at build), so this stays free of
 * any Electron/node runtime dependency.
 */

import type { StreamEvent } from "../../electron/services/streamProtocol"

export type ToolStatus = "running" | "done" | "error"

export interface AssistantTextBlock {
  kind: "assistant"
  id: string
  text: string
}

/** BO-4b — the user's own message in the conversation (from a `user_message` event). */
export interface UserBlock {
  kind: "user"
  id: string
  text: string
}

/** The discriminant for {@link UserBlock} — the one block kind that's the user's own
 *  message. Exported so consumers (e.g. the dead-air working-row decision in AgentView)
 *  can identify the pre-content gap without hardcoding the literal. */
export const USER_BLOCK_KIND: UserBlock["kind"] = "user"

export interface ThinkingBlock {
  kind: "thinking"
  id: string
  text: string
}

export interface ToolBlock {
  kind: "tool"
  /** React key (stable, creation-ordered). */
  id: string
  /** The tool-call id used to correlate the later tool_result. */
  toolUseId: string
  name: string
  input: unknown
  result?: unknown
  isError?: boolean
  status: ToolStatus
}

export interface ErrorBlock {
  kind: "error"
  id: string
  message: string
}

/** Token / cost / duration extracted off a `result` event's raw payload. */
export interface ResultCost {
  /**
   * This turn's OWN cost in USD (the per-turn DELTA).
   *
   * CAPP-125: the raw `result.total_cost_usd` is CUMULATIVE per process (live-proven in
   * resultCostSemantics.fixtures.ts — turn2 carries turn1 + turn2), so summing it across
   * turns triangular-overcounts. {@link extractCost} still returns the RAW cumulative in
   * this field; {@link toPerTurnCost} (applied where result blocks fold — reduceTranscript
   * + useAgentCost) converts it to the per-turn delta so the rail's {@link sumCost} is a
   * plain, correct sum and the inline CostChip shows this turn alone.
   */
  costUsd?: number
  /**
   * CAPP-125: the RAW cumulative `total_cost_usd` at this turn (undefined when none was
   * reported). Retained on the folded block so the NEXT turn can delta off it without
   * threading state, and so a fresh-process reset (current < previous) is detectable.
   */
  cumulativeCostUsd?: number
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  /** Cache-write tokens (billed at a premium). */
  cacheCreationTokens?: number
  /** Cache-read tokens (billed at a discount). */
  cacheReadTokens?: number
  /** ALL billed token classes summed: input + output + cache-creation + cache-read.
   *  Built from the TOP-LEVEL `usage` object, which is PER-TURN (CAPP-125, unlike
   *  `total_cost_usd`/`modelUsage` which are cumulative) — so this is safe to sum as-is. */
  totalTokens?: number
  /**
   * The context-WINDOW snapshot at turn end: the LAST `usage.iterations` entry's
   * input + cache-read + cache-creation (each iteration is one API request). The
   * TOP-LEVEL input-side classes SUM across every request in the turn — a tool-heavy
   * turn on a 200k window can report >1M billed input-side tokens — so they measure
   * BURN, not window fullness; the context meter must read THIS field. Undefined when
   * the payload carries no iterations (older claude versions) — callers fall back to
   * the summed classes.
   */
  contextTokens?: number
  numTurns?: number
}

export interface ResultBlock {
  kind: "result"
  id: string
  isError: boolean
  subtype?: string
  /** Final assistant text for the turn, when present. */
  text?: string
  cost?: ResultCost
}

export interface RawBlock {
  kind: "raw"
  id: string
  raw: unknown
}

/**
 * CAPP-118 — harness-injected user-role content, rendered as a compact system CHIP
 * instead of a giant user bubble. Claude Code injects background-task notices
 * (`<task-notification>`), `<system-reminder>` blocks, and local-command echoes
 * (`<command-name>`/`<command-message>`/`<command-args>`,
 * `<local-command-stdout>`/`<local-command-stderr>`, the `<local-command-caveat>`
 * wrapper) into a conversation as USER-role turns. The stream-json carries them as
 * `user` events, so without this classification they render as user-authored
 * bubbles (worst on `--resume` replay). The chip is muted + one-line; its raw text
 * stays inspectable behind the expand button (see {@link classifyInjectedUserContent}).
 */
export interface InjectedBlock {
  kind: "injected"
  id: string
  /** The wrapper family — drives the chip glyph/label + is a stable test seam. */
  wrapper: InjectedWrapper
  /** A human one-line label (no glyph), e.g. `background task — <summary>`. */
  label: string
  /** The RAW wrapper text, verbatim — opened byte-for-byte in the read-only code
   *  panel (never markdown-interpreted; review finding 2), never lost. */
  raw: string
}

/**
 * CAPP-39 gate ② — a turn that failed because the user isn't signed in to Claude.
 * Folded from a `needs_auth` StreamEvent (synthesized by the transport on
 * exit-before-init OR parsed from the post-init "Not logged in" failure shape).
 * Rendered as a DISTINCT, ACTIONABLE block — a "You're not signed in" message + a
 * "Sign in" button that launches an interactive `claude /login` — NOT the bare red
 * ErrorBlock (which read as a confusing dead turn).
 */
export interface NeedsAuthBlock {
  kind: "needs_auth"
  id: string
  /** The underlying message (the agent's "Not logged in" prose), kept for detail. */
  message: string
}

/**
 * BO-6 — a turn that failed because its `--model` is unavailable (Anthropic
 * disabled it, or the user lacks access; surfaces as a `result` with
 * `is_error:true` + an api_error_status 404 model message). Rendered as a DISTINCT
 * inline banner wired to the model picker ("Model X is unavailable — pick
 * another"), NOT the bare "Turn failed" of a generic error result — so the next
 * disablement is self-service instead of a dead session.
 */
export interface ModelErrorBlock {
  kind: "model_error"
  id: string
  /** The raw error message from the result (best-effort). */
  message: string
  /** The offending model name, when it could be parsed out of the message. */
  model?: string
}

export type TranscriptBlock =
  | UserBlock
  | AssistantTextBlock
  | ThinkingBlock
  | ToolBlock
  | ErrorBlock
  | ResultBlock
  | ModelErrorBlock
  | NeedsAuthBlock
  | InjectedBlock
  | RawBlock

/**
 * The reducer's accumulated state. `seq` is a monotonic counter that mints
 * stable, creation-ordered block ids (`b0`, `b1`, …). Because the event stream
 * is append-only, folding the same prefix always yields the same ids — so a
 * re-fold (or an incremental reduce) keeps React keys stable and settled blocks
 * are never remounted.
 */
export interface TranscriptState {
  blocks: TranscriptBlock[]
  seq: number
}

export function emptyTranscript(): TranscriptState {
  return { blocks: [], seq: 0 }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/**
 * CAPP-39 gate ② — the failure prose an UNAUTHENTICATED `claude -p` puts in the
 * trailing `result.result` field ("Not logged in · Please run /login", "Invalid
 * API key …"). Kept narrow ON PURPOSE and used ONLY to COALESCE that trailing
 * is_error result into an ALREADY-RAISED needs_auth banner (so the live failure —
 * which emits the `authentication_failed` assistant FIRST, then this result —
 * shows ONE Sign-in banner, not banner + a stray "Turn failed"). It is NEVER a
 * standalone trigger: a healthy authenticated turn that errors for a NON-auth
 * reason but happens to mention these phrases (the model debugging a 401, a
 * failing auth test, a `gh` CLI message) has NO preceding needs_auth banner, so it
 * renders as its real result/model_error block.
 */
const AUTH_RESULT_TEXT_RE = /not logged in|please run \/login|invalid api key/i

/** The text of the most recent assistant block, or undefined if none yet. */
function lastAssistantText(blocks: TranscriptBlock[]): string | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.kind === "assistant") return b.text
  }
  return undefined
}

/** Pull token / cost / duration off a `result` event's raw payload (best-effort).
 *  Exported so the Agent Rail's per-terminal cost accumulator (useAgentCost) folds
 *  the EXACT same ResultCost the transcript reducer does — no divergent token math.
 *
 *  CAPP-125: the `costUsd` returned here is the RAW `total_cost_usd`, which is
 *  CUMULATIVE per process (see the fixtures). Callers that SUM across turns MUST first
 *  run it through {@link toPerTurnCost} (the two fold sites do). The `totalTokens` here
 *  is per-turn (top-level `usage`) and is safe to sum directly. */
export function extractCost(raw: unknown): ResultCost {
  const r = isObj(raw) ? raw : {}
  const usage = isObj(r.usage) ? r.usage : {}
  const inputTokens = num(usage.input_tokens)
  const outputTokens = num(usage.output_tokens)
  const cacheCreationTokens = num(usage.cache_creation_input_tokens)
  const cacheReadTokens = num(usage.cache_read_input_tokens)
  // Total = ALL billed token classes, not just input+output. Cache tokens are
  // billed (creation at a premium, reads at a discount) and on a cached turn dwarf
  // the raw input_tokens — so a total that omits them badly under-reports the
  // turn's real token spend (the surface the user reads as automation-credit burn).
  const tokenClasses = [inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens]
  const totalTokens = tokenClasses.some((t) => t != null)
    ? tokenClasses.reduce<number>((sum, t) => sum + (t ?? 0), 0)
    : undefined
  // Window snapshot = the LAST iteration's input-side classes (one iteration per API
  // request; the top-level classes are their SUM — burn, not fullness). Absent or
  // malformed iterations → undefined so callers fall back.
  let contextTokens: number | undefined
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : []
  const last = iterations.length > 0 ? iterations[iterations.length - 1] : undefined
  if (isObj(last)) {
    const parts = [
      num(last.input_tokens),
      num(last.cache_read_input_tokens),
      num(last.cache_creation_input_tokens),
    ]
    if (parts.some((t) => t != null)) {
      contextTokens = parts.reduce<number>((sum, t) => sum + (t ?? 0), 0)
    }
  }
  return {
    costUsd: num(r.total_cost_usd),
    durationMs: num(r.duration_ms),
    numTurns: num(r.num_turns),
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens,
    contextTokens,
  }
}

/**
 * CAPP-125 — convert a freshly-{@link extractCost}ed (RAW cumulative) ResultCost into a
 * PER-TURN one, given the previous turn's raw cumulative (0 when this is the first).
 * `total_cost_usd` is cumulative per process (live-proven — resultCostSemantics.fixtures),
 * so this turn's own spend is `current − previous`. A fresh-process RESET (a `--resume`
 * or respawn re-baselines the counter, so `current < previous`) is detected and the turn
 * contributes its own `current` (previous treated as 0) — never a negative delta.
 *
 * `cumulativeCostUsd` is stamped with the raw cumulative so the NEXT turn deltas off it
 * with no threaded state (see {@link lastCumulativeCostUsd}). A turn that reported NO cost
 * is passed through unchanged (costUsd + cumulativeCostUsd stay undefined). Only `costUsd`
 * is rewritten — the per-turn `totalTokens` and the rest are untouched. Pure.
 */
export function toPerTurnCost(raw: ResultCost, prevCumulativeUsd: number): ResultCost {
  const cumulative = raw.costUsd
  if (cumulative == null) return raw
  const perTurn = cumulative >= prevCumulativeUsd ? cumulative - prevCumulativeUsd : cumulative
  return { ...raw, costUsd: perTurn, cumulativeCostUsd: cumulative }
}

/**
 * CAPP-125 — the raw cumulative cost carried by the most recent result block that
 * reported one, or 0 when none has yet. This is the `prevCumulativeUsd` baseline
 * {@link toPerTurnCost} deltas the next turn against — recovered by scanning the ordered
 * blocks so neither fold site (reduceTranscript, useAgentCost) has to thread state.
 */
export function lastCumulativeCostUsd(blocks: readonly TranscriptBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.kind === "result" && b.cost?.cumulativeCostUsd != null) return b.cost.cumulativeCostUsd
  }
  return 0
}

/**
 * BO-6 — detect a model-unavailability failure off a `result` event, returning the
 * banner message + (best-effort) the offending model name, or null when it isn't
 * one. Triggers on an ERRORED result whose text both names a model AND reads as
 * unavailable ("may not exist", "may not have access", "issue with the selected
 * model", "unavailable", …) — OR an errored result carrying a 404 api status
 * alongside a model mention (the api_error_status the disablement reports). Pure +
 * tolerant: any shape miss returns null, so a generic error result is unaffected
 * (it still renders the normal "Turn failed" result block).
 */
export function modelErrorFromResult(
  event: StreamEvent,
): { message: string; model?: string } | null {
  if (event.kind !== "result" || !event.isError) return null
  const raw = isObj(event.raw) ? event.raw : {}
  const err = isObj(raw.error) ? raw.error : {}
  const text = [str(event.result), str(raw.result), str(raw.message), str(err.message)]
    .filter((s): s is string => !!s)
    .join(" ")
    .trim()
  if (!text || !/\bmodel\b/i.test(text)) return null
  const status =
    num(raw.api_error_status) ?? num((raw as Record<string, unknown>).status) ?? num(err.status)
  const unavailable =
    /may not exist|may not have access|do(?:es)? ?n[o']t have access|unavailable|issue with the selected|not found|no access/i.test(
      text,
    )
  if (!unavailable && status !== 404) return null
  // Pull the model name out of a "(claude-…)" parenthetical when present.
  const m = text.match(/\(([^()]*?(?:claude|fable|opus|sonnet|haiku)[^()]*?)\)/i)
  return { message: text, model: m ? m[1].trim() : undefined }
}

// ---------------------------------------------------------------------------
// CAPP-118 — classify a user_message's text into ordered segments: genuine user
// prose stays a user bubble; each harness-injected wrapper becomes a system chip.
//
// SAFETY (the negative controls): a wrapper is injected-content ONLY when its
// opening tag sits at a segment boundary (start-of-message or start-of-line, after
// optional leading whitespace) AND has a matching closing tag. A tag merely
// MENTIONED mid-sentence — or an unterminated tag the user quoted — is never
// reclassified; it stays user prose. A message with NO well-formed injected wrapper
// is returned byte-for-byte as one user segment (the overwhelming common case).
// ---------------------------------------------------------------------------

/** The injected-wrapper families we render as chips (the discriminant + test seam). */
export type InjectedWrapper = "task-notification" | "system-reminder" | "local-command"

// CAPP-118 review (finding 1) — the classifier runs SYNCHRONOUSLY inside
// reduceTranscript (including full-history replay on rehydration/restart/handoff),
// so its WORST case must be bounded, not just its common case fast. Unbounded, K
// unterminated wrapper-open lines each scanning to end-of-string is O(K·n): a ~1MB
// pasted message of `<system-reminder>`-prefixed lines froze the renderer. Two caps:
/** Bound (a): messages longer than this skip classification entirely → one plain
 *  user segment. Real injected wrappers are small; a message this size is a paste,
 *  not a harness turn — mis-rendering it as a bubble is the safe direction. */
export const INJECTED_CLASSIFY_MAX_CHARS = 131_072
/** Bound (b): the max chars past an opening tag that {@link closeTagEnd} scans for
 *  its close. No close within the window = treated as unterminated = plain user
 *  text (default-safe: injected→bubble is cosmetic; the reverse eats real prose). */
export const INJECTED_CLOSE_SCAN_WINDOW = 65_536

/** An injected wrapper block extracted from a user_message. */
export interface InjectedSegment {
  kind: "injected"
  wrapper: InjectedWrapper
  label: string
  raw: string
}
/** A run of genuine user prose (trimmed) between/around injected wrappers. */
export interface PlainUserSegment {
  kind: "user"
  text: string
}
export type ClassifiedSegment = InjectedSegment | PlainUserSegment

/** Standalone single-block wrappers — presence at a boundary is its own chip. */
const SINGLE_WRAPPERS: { tag: string; wrapper: InjectedWrapper }[] = [
  { tag: "task-notification", wrapper: "task-notification" },
  { tag: "system-reminder", wrapper: "system-reminder" },
]
/** The local-command family — a CONSECUTIVE run of these folds into ONE chip.
 *  Covers both live shapes (review finding 3): the slash-command echo
 *  (`command-name`/`command-message`/`command-args`, with the stdout arriving later
 *  as its own `local-command-stdout` message) AND the `!`-bash echo
 *  (`bash-input` + `bash-stdout`/`bash-stderr`, which can sit adjacent on one line). */
const LOCAL_COMMAND_TAGS = [
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
]
/** Claude Code's "everything below is local-command output, do not respond" marker. */
const CAVEAT_TAG = "local-command-caveat"

function startsWithTag(text: string, pos: number, tag: string): boolean {
  return text.startsWith(`<${tag}>`, pos)
}

/** Index just past the matching `</tag>` after an open at `openPos`, or -1.
 *  BOUNDED (review finding 1): only the {@link INJECTED_CLOSE_SCAN_WINDOW} chars past
 *  the opening tag are searched — the slice caps the per-call cost regardless of
 *  message size, so K unterminated opens can never go quadratic. A close beyond the
 *  window reads as unterminated → the open stays plain user text. */
function closeTagEnd(text: string, openPos: number, tag: string): number {
  const closeTag = `</${tag}>`
  const from = openPos + tag.length + 2
  const windowEnd = Math.min(text.length, openPos + INJECTED_CLOSE_SCAN_WINDOW)
  const idx = text.slice(from, windowEnd).indexOf(closeTag)
  return idx < 0 ? -1 : from + idx + closeTag.length
}

/** The verbatim inner text of the FIRST `<tag>…</tag>` in `raw`, or undefined. */
function innerTag(raw: string, tag: string): string | undefined {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const a = raw.indexOf(open)
  if (a < 0) return undefined
  const b = raw.indexOf(close, a + open.length)
  if (b < 0) return undefined
  return raw.slice(a + open.length, b)
}

/** Collapse whitespace + cap length so a chip label never overflows its one line. */
function collapseLabel(s: string): string {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > 120 ? t.slice(0, 119) + "…" : t
}

/** The human one-line label for a resolved wrapper (no glyph — the chip adds ⚙). */
function labelForSingle(wrapper: InjectedWrapper, raw: string): string {
  if (wrapper === "system-reminder") return "system reminder"
  // task-notification: prefer its <summary>, else a generic line.
  const summary = innerTag(raw, "summary")
  const s = summary != null ? collapseLabel(summary) : ""
  return s ? `background task — ${s}` : "background task"
}
function labelForLocalCommand(raw: string): string {
  const name = innerTag(raw, "command-name")
  const n = name != null ? name.trim().replace(/^\/+/, "") : ""
  return n ? `/${n}` : "local command output"
}

/** Match an injected wrapper anchored at `p` (a boundary), or null. */
function matchWrapperAt(text: string, p: number): { end: number; seg: InjectedSegment } | null {
  // Caveat is sticky-to-end: from here on is local-command output (its own close
  // tag ends the caveat, but the command/bash echo that follows in the SAME message
  // is part of it). The label still prefers an embedded <command-name> (the real
  // caveat + /model shape) over the generic line.
  if (startsWithTag(text, p, CAVEAT_TAG)) {
    if (closeTagEnd(text, p, CAVEAT_TAG) < 0) return null // unterminated → not a wrapper
    const raw = text.slice(p)
    return { end: text.length, seg: { kind: "injected", wrapper: "local-command", label: labelForLocalCommand(raw), raw } }
  }
  for (const { tag, wrapper } of SINGLE_WRAPPERS) {
    if (startsWithTag(text, p, tag)) {
      const end = closeTagEnd(text, p, tag)
      if (end < 0) return null
      const raw = text.slice(p, end)
      return { end, seg: { kind: "injected", wrapper, label: labelForSingle(wrapper, raw), raw } }
    }
  }
  // A run of consecutive local-command-family wrappers (whitespace-separated) → ONE chip.
  if (LOCAL_COMMAND_TAGS.some((t) => startsWithTag(text, p, t))) {
    let end = -1
    let q = p
    while (q < text.length) {
      while (q < text.length && /\s/.test(text[q])) q++
      const tag = LOCAL_COMMAND_TAGS.find((t) => startsWithTag(text, q, t))
      if (!tag) break
      const e = closeTagEnd(text, q, tag)
      if (e < 0) break
      end = e
      q = e
    }
    if (end < 0) return null
    const raw = text.slice(p, end)
    return { end, seg: { kind: "injected", wrapper: "local-command", label: labelForLocalCommand(raw), raw } }
  }
  return null
}

/** The next injected wrapper at/after `from` that sits at a boundary, or null. */
function findNextWrapper(
  text: string,
  from: number,
): { start: number; end: number; seg: InjectedSegment } | null {
  const n = text.length
  let ls = from
  while (ls <= n) {
    let p = ls
    while (p < n && (text[p] === " " || text[p] === "\t")) p++
    const m = matchWrapperAt(text, p)
    if (m) return { start: p, end: m.end, seg: m.seg }
    const nl = text.indexOf("\n", ls)
    if (nl < 0) break
    ls = nl + 1
  }
  return null
}

function pushUser(out: ClassifiedSegment[], raw: string): void {
  const t = raw.trim()
  if (t) out.push({ kind: "user", text: t })
}

/**
 * Split a user_message's text into ordered user/injected segments (CAPP-118). Pure.
 * Returns a single unchanged user segment when there's no injected wrapper.
 *
 * NOTE (history path): on transcript rehydration, Claude Code lines flagged
 * `isMeta:true` (e.g. the PLAIN-PROSE "Caveat: the messages below were generated…"
 * synthetic turn — see transcriptHistory.fixtures.ts META_LINE) are dropped UPSTREAM
 * by transcriptHistory.parseTranscriptLine before any user_message reaches this
 * classifier — so the prose-form caveat never needs (and never gets) tag matching.
 */
export function classifyInjectedUserContent(text: string): ClassifiedSegment[] {
  // Bound (a) — review finding 1: a pathologically large message (a giant paste)
  // skips classification entirely. Combined with the closeTagEnd scan window this
  // caps the classifier's worst case; it runs synchronously in reduceTranscript.
  if (text.length > INJECTED_CLASSIFY_MAX_CHARS) return [{ kind: "user", text }]
  const segments: ClassifiedSegment[] = []
  let i = 0
  const n = text.length
  while (i < n) {
    const next = findNextWrapper(text, i)
    if (!next) {
      pushUser(segments, text.slice(i))
      break
    }
    if (next.start > i) pushUser(segments, text.slice(i, next.start))
    segments.push(next.seg)
    i = next.end
  }
  // No injected content at all → the whole message is one user bubble, byte-for-byte
  // (preserves a mid-sentence tag MENTION verbatim + keeps normal messages unchanged).
  if (!segments.some((s) => s.kind === "injected")) return [{ kind: "user", text }]
  return segments
}

/**
 * Fold ONE event into the running state, returning a NEW state (immutable for
 * React). Coalescing replaces the trailing block with a new object that reuses
 * the SAME id, so the block's identity (and therefore its DOM node) is stable
 * while its text grows.
 */
export function reduceTranscript(state: TranscriptState, event: StreamEvent): TranscriptState {
  const { blocks, seq } = state
  const last = blocks[blocks.length - 1]

  switch (event.kind) {
    case "user_message": {
      // The user's own turn — a distinct chat block. Never coalesced (each send is
      // its own message), always appended. CAPP-118 — the text may carry harness-
      // injected wrappers (task-notification / system-reminder / local-command);
      // classify it so injected blocks render as compact chips, not user bubbles. A
      // normal message classifies to ONE unchanged user segment (byte-identical).
      const segs = classifyInjectedUserContent(event.text)
      let s = seq
      const appended: TranscriptBlock[] = []
      for (const seg of segs) {
        appended.push(
          seg.kind === "user"
            ? { kind: "user", id: `b${s}`, text: seg.text }
            : { kind: "injected", id: `b${s}`, wrapper: seg.wrapper, label: seg.label, raw: seg.raw },
        )
        s++
      }
      // Defensive: an all-whitespace message classifies to nothing — keep a (blank)
      // user block so seq/shape matches the pre-CAPP-118 single-block behavior.
      if (appended.length === 0) {
        return { blocks: [...blocks, { kind: "user", id: `b${seq}`, text: event.text }], seq: seq + 1 }
      }
      return { blocks: [...blocks, ...appended], seq: s }
    }

    case "assistant_delta": {
      if (last && last.kind === "assistant") {
        const updated: AssistantTextBlock = { ...last, text: last.text + event.text }
        return { blocks: [...blocks.slice(0, -1), updated], seq }
      }
      return {
        blocks: [...blocks, { kind: "assistant", id: `b${seq}`, text: event.text }],
        seq: seq + 1,
      }
    }

    case "thinking_delta": {
      // The headless stream emits thinking as EMPTY placeholders (`thinking:""`) — the
      // real thinking text is not on the wire (proven live: 98/98 empty on a long run).
      // A content-less "Thinking" block is pure noise AND, sitting between two tool
      // batches, SPLITS what should be one collapsed tool group. So DROP empty deltas: an
      // all-empty thinking sequence yields NO block (letting the flanking tool batches
      // merge into one group), while a genuinely-populated stream — a model that DOES
      // surface thinking — still renders. Safe for coalescing: appending "" was already a
      // no-op, so the ONLY behavior change is we no longer MINT a block for a leading
      // empty delta. Keyed on exact "" (never trimmed) so real whitespace BETWEEN thinking
      // tokens is preserved (trimming per-delta would concatenate words).
      if (event.text === "") return state
      if (last && last.kind === "thinking") {
        const updated: ThinkingBlock = { ...last, text: last.text + event.text }
        return { blocks: [...blocks.slice(0, -1), updated], seq }
      }
      return {
        blocks: [...blocks, { kind: "thinking", id: `b${seq}`, text: event.text }],
        seq: seq + 1,
      }
    }

    case "tool_use": {
      const block: ToolBlock = {
        kind: "tool",
        id: `b${seq}`,
        toolUseId: event.id,
        name: event.name,
        input: event.input,
        status: "running",
      }
      return { blocks: [...blocks, block], seq: seq + 1 }
    }

    case "tool_result": {
      const idx = blocks.findIndex(
        (b) => b.kind === "tool" && b.toolUseId === event.toolUseId,
      )
      if (idx >= 0) {
        const t = blocks[idx] as ToolBlock
        const updated: ToolBlock = {
          ...t,
          result: event.content,
          isError: event.isError,
          status: event.isError ? "error" : "done",
        }
        const next = blocks.slice()
        next[idx] = updated
        return { blocks: next, seq }
      }
      // Orphan result (no matching tool_use) — keep it as a raw block, never lose it.
      return { blocks: [...blocks, { kind: "raw", id: `b${seq}`, raw: event }], seq: seq + 1 }
    }

    case "result": {
      // CAPP-39 gate ② — the live auth failure emits the `authentication_failed`
      // assistant FIRST (→ a needs_auth banner), THEN this trailing is_error result
      // whose `result` text echoes the same "Not logged in" prose. When the banner
      // is ALREADY the last block, coalesce this result INTO it (keeping the banner's
      // id) so the user sees ONE Sign-in banner — never the banner plus a stray
      // "Turn failed". The gate is the PRECEDING banner, NOT the prose: a HEALTHY
      // authenticated turn that errors for a non-auth reason but mentions an auth
      // phrase has no preceding banner here, so it falls through and renders as its
      // real result/model_error block (and its genuine error is NOT swallowed).
      if (
        event.isError &&
        last &&
        last.kind === "needs_auth" &&
        event.result != null &&
        AUTH_RESULT_TEXT_RE.test(event.result)
      ) {
        const updated: NeedsAuthBlock = { ...last, message: event.result }
        return { blocks: [...blocks.slice(0, -1), updated], seq }
      }

      // BO-6 — a model-unavailability failure (e.g. Anthropic disabled the pinned
      // model → api 404) renders a DISTINCT, actionable banner wired to the picker
      // instead of a bare "Turn failed" result block. Detected before the normal
      // result handling; a generic error result falls through unchanged.
      const modelErr = modelErrorFromResult(event)
      if (modelErr) {
        return {
          blocks: [
            ...blocks,
            { kind: "model_error", id: `b${seq}`, message: modelErr.message, model: modelErr.model },
          ],
          seq: seq + 1,
        }
      }
      // The `result` event's `result` field is the FINAL assistant text for the
      // turn — which the assistant_delta stream already rendered as an assistant
      // block (with --include-partial-messages). Showing it again here renders the
      // whole reply TWICE. Drop the result's text when it just echoes the last
      // assistant block, keeping the block for its "Turn complete" + cost footer.
      // A turn with no assistant prose (tool-only, or an error turn) keeps the text.
      const lastAssistant = lastAssistantText(blocks)
      const resultText = event.result
      const isEcho =
        resultText != null &&
        lastAssistant != null &&
        resultText.trim() === lastAssistant.trim()
      // CAPP-125 — `total_cost_usd` is cumulative per process, so store this turn's
      // PER-TURN delta (baselined off the last result block's raw cumulative) — the
      // inline CostChip then shows this turn alone and the rail's sumCost sums correctly.
      const cost = toPerTurnCost(extractCost(event.raw), lastCumulativeCostUsd(blocks))
      const block: ResultBlock = {
        kind: "result",
        id: `b${seq}`,
        isError: event.isError,
        subtype: event.subtype,
        text: isEcho ? undefined : resultText,
        cost,
      }
      return { blocks: [...blocks, block], seq: seq + 1 }
    }

    case "needs_auth": {
      // CAPP-39 gate ② — a DISTINCT, actionable block (Sign-in CTA), NOT a bare
      // ErrorBlock. AgentView renders it with a button that launches `claude /login`.
      // A single auth failure arrives as BOTH an `assistant` (error:auth_failed) AND a
      // `result` (is_error + "Not logged in") event — both map to `needs_auth`. Coalesce
      // a consecutive duplicate (keeping the existing block's id) so the user sees ONE
      // Sign-in banner, not two stacked identical ones.
      const message = event.message ?? "Authentication required."
      if (last && last.kind === "needs_auth") {
        const updated: NeedsAuthBlock = { ...last, message }
        return { blocks: [...blocks.slice(0, -1), updated], seq }
      }
      return {
        blocks: [...blocks, { kind: "needs_auth", id: `b${seq}`, message }],
        seq: seq + 1,
      }
    }

    case "init":
      // Session metadata, not a render block — surfaced elsewhere if needed.
      return state

    case "unknown":
    default:
      // Forward-compat escape hatch: any unrecognized variant becomes a benign
      // raw block. `unknown` carries `raw`; a hypothetical future kind falls
      // through here too and is preserved whole.
      return {
        blocks: [
          ...blocks,
          { kind: "raw", id: `b${seq}`, raw: isObj(event) && "raw" in event ? event.raw : event },
        ],
        seq: seq + 1,
      }
  }
}

/** Pure convenience fold of a whole ordered event list into blocks. */
export function foldTranscript(events: StreamEvent[]): TranscriptBlock[] {
  return events.reduce(reduceTranscript, emptyTranscript()).blocks
}

/**
 * BO-12 — settle any tool block still marked `running` to `error`. Used ONLY when
 * SEEDING a rehydrated (historical) transcript: a resumed conversation's prior
 * turn is, by definition, already finished (we killed/restarted it), so a
 * `running` tool there is a Stop-aborted/cut-off tool — never an in-flight one.
 * The on-disk transcript usually carries the settling tool_result already (a
 * Stop writes a `tool_result` with `is_error:true`), but a turn killed mid-stream
 * can leave a half-open tool_use with no result on disk OR in the live cache; this
 * guarantees the rehydrated view shows it SETTLED, not perpetually spinning (the
 * BO-12 caveat). Returns the SAME object when nothing is running, so a cache-seed
 * that's already clean doesn't trigger a needless rerender. Pure; live folding is
 * unaffected (a genuinely in-flight live tool still renders `running`).
 */
export function settleRunningTools(state: TranscriptState): TranscriptState {
  let changed = false
  const blocks = state.blocks.map((b) => {
    if (b.kind === "tool" && b.status === "running") {
      changed = true
      return { ...b, status: "error" as const, isError: b.isError ?? true }
    }
    return b
  })
  return changed ? { ...state, blocks } : state
}

// ---------------------------------------------------------------------------
// Click-to-expand routing — map a block to an EXISTING companion panel request.
// No new panel type, no new MCP tool: reuses diff / code / markdown.
// ---------------------------------------------------------------------------

export interface PanelRequest {
  type: "diff" | "code" | "markdown"
  props: Record<string, unknown>
}

/** Compact, human-readable markdown for a generic tool's input + result. */
function toolMarkdown(block: ToolBlock): string {
  const fence = (v: unknown) =>
    "```json\n" + JSON.stringify(v, null, 2) + "\n```"
  const parts = [`**${block.name}** — ${block.status}`, "", "Input:", fence(block.input)]
  if (block.result !== undefined) {
    parts.push("", "Result:", fence(block.result))
  }
  return parts.join("\n")
}

/**
 * Which companion panel (if any) a block expands into when clicked. Edit/Write
 * tools → the interactive `diff` panel; a raw block → the `code` panel (pretty
 * JSON); generic tools and assistant/result text → `markdown`. Returns null for
 * blocks with no richer view (thinking, bare errors).
 */
export function panelForBlock(block: TranscriptBlock): PanelRequest | null {
  if (block.kind === "tool") {
    const input = isObj(block.input) ? block.input : {}
    const name = block.name.toLowerCase()
    const path = str(input.file_path) ?? str(input.path) ?? block.name
    if (name === "edit" || name === "multiedit") {
      return {
        type: "diff",
        props: {
          files: [{ path, oldContent: str(input.old_string) ?? "", newContent: str(input.new_string) ?? "" }],
        },
      }
    }
    if (name === "write") {
      return { type: "diff", props: { files: [{ path, newContent: str(input.content) ?? "" }] } }
    }
    return { type: "markdown", props: { content: toolMarkdown(block) } }
  }

  if (block.kind === "assistant") {
    return { type: "markdown", props: { content: block.text } }
  }

  if (block.kind === "result") {
    return { type: "markdown", props: { content: block.text ?? "_(no final text for this turn)_" } }
  }

  if (block.kind === "raw") {
    return { type: "code", props: { code: JSON.stringify(block.raw, null, 2), language: "json" } }
  }

  if (block.kind === "injected") {
    // CAPP-118 review (finding 2) — ACTUALLY verbatim: the read-only CODE panel
    // renders `raw` byte-for-byte (wrapped, no language). The earlier markdown-fence
    // wrapper broke its own guarantee: a ``` run INSIDE the wrapper (a task
    // notification's <result> often carries fenced output) closed the fence and the
    // tail rendered as interpreted markdown.
    return { type: "code", props: { code: block.raw, wrap: true } }
  }

  return null
}

/**
 * CAPP-111 (S4) — the per-block expand button's label + density, paralleling
 * {@link panelForBlock}. Returns null for blocks with no detail view (so the
 * button is rendered iff `panelForBlock(block) != null` — the source of truth),
 * else `{ label, compact }`. `compact` is ALWAYS true today — every block renders an
 * ICON-ONLY ⤢ button (the `label` rides on `title`/`aria-label`). Icon-only keeps a
 * quiet, consistent affordance that fits the block's reserved top-right gutter: a
 * text label on the prose blocks (`assistant` / `result`) is absolutely-positioned
 * and would overrun its first line / the result's cost-chip row (CAPP-111 review).
 * The `label` still tracks the RESOLVED panel type, so the tooltip never drifts from
 * what actually opens — a drift-pin test asserts the iff against `panelForBlock`.
 */
export function expandLabelForBlock(
  block: TranscriptBlock,
): { label: string; compact: boolean } | null {
  if (block.kind === "tool") {
    const name = block.name.toLowerCase()
    const isDiff = name === "edit" || name === "multiedit" || name === "write"
    return { label: isDiff ? "Open diff" : "Open tool I/O", compact: true }
  }
  if (block.kind === "raw") {
    return { label: "Open raw event", compact: true }
  }
  if (block.kind === "assistant") {
    return { label: "Open in markdown", compact: true }
  }
  if (block.kind === "result") {
    return { label: "Open result", compact: true }
  }
  if (block.kind === "injected") {
    // CAPP-118 — the chip is collapsed-but-inspectable: the compact ⤢ opens the raw
    // wrapper text (never silently hidden).
    return { label: "Open raw", compact: true }
  }
  return null
}

/**
 * CAPP-119 — usefulness GATE for an assistant text block's expand button. A short
 * paragraph reads fine inline and gains nothing from the roomier panel, so it renders
 * NO icon (killing the per-paragraph ⤢ noise). Expansion is deemed useful when the
 * prose is long (over {@link ASSISTANT_EXPAND_MIN_CHARS}) OR carries structured
 * content that benefits from the panel — a fenced code block or a markdown table.
 * Pure + string-only so it's unit-testable beside {@link expandLabelForBlock}; the
 * tool/result/raw rows keep their compact icons unconditionally (unchanged).
 */
export const ASSISTANT_EXPAND_MIN_CHARS = 280

/** True IFF `text` contains a GFM table delimiter row (`| --- | :--: |`, pipe + 3+ dashes). */
function hasMarkdownTable(text: string): boolean {
  return text.split("\n").some((ln) => {
    const t = ln.trim()
    return t.includes("|") && /-{3,}/.test(t) && /^[|:\-\s]+$/.test(t)
  })
}

export function assistantExpandUseful(text: string): boolean {
  if (text.length >= ASSISTANT_EXPAND_MIN_CHARS) return true
  if (/(^|\n)\s*```/.test(text)) return true // a fenced code block
  return hasMarkdownTable(text)
}
