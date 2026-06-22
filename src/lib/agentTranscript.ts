/**
 * BO-2 — the PURE render-model reducer for a headless Claude session's
 * structured stream. Side-effect-free fold of an ordered `StreamEvent[]` (the
 * BO-1 transport's output) into render BLOCKS the AgentView renders. Zero React
 * / Electron imports — this is the unit-test seam (cf. src/lib/sessionRow.ts →
 * Sidebar, src/lib/missionRow.ts → MissionsList).
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
  costUsd?: number
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  /** Cache-write tokens (billed at a premium). */
  cacheCreationTokens?: number
  /** Cache-read tokens (billed at a discount). */
  cacheReadTokens?: number
  /** ALL billed token classes summed: input + output + cache-creation + cache-read. */
  totalTokens?: number
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
 *  the EXACT same ResultCost the transcript reducer does — no divergent token math. */
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
  return {
    costUsd: num(r.total_cost_usd),
    durationMs: num(r.duration_ms),
    numTurns: num(r.num_turns),
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens,
  }
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
    case "user_message":
      // The user's own turn — a distinct chat block. Never coalesced (each send is
      // its own message), always appended.
      return {
        blocks: [...blocks, { kind: "user", id: `b${seq}`, text: event.text }],
        seq: seq + 1,
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
      const block: ResultBlock = {
        kind: "result",
        id: `b${seq}`,
        isError: event.isError,
        subtype: event.subtype,
        text: isEcho ? undefined : resultText,
        cost: extractCost(event.raw),
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

  return null
}
