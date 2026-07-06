/**
 * BACKGROUND WORK detection — pure, zero-dep helpers that recognize the START and
 * COMPLETION of a Claude Code background task from the headless stream, so the transport
 * can keep a session "working" (green) while detached work runs after the foreground turn
 * ends. No I/O, no state — the unit-test seam (like streamEvents' other pure bits).
 *
 * The two live shapes (captured from real runs — both carry the SAME task-id, so an
 * outstanding-set correlates exactly):
 *   START  → a tool_result whose content is
 *            `Command running in background with ID: <taskId>. Output is being written to: …`
 *   DONE   → a `<task-notification>` user message:
 *            `<task-notification> <task-id><taskId></task-id> <tool-use-id>…</tool-use-id> …`
 */

/** The tool_result text a `run_in_background` launch returns. The id is an opaque token
 *  (`bwcvqj4e4`); we capture up to the first non-id char (whitespace or the trailing `.`). */
export const BACKGROUND_START_RE = /Command running in background with ID:\s*([A-Za-z0-9_-]+)/

/** A `<task-id>…</task-id>` inside a `<task-notification>` completion notice. */
const TASK_ID_RE = /<task-id>\s*([A-Za-z0-9_-]+)\s*<\/task-id>/g

/** True when `text` is (contains) a harness `<task-notification>` completion wrapper. */
export function isTaskNotification(text: string): boolean {
  return typeof text === "string" && text.includes("<task-notification")
}

/**
 * Flatten a tool_result `content` (a string, or an array of `{type:"text",text}` /
 * string blocks, or anything else) into a plain string for pattern-matching. Best-effort
 * and total — never throws; an unrecognized shape yields "".
 */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === "string"
          ? b
          : b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
            ? (b as { text: string }).text
            : "",
      )
      .join("")
  }
  return ""
}

/**
 * The background task-id a tool_result STARTS, or null when it isn't a background launch.
 * Matches the `Command running in background with ID: <id>` shape on the flattened content.
 */
export function backgroundStartId(content: unknown): string | null {
  const m = BACKGROUND_START_RE.exec(contentToText(content))
  return m ? m[1] : null
}

/**
 * Every background task-id a `<task-notification>` reports COMPLETE (usually one, but a
 * batched notice can carry several). Empty when `text` has no well-formed `<task-id>`.
 */
export function taskNotificationIds(text: string): string[] {
  if (typeof text !== "string") return []
  const ids: string[] = []
  let m: RegExpExecArray | null
  TASK_ID_RE.lastIndex = 0
  while ((m = TASK_ID_RE.exec(text)) !== null) ids.push(m[1])
  return ids
}
