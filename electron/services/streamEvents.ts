/**
 * BO-1 — the tolerant, versioned parser for Claude Code's headless stream-json
 * output. A NEW pure module: no I/O, no process, no app state. Two pieces:
 *
 *   - `LineBuffer` — reassembles NDJSON lines from arbitrary stdout chunks
 *     (an event split across two `data` events; several events in one chunk).
 *   - `parseStreamLine(line)` — maps one NDJSON line to 0..N typed StreamEvents.
 *
 * Resilience is a HARD requirement — Claude Code's JSON drifts across versions,
 * so this mirrors the warn-not-throw, never-lose-the-process philosophy of
 * persist.ts's `loadVersioned`:
 *   - unknown top-level `type`          → a single `unknown` event (never throw)
 *   - unknown field on a known type     → ignored (we read only what we model)
 *   - unmodeled sub-variant of a known type (e.g. a `message_start` stream_event
 *     or a non-init `system` subtype) → silently dropped (0 events)
 *   - non-JSON / garbage line           → logged warning + dropped
 *   - partial line                      → buffered (LineBuffer), never parsed yet
 *
 * The discriminant is the line's top-level `type`. `assistant`/`user` lines
 * bundle a content[] array, so they fan out to one event per tool_use /
 * tool_result block — which is why the signature is `=> StreamEvent[]`, not the
 * single-event sketch in the ticket (real CC lines are not 1:1 with our union).
 */

import { logWarn } from "../log"
import type { StreamEvent, McpServerStatus } from "./streamProtocol"
import { backgroundStartId, isTaskNotification, taskNotificationIds } from "./backgroundTasks"

/**
 * Reassembles newline-delimited JSON from a byte/character stream that arrives
 * in arbitrary chunks. `push(chunk)` returns every COMPLETE line surfaced by
 * this chunk (handling both a single event split across chunks and multiple
 * events packed into one chunk); a trailing partial line is retained until its
 * terminating newline arrives. `flush()` returns any retained remainder (call
 * on process exit so a final newline-less line isn't lost).
 *
 * Blank lines (Claude Code occasionally emits them) are skipped. Trailing `\r`
 * is stripped so CRLF stdout on Windows parses identically to LF.
 */
export class LineBuffer {
  private buf = ""

  push(chunk: string): string[] {
    this.buf += chunk
    const out: string[] = []
    let idx: number
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).replace(/\r$/, "")
      this.buf = this.buf.slice(idx + 1)
      if (line.length > 0) out.push(line)
    }
    return out
  }

  /** Return (and clear) any buffered partial line. Call once on stream end. */
  flush(): string[] {
    const rest = this.buf.replace(/\r$/, "")
    this.buf = ""
    return rest.length > 0 ? [rest] : []
  }
}

/** Narrow an unknown to a plain object without throwing. */
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** Narrow to a string[] (filtering out non-string members), or undefined if not an array. */
function strArr(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined
}

/** Collect typed events from a message's `content[]`, ignoring blocks we don't model. */
function collectBlocks(
  content: unknown,
  map: (block: Record<string, unknown>) => StreamEvent | null,
): StreamEvent[] {
  if (!Array.isArray(content)) return []
  const out: StreamEvent[] = []
  for (const block of content) {
    if (!isObj(block)) continue
    const ev = map(block)
    if (ev) out.push(ev)
  }
  return out
}

/**
 * The top-level `error` discriminant an UNAUTHENTICATED `claude -p` puts on the
 * `assistant` event that carries the "Not logged in" text. The exact, narrow
 * value captured live — NOT a loose substring — so an unrelated error never trips
 * the auth path. This is the PRIMARY, SAFE trigger: the live shape ALWAYS emits
 * this assistant event FIRST, before the trailing `result`.
 */
const AUTH_FAILURE_ERROR = "authentication_failed"

/**
 * Detect the headless auth-failure shape on a parsed line object, returning the
 * `needs_auth` message when matched (else undefined). The transport ALSO
 * synthesizes `needs_auth` when a proc exits before `init` (terminals.ts) — this
 * covers the OTHER, more common live shape: an UNAUTHENTICATED `claude -p` v2.1.170
 * EMITS `init` first (apiKeySource:"none", which a healthy session shows too), then
 * an `assistant` carrying the explicit failure. Both shapes funnel into the SAME
 * `needs_auth` StreamEvent so the renderer has one signal to handle.
 *
 * Triggers ONLY on the EXACT discriminant: an `assistant` event whose top-level
 * `error === "authentication_failed"`. The trailing `is_error` result that the
 * live failure ALSO emits is deliberately NOT classified here — keying on its
 * prose would misfire on a HEALTHY authenticated turn that errors for a non-auth
 * reason but happens to mention "not logged in" / "/login" (e.g. the model
 * debugging a 401, a failing auth test, a `gh` CLI message). That trailing result
 * is instead suppressed/coalesced into the banner at the REDUCER level — but ONLY
 * when an `authentication_failed` assistant already signaled auth this turn (see
 * `reduceTranscript`'s `result` case), so a healthy errored result always renders
 * as its real result/model_error block.
 *
 * Deliberately does NOT inspect `apiKeySource` (a subscription login reports
 * "none" while healthy).
 */
function authFailureMessage(obj: Record<string, unknown>): string | undefined {
  if (obj.type === "assistant" && obj.error === AUTH_FAILURE_ERROR) {
    // Prefer the assistant's own prose when present; fall back to a clear default.
    return assistantText(obj) ?? "Not logged in. Please sign in to Claude."
  }
  return undefined
}

/** Best-effort: the concatenated text of an assistant message's text blocks. */
function assistantText(obj: Record<string, unknown>): string | undefined {
  const content = isObj(obj.message) ? obj.message.content : undefined
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (isObj(block) && block.type === "text") {
      const t = str(block.text)
      if (t) parts.push(t)
    }
  }
  const joined = parts.join("").trim()
  return joined.length > 0 ? joined : undefined
}

/** Parse a `stream_event` wrapper's inner Anthropic streaming `event`. */
function parseStreamSubEvent(event: unknown): StreamEvent[] {
  if (!isObj(event)) return []
  // Token-level deltas (from --include-partial-messages) are the only inner
  // shapes we model; message_start/stop, content_block_start/stop,
  // input_json_delta, signature_delta etc. are intentionally dropped here
  // (consumed by BO-2/BO-3 later if needed).
  if (event.type === "content_block_delta" && isObj(event.delta)) {
    const delta = event.delta
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      return [{ kind: "assistant_delta", text: delta.text }]
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      return [{ kind: "thinking_delta", text: delta.thinking }]
    }
  }
  return []
}

/**
 * Parse a `user` line's content[] into events. A user line carries EITHER tool_results
 * (the normal case) OR harness-injected text (a `<task-notification>`, a
 * `<system-reminder>`, …). We model three things off it:
 *   - each `tool_result` block → a `tool_result` event (unchanged);
 *   - a tool_result that reports a `run_in_background` launch → an ADDITIONAL
 *     `background_task_started` (its content carries the task-id);
 *   - a `<task-notification>` text block → a `user_message` (so the reducer renders the
 *     CAPP-118 "background task" chip LIVE — these are otherwise invisible until --resume)
 *     PLUS a `background_task_done` per completed task-id.
 * Only task-notification text is surfaced as a user_message; other injected text
 * (system-reminders, etc.) stays dropped live, exactly as before — this stays scoped to
 * the background-work signal.
 */
function parseUserLine(content: unknown): StreamEvent[] {
  if (!Array.isArray(content)) return []
  const out: StreamEvent[] = []
  const textParts: string[] = []
  for (const block of content) {
    if (!isObj(block)) continue
    if (block.type === "tool_result") {
      out.push({
        kind: "tool_result",
        toolUseId: str(block.tool_use_id) ?? "",
        content: block.content,
        isError: block.is_error === true ? true : undefined,
      })
      const startId = backgroundStartId(block.content)
      if (startId) out.push({ kind: "background_task_started", taskId: startId })
    } else if (block.type === "text") {
      const t = str(block.text)
      if (t) textParts.push(t)
    }
  }
  const text = textParts.join("")
  if (isTaskNotification(text)) {
    out.push({ kind: "user_message", text })
    for (const id of taskNotificationIds(text)) {
      out.push({ kind: "background_task_done", taskId: id })
    }
  }
  return out
}

/**
 * Parse ONE NDJSON line into 0..N typed StreamEvents. Never throws.
 */
export function parseStreamLine(line: string): StreamEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []

  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch {
    // Garbage / non-JSON line: log and drop — never let it kill the stream.
    logWarn("streamEvents", `dropping non-JSON line: ${trimmed.slice(0, 120)}`)
    return []
  }

  if (!isObj(obj)) return [{ kind: "unknown", raw: obj }]

  // Auth-failure detection (gate ② of CAPP-39): an unauthenticated `claude -p`
  // emits `init` FIRST (so the exit-before-init synth in terminals.ts never fires
  // for it), THEN an `assistant` with `error:"authentication_failed"` carrying the
  // "Not logged in" prose. Map ONLY that exact-discriminant assistant to the SAME
  // `needs_auth` event the transport synthesizes — checked BEFORE the normal type
  // handling so the failed turn renders the actionable Sign-in block instead of a
  // confusing dead turn. The trailing `is_error` result the failure ALSO emits is
  // NOT classified here (its prose alone is ambiguous with a healthy auth-mentioning
  // error); the reducer suppresses it into the banner only when this assistant
  // already signaled auth. The synth fallback for the true no-init case is UNCHANGED.
  const authMsg = authFailureMessage(obj)
  if (authMsg !== undefined) return [{ kind: "needs_auth", message: authMsg }]

  switch (obj.type) {
    case "system":
      if (obj.subtype === "init") {
        return [
          {
            kind: "init",
            sessionId: str(obj.session_id),
            cwd: str(obj.cwd),
            model: str(obj.model),
            tools: Array.isArray(obj.tools) ? (obj.tools as string[]) : undefined,
            mcpServers: Array.isArray(obj.mcp_servers)
              ? (obj.mcp_servers as McpServerStatus[])
              : undefined,
            // BO-7 — the `/`-command picker catalog. Both arrays are retained per
            // terminal (terminals.ts) and surfaced to the renderer.
            slashCommands: strArr(obj.slash_commands),
            skills: strArr(obj.skills),
            apiKeySource: str(obj.apiKeySource),
            raw: obj,
          },
        ]
      }
      // Other system subtypes (hook_started, hook_response, status) carry no
      // app-meaningful payload at this layer — drop quietly.
      return []

    case "stream_event":
      return parseStreamSubEvent(obj.event)

    case "assistant":
      return collectBlocks(
        isObj(obj.message) ? obj.message.content : undefined,
        (block) =>
          block.type === "tool_use"
            ? {
                kind: "tool_use",
                id: str(block.id) ?? "",
                name: str(block.name) ?? "",
                input: block.input,
              }
            : null,
      )

    case "user":
      return parseUserLine(isObj(obj.message) ? obj.message.content : undefined)

    case "result":
      return [
        {
          kind: "result",
          subtype: str(obj.subtype),
          isError: obj.is_error === true,
          result: str(obj.result),
          raw: obj,
        },
      ]

    default:
      // Unknown top-level type (e.g. a future event, or rate_limit_event which
      // we don't model): surface as `unknown` so nothing is silently lost and
      // a forward-compat consumer can still inspect `raw`.
      return [{ kind: "unknown", raw: obj }]
  }
}
