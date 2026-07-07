/**
 * CAPP-132 — the PURE derivation seam for the Agent Rail OUTPUTS feed. Zero deps
 * (mirrors streamEvents.ts / toolGroups.ts pure-fn pattern) so the whole
 * coalescing/dedupe/link-extraction/cap logic is hermetically unit-testable
 * without a TerminalService, a DOM, or a real `claude`.
 *
 * The "DERIVED" capture path (design §4.A): a HeadlessTerminal keeps ONE
 * {@link TurnOutputBuffer} per turn — file drafts accumulate as Write/Edit/
 * NotebookEdit tool_uses stream in (first-touch order, deduped by path), the
 * result's final text yields link drafts, and {@link flushTurn} folds the whole
 * turn into ONE ordered batch (files then links) at `result`. Explicit
 * `post_output` posts record a suppress key so a matching DERIVED draft is
 * dropped at flush — explicit beats derived (the agent's title wins).
 */
import type { RailOutputDraft } from "./streamProtocol"

/** Deliverables, not a play-by-play — a turn's derived file/link drafts are capped. */
export const MAX_FILES_PER_TURN = 10
export const MAX_LINKS_PER_TURN = 10

/**
 * One turn's derived-output accumulator, held per HeadlessTerminal. Reset on
 * spawn and after each flush.
 */
export interface TurnOutputBuffer {
  /** file drafts keyed by `file:<path>`; Map insertion order = first-touch order. */
  files: Map<string, RailOutputDraft>
  /** dedupe keys (`file:<path>` / `link:<url>`) from EXPLICIT posts — a matching
   *  DERIVED draft is dropped at flush so explicit beats derived. */
  suppressed: Set<string>
}

export function newTurnBuffer(): TurnOutputBuffer {
  return { files: new Map(), suppressed: new Set() }
}

/** The final path segment (handles both `/` and `\` separators; strips trailing
 *  separators). Pure — no `node:path` so it runs identically in any env. */
export function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "")
  const parts = trimmed.split(/[\\/]/)
  const last = parts[parts.length - 1]
  return last || p
}

/**
 * The dedupe key for a draft, or null when the kind has no dedupable target (a
 * note, or a link/file missing its url/path). Shared by the buffer and the
 * suppress-set so both sides agree on the key shape.
 */
export function draftKey(d: { kind: string; url?: string; path?: string }): string | null {
  if (d.kind === "file" && typeof d.path === "string" && d.path.trim()) return `file:${d.path.trim()}`
  if (d.kind === "link" && typeof d.url === "string" && d.url.trim()) return `link:${d.url.trim()}`
  return null
}

/**
 * Record a Write/Edit/NotebookEdit file target in the turn buffer. First-touch
 * order is kept and the SAME path touched twice (Write then Edit) is ONE draft.
 * `filePath` is `unknown` (parsed off the tool_use `input`) — parsed defensively,
 * skipped if absent / non-string / blank.
 */
export function addFileTouch(buf: TurnOutputBuffer, filePath: unknown): void {
  if (typeof filePath !== "string") return
  const path = filePath.trim()
  if (!path) return
  const key = `file:${path}`
  if (buf.files.has(key)) return // first-touch wins
  buf.files.set(key, { kind: "file", title: baseName(path), path, source: "derived" })
}

/**
 * Record an EXPLICIT post's dedupe key so a matching DERIVED draft is dropped at
 * flush (explicit beats derived — the agent posted a better title). A note (or a
 * target-less post) records nothing (it can't collide with a derived draft).
 */
export function suppressDerived(buf: TurnOutputBuffer, d: { kind: string; url?: string; path?: string }): void {
  const key = draftKey(d)
  if (key) buf.suppressed.add(key)
}

/** Trim trailing punctuation a bare-URL scan tends to swallow (sentence period,
 *  a closing bracket/quote). */
function trimUrl(url: string): string {
  return url.replace(/[).,;:!?'"\]}>]+$/, "")
}

/** A compact title for a bare URL: host + path (+ query), truncated. */
function urlTitle(url: string): string {
  let combined = url
  try {
    const u = new URL(url)
    const path = u.pathname && u.pathname !== "/" ? u.pathname : ""
    combined = `${u.host}${path}${u.search}`
  } catch {
    combined = url
  }
  return combined.length > 60 ? `${combined.slice(0, 59)}…` : combined
}

// Markdown link `[text](http(s)://url)` and a bare http(s) URL (stops at
// whitespace or bracket/paren so a markdown link's own `)` is excluded).
const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g
const BARE_URL_RE = /https?:\/\/[^\s<>()[\]]+/g

/**
 * Extract link drafts from a turn's final assistant text: markdown links AND bare
 * http(s) URLs, in DOCUMENT order (first appearance). Deduped by URL — a URL that
 * appears as both a markdown link and bare yields ONE draft and keeps the markdown
 * link text as the title (else host+truncated path). Pure; the caller applies the
 * suppress filter + per-turn cap.
 */
export function extractLinks(text: string): RailOutputDraft[] {
  if (!text) return []
  interface Hit {
    url: string
    title: string
    pos: number
    md: boolean
  }
  const hits: Hit[] = []

  // 1) Markdown links, recording their position. BLANK OUT each matched span with
  //    equal-length spaces so the bare scan below sees the SAME indices but can't
  //    re-capture the URL from inside `](url)`.
  let masked = text
  MD_LINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MD_LINK_RE.exec(text)) !== null) {
    const url = trimUrl(m[2])
    hits.push({ url, title: m[1].trim() || urlTitle(url), pos: m.index, md: true })
    masked = masked.slice(0, m.index) + " ".repeat(m[0].length) + masked.slice(m.index + m[0].length)
  }

  // 2) Bare URLs in the masked text (same indices as the original).
  BARE_URL_RE.lastIndex = 0
  while ((m = BARE_URL_RE.exec(masked)) !== null) {
    hits.push({ url: trimUrl(m[0]), title: urlTitle(trimUrl(m[0])), pos: m.index, md: false })
  }

  hits.sort((a, b) => a.pos - b.pos)

  // Dedupe by URL, keeping the EARLIEST position but upgrading the title to a
  // markdown one if the same URL appears as a markdown link anywhere.
  const chosen = new Map<string, Hit>()
  for (const h of hits) {
    if (!h.url) continue
    const prev = chosen.get(h.url)
    if (!prev) chosen.set(h.url, h)
    else if (h.md && !prev.md) chosen.set(h.url, { ...prev, title: h.title, md: true })
  }

  const seen = new Set<string>()
  const out: RailOutputDraft[] = []
  for (const h of hits) {
    if (!h.url || seen.has(h.url)) continue
    seen.add(h.url)
    out.push({ kind: "link", title: chosen.get(h.url)!.title, url: h.url, source: "derived" })
  }
  return out
}

/**
 * Fold a whole turn's buffer + its final text into ONE ordered draft batch:
 * files in first-touch order, then links — minus anything an explicit post
 * suppressed. NOISE CAPS: at most {@link MAX_FILES_PER_TURN} file entries (beyond
 * that, the kept 10 PLUS one derived "…and N more files" note), and at most
 * {@link MAX_LINKS_PER_TURN} link entries (the rest silently dropped).
 */
export function flushTurn(buf: TurnOutputBuffer, resultText: string | undefined): RailOutputDraft[] {
  const out: RailOutputDraft[] = []

  // Files (first-touch order), dropping any suppressed by an explicit post.
  const files = [...buf.files.values()].filter((d) => {
    const k = draftKey(d)
    return !(k && buf.suppressed.has(k))
  })
  const keptFiles = files.slice(0, MAX_FILES_PER_TURN)
  out.push(...keptFiles)
  const overflow = files.length - keptFiles.length
  if (overflow > 0) {
    out.push({
      kind: "note",
      title: `…and ${overflow} more file${overflow === 1 ? "" : "s"}`,
      source: "derived",
    })
  }

  // Links from the final text, deduped + suppress-filtered + capped.
  const links = extractLinks(resultText ?? "").filter((d) => {
    const k = draftKey(d)
    return !(k && buf.suppressed.has(k))
  })
  out.push(...links.slice(0, MAX_LINKS_PER_TURN))

  return out
}
