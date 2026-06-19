/**
 * BO-12 (CAPP-51) — the on-disk transcript reader that REHYDRATES a structured
 * chat view. A structured respawn (Stop, model-switch, handoff) and an app
 * restart both mint a fresh AgentView whose live stream starts EMPTY — `claude -p
 * --resume` does NOT re-emit prior turns as stream events — so without this the
 * chat blanks and reads as data loss. The conversation IS preserved on disk
 * (`~/.claude/projects/<encoded-cwd>/<id>.jsonl`, append-only, schema-stable), so
 * we hand-parse it and fold it through the EXISTING reducer (src/lib/agentTranscript).
 *
 * Why a NEW parser (not streamEvents.parseStreamLine): the ON-DISK format is NOT
 * the live stream-json stdout. Empirically (captured from real headless runs):
 *   - there are NO `stream_event` partial-delta lines and NO top-level `result`
 *     lines on disk;
 *   - assistant prose lives in an `assistant` line's `message.content[]` `text`
 *     block (the live path got it from `stream_event` deltas instead);
 *   - each assistant content block (thinking / text / tool_use) is its OWN line;
 *   - a `user` line carries EITHER the user's `text` OR a `tool_result`;
 *   - metadata lines (`queue-operation`, `attachment`, `system`, `last-prompt`,
 *     `mode`, `file-history-snapshot`, …) are interleaved.
 *
 * So this mapper emits assistant_delta/thinking_delta from `assistant` lines
 * (diverging from the live parser, which only pulls tool_use off them), maps
 * `user` → tool_result|user_message, tolerates `stream_event`/`result` lines if a
 * future CC version writes them, and DROPS everything else (metadata) — NOT as
 * `raw` blocks (that would flood the view), but as nothing. Sidechain (subagent)
 * and `isMeta` (synthetic) lines are skipped. Resilience mirrors streamEvents:
 * never throw, tolerate a partial last line + unknown types.
 */

import { readdirSync, readFileSync, existsSync } from "fs"
import { join } from "path"
import { encodeProjectDir } from "./terminals"
import type { StreamEvent } from "./streamProtocol"

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** Map an `assistant` line's content[] blocks to delta/tool_use events. */
function fromAssistant(obj: Record<string, unknown>): StreamEvent[] {
  const content = isObj(obj.message) ? obj.message.content : undefined
  if (!Array.isArray(content)) return []
  const out: StreamEvent[] = []
  for (const block of content) {
    if (!isObj(block)) continue
    if (block.type === "text" && typeof block.text === "string") {
      out.push({ kind: "assistant_delta", text: block.text })
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      out.push({ kind: "thinking_delta", text: block.thinking })
    } else if (block.type === "tool_use") {
      out.push({
        kind: "tool_use",
        id: str(block.id) ?? "",
        name: str(block.name) ?? "",
        input: block.input,
      })
    }
  }
  return out
}

/** Map a `user` line to tool_result(s) and/or the user's own message. */
function fromUser(obj: Record<string, unknown>): StreamEvent[] {
  const content = isObj(obj.message) ? obj.message.content : undefined
  if (typeof content === "string") {
    return content.trim() ? [{ kind: "user_message", text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const out: StreamEvent[] = []
  for (const block of content) {
    if (!isObj(block)) continue
    if (block.type === "tool_result") {
      out.push({
        kind: "tool_result",
        toolUseId: str(block.tool_use_id) ?? "",
        content: block.content,
        isError: block.is_error === true ? true : undefined,
      })
    } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      out.push({ kind: "user_message", text: block.text })
    }
  }
  return out
}

/** Parse the inner Anthropic streaming `event` of a `stream_event` line (tolerated
 *  in case a CC version persists partial messages to the transcript). Mirrors the
 *  live parser's `parseStreamSubEvent`. */
function fromStreamEvent(event: unknown): StreamEvent[] {
  if (!isObj(event)) return []
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
 * Map ONE on-disk transcript JSONL line to 0..N StreamEvents. Never throws — a
 * non-JSON / partial line yields []. Sidechain (subagent) and `isMeta` (synthetic
 * system-injected) lines are dropped, as are all metadata line types.
 */
export function parseTranscriptLine(line: string): StreamEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []

  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch {
    // Partial last line / garbage — drop, never throw.
    return []
  }
  if (!isObj(obj)) return []

  // A subagent's internal turn (Task tool) and synthetic system-injected user
  // messages are not part of the main conversation the user sees in the stream.
  if (obj.isSidechain === true) return []
  if (obj.isMeta === true) return []

  switch (obj.type) {
    case "assistant":
      return fromAssistant(obj)
    case "user":
      return fromUser(obj)
    case "stream_event":
      return fromStreamEvent(obj.event)
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
      // Metadata (queue-operation, attachment, system, last-prompt, mode,
      // file-history-snapshot, ai-title, permission-mode, …) and any future
      // unknown type: DROP. Unlike the live parser we do NOT emit a `raw` block —
      // rehydrating the dozens of interleaved metadata lines as raw cards would
      // flood the view with noise.
      return []
  }
}

/**
 * Locate the transcript file for a conversation id. Fast-paths a cwd hint
 * (`<root>/<encoded-cwd>/<id>.jsonl`); otherwise scans the project dirs for
 * `<id>.jsonl` (the id is a globally-unique uuid, so the first hit is correct).
 * Returns null if the root is absent or no file matches.
 */
export function findTranscriptFile(
  projectsRoot: string,
  ccConversationId: string,
  cwdHint?: string,
): string | null {
  if (!ccConversationId) return null
  const file = `${ccConversationId}.jsonl`
  if (cwdHint) {
    const direct = join(projectsRoot, encodeProjectDir(cwdHint), file)
    if (existsSync(direct)) return direct
  }
  let dirs: string[]
  try {
    dirs = readdirSync(projectsRoot)
  } catch {
    return null
  }
  for (const d of dirs) {
    const candidate = join(projectsRoot, d, file)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Read a conversation's on-disk transcript and return the ordered StreamEvent[]
 * it folds into (via the shared `reduceTranscript`). Tolerates a partial last
 * line and unknown line types; returns [] for a missing/unreadable transcript.
 */
export function readTranscriptEvents(
  projectsRoot: string,
  ccConversationId: string,
  cwdHint?: string,
): StreamEvent[] {
  const file = findTranscriptFile(projectsRoot, ccConversationId, cwdHint)
  if (!file) return []
  let body: string
  try {
    body = readFileSync(file, "utf8")
  } catch {
    return []
  }
  const events: StreamEvent[] = []
  for (const line of body.split("\n")) {
    if (!line.trim()) continue
    for (const ev of parseTranscriptLine(line)) events.push(ev)
  }
  return events
}
