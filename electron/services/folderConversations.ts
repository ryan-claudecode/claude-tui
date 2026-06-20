/**
 * CAPP-75 — discovery of EVERY Claude Code conversation for a folder, including
 * conversations started OUTSIDE the app (plain `claude` in a terminal). Claude
 * Code writes every conversation's transcript to
 * `~/.claude/projects/<encoded-cwd>/<conversationId>.jsonl` regardless of how it
 * was started, so listing that directory enumerates them all; `claude --resume
 * <id>` reopens any of them (the app's existing restore machinery).
 *
 * This module is the pure, read-only discovery half: scan the project dir for a
 * folder, parse the lightest possible preview (the first real user message), and
 * return a sorted summary. It NEVER writes to ~/.claude. The encoding of the cwd
 * into the project-dir name REUSES {@link encodeProjectDir} from terminals.ts —
 * the single source of truth for the `C:\…` → `C--…` mapping — so a mismatch can
 * never produce an empty list.
 */

import { readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"
import { encodeProjectDir } from "./terminals"

/**
 * The PUBLIC summary of one discoverable conversation transcript. `id` is the
 * Claude Code conversation id (the `.jsonl` basename, the value `--resume` takes);
 * `updatedAt` is the transcript file's mtime (epoch ms — when it was last written,
 * i.e. how recent the conversation is); `preview` is a short, whitespace-collapsed
 * excerpt of the first real user message (empty string when none could be read).
 */
export interface FolderConversation {
  id: string
  updatedAt: number
  preview: string
}

/** Cap on how many (most-recent) conversations we return. A long-lived folder can
 *  accumulate thousands of transcripts; parsing a preview for each is wasteful and
 *  the picker only ever shows a recent slice. */
export const MAX_FOLDER_CONVERSATIONS = 50

/** Max characters of preview text retained (whitespace-collapsed, then truncated). */
const PREVIEW_MAX_CHARS = 80

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null
}

/** Collapse all runs of whitespace to single spaces, trim, and cap to ~80 chars
 *  with an ellipsis. Pure — used for every conversation's preview. */
export function previewText(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim()
  if (collapsed.length <= PREVIEW_MAX_CHARS) return collapsed
  return collapsed.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd() + "…"
}

/**
 * Extract the preview text from ONE on-disk transcript line, or undefined if this
 * line is not a usable first-user-message. We look for a `type:"user"` line whose
 * `message.content` is either a plain string (the common typed-prompt shape) or an
 * array carrying a `text` block. Tool-result-only user lines (no text) and every
 * other line type (assistant, queue-operation, attachment, system, sidechain,
 * meta, …) yield undefined so the scanner keeps looking. Never throws.
 */
export function firstUserMessageFromLine(line: string): string | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!isObj(obj)) return undefined
  // Skip subagent (Task) turns and synthetic system-injected messages — they are
  // not the human's opening prompt.
  if (obj.isSidechain === true || obj.isMeta === true) return undefined
  if (obj.type !== "user") return undefined
  const message = obj.message
  if (!isObj(message)) return undefined
  const content = message.content
  if (typeof content === "string") {
    const t = content.trim()
    return t ? t : undefined
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isObj(block) && block.type === "text" && typeof block.text === "string") {
        const t = block.text.trim()
        if (t) return t
      }
    }
  }
  return undefined
}

/**
 * Read a transcript file and return its first real user message (preview-formatted),
 * or "" if none is found / the file is unreadable. Reads the whole file but bails
 * out on the FIRST usable user line, so the common case (a prompt in the first few
 * lines) is cheap. Never throws.
 */
export function readConversationPreview(file: string): string {
  let body: string
  try {
    body = readFileSync(file, "utf8")
  } catch {
    return ""
  }
  // Split lazily-ish: a transcript can be large, but the first user message is
  // almost always near the top, so we stop scanning as soon as we find one.
  for (const line of body.split("\n")) {
    const msg = firstUserMessageFromLine(line)
    if (msg !== undefined) return previewText(msg)
  }
  return ""
}

/**
 * List EVERY discoverable Claude Code conversation for `folder`, newest first.
 *
 * Reads `~/.claude/projects/<encodeProjectDir(folder)>/*.jsonl`, returns one
 * {@link FolderConversation} per transcript (id = basename, updatedAt = mtime,
 * preview = first user message), sorts by `updatedAt` DESC, and caps the result to
 * the {@link MAX_FOLDER_CONVERSATIONS} most recent (logging via `onTruncate` when
 * it had to drop some). Tolerant by design:
 *  - a missing project dir (the folder has no Claude history) → `[]`;
 *  - a file whose mtime can't be stat'd → skipped;
 *  - an unparseable / empty file → kept with an empty preview (it's still a
 *    resumable conversation; only the preview is lost).
 *
 * `projectsRoot` is injectable for tests; production passes
 * `join(homedir(), ".claude", "projects")`. READ-ONLY — never writes to ~/.claude.
 */
export function listFolderConversations(
  projectsRoot: string,
  folder: string,
  onTruncate?: (total: number, kept: number) => void,
): FolderConversation[] {
  if (!folder || !folder.trim()) return []
  const dir = join(projectsRoot, encodeProjectDir(folder))
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return [] // no project dir for this folder → no history (expected)
  }

  // First pass: collect id + mtime for every transcript (cheap — one statSync each),
  // sort by recency, THEN read previews only for the capped slice (so we never parse
  // thousands of files for a folder with deep history).
  const stamped: Array<{ id: string; updatedAt: number; file: string }> = []
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue
    const id = f.slice(0, -".jsonl".length)
    if (!id) continue
    const file = join(dir, f)
    let mtime: number
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      continue // vanished between readdir and stat, or unreadable — skip
    }
    stamped.push({ id, updatedAt: mtime, file })
  }

  stamped.sort((a, b) => b.updatedAt - a.updatedAt)

  const total = stamped.length
  const kept = stamped.slice(0, MAX_FOLDER_CONVERSATIONS)
  if (total > kept.length) onTruncate?.(total, kept.length)

  return kept.map(({ id, updatedAt, file }) => ({
    id,
    updatedAt,
    preview: readConversationPreview(file),
  }))
}
