import { existsSync, readFileSync, statSync, writeFileSync, renameSync, unlinkSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { logWarn } from "../log"
import { UNTAGGED_STEM } from "./workspaceMemory"
import { workspaceMemoryMarker } from "./export"

/**
 * CAPP-100 / E2 — ADOPTION DETECTION + the reversible CLAUDE.local.md insert.
 *
 * The READ-ONLY half (this file's detector) decides, FRESH at every inject, whether a
 * workspace's exported primer is ADOPTED — i.e. whether the user has `@import`ed our file
 * into one of the host CLAUDE-family files a fresh `claude` already reads. The split-tier
 * reconcile (design doc §E) keys off it: NOT adopted → the inject carries the workspace tier
 * (today's behavior, byte-unchanged); ADOPTED → the inject drops the workspace tier (it
 * arrives via the user's @import) so it loads EXACTLY ONCE.
 *
 * The WRITE half ({@link wireImport}/{@link unwireImport}) is the SINGLE user-initiated
 * main-window "Wire it in for me"/"Unwire" action — corruption-hardened, reversible, and
 * **NEVER MCP-exposed** (no agent can trigger it, so there are no concurrent-agent races on
 * the user's file). It appends ONLY a delimited block to `<F>/CLAUDE.local.md`.
 *
 * HARD SAFETY INVARIANTS (a reviewer probes all three):
 *   • DETECTION default-SAFE: any read error / ambiguity / absence → NOT adopted → INJECT the
 *     workspace tier. A wasted double-load is recoverable; a SILENT missing-context is worse.
 *   • The detector is a LITERAL exact-string grep for THIS workspace's marker — NO @import
 *     expansion (deferred), and a marker for a DIFFERENT workspace does NOT count.
 *   • The insert appends ONLY our delimited block; the change-guard ABORTS on a concurrent
 *     edit; Unwire REFUSES when the user hand-edited inside our delimiters.
 */

/** The delimiters of OUR managed `@import` block in the user's CLAUDE.local.md (§B.5). The
 *  block is matched CRLF-agnostically so we never write a duplicate on re-run. */
export const IMPORT_BLOCK_START = "<!-- mission-control:import start -->"
export const IMPORT_BLOCK_END = "<!-- mission-control:import end -->"

/** The deps the detector needs, injected so it stays pure-ish + hermetically testable. The
 *  same shapes the inject/inspector already resolve (folder + git root). */
export interface AdoptionDeps {
  /** Resolve a workspace's validated absolute folder F (or null when none/folderless/stale). */
  resolveFolder: (workspaceId: string | null) => string | null
  /** The git toplevel of F (absolute), or null when F isn't in a repo. Bounds the parent walk
   *  the SAME way the inspector's tier-3 walk is bounded. Injectable so a test stubs it. */
  gitRoot?: (folder: string) => string | null
  /** The home dir, so a hermetic test points `~/.claude/CLAUDE.md` at a temp dir. Defaults to
   *  `os.homedir()`. */
  home?: string
  /** A stored "I've wired this myself" hint, the ONLY fallback for an unreachable Mode-C custom
   *  path (the host file isn't one of the scanned CLAUDE-family files). Explicit + reversible;
   *  NEVER the primary signal. Returns false when unset. */
  selfWiredHint?: (workspaceId: string | null) => boolean
  /** The exact `@import` line this workspace's export advertises (e.g. `@./.claude-tui/…`), so a
   *  LITERAL host-file scan can match a MANUAL paste (the "Copy line" path) — not just our
   *  delimited "Wire it in for me" block. Undefined → only the marker + block delimiters match. */
  importLine?: (workspaceId: string | null) => string | null
}

/** A real synchronous `git rev-parse --show-toplevel`, hardened against the user's global
 *  config (hooks/excludes/autocrlf) exactly like the inspector/local-history. Never throws. */
export function gitToplevel(cwd: string): string | null {
  try {
    const r = spawnSync(
      "git",
      ["-c", "core.hooksPath=", "-C", cwd, "rev-parse", "--show-toplevel"],
      { cwd, encoding: "utf8", timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    )
    if (typeof r.status === "number" && r.status === 0) {
      return (r.stdout ?? "").trim() || null
    }
  } catch {
    /* git missing / not a repo → null */
  }
  return null
}

/** Map a public workspaceId (a real id, or null for untagged) to the marker STEM. */
function stemFor(workspaceId: string | null): string {
  return workspaceId == null ? UNTAGGED_STEM : workspaceId
}

/**
 * The exact list of host CLAUDE-family files the inject already reads, which the adoption scan
 * greps for THIS workspace's marker (design doc §E): project `<F>/CLAUDE.md`, `<F>/CLAUDE.local.md`,
 * the bounded parent-chain `CLAUDE.md` (F's ancestors up to + including the git root, same bound
 * as the inspector's tier 3 — never ABOVE the git root, so we don't scan unrelated projects), and
 * `~/.claude/CLAUDE.md`. Returned in precedence order; deduped. A folderless workspace contributes
 * only `~/.claude/CLAUDE.md`.
 */
export function adoptionScanFiles(folder: string | null, gitRoot: string | null, home: string): string[] {
  const files: string[] = []
  if (folder) {
    files.push(join(folder, "CLAUDE.md"))
    files.push(join(folder, "CLAUDE.local.md"))
    // Bounded parent-chain walk: from F's PARENT up to + including the git root.
    const rootNorm = gitRoot ? gitRoot.replace(/\\/g, "/").replace(/\/+$/, "") : null
    let dir = dirname(folder)
    let prev = ""
    while (dir && dir !== prev) {
      const dirNorm = dir.replace(/\\/g, "/").replace(/\/+$/, "")
      // Stop the moment we step ABOVE the git root (the same boundary the inspector uses).
      if (rootNorm && dirNorm !== rootNorm && !dirNorm.startsWith(rootNorm + "/")) break
      files.push(join(dir, "CLAUDE.md"))
      if (rootNorm && dirNorm === rootNorm) break
      prev = dir
      dir = dirname(dir)
    }
  }
  files.push(join(home, ".claude", "CLAUDE.md"))
  // Dedup, preserving order.
  return [...new Set(files)]
}

/**
 * Detect whether a workspace's exported primer is ADOPTED — a FRESH literal marker scan over
 * the host CLAUDE-family files (run at EVERY inject; never cached). Returns true iff THIS
 * workspace's exact marker string ({@link workspaceMemoryMarker}) appears in any scanned file.
 *
 * DEFAULT-SAFE: a host file that's missing or unreadable contributes NOTHING (we never throw,
 * never treat an unreadable file as adopted) — so when detection is uncertain we return false →
 * the caller INJECTS the workspace tier (a recoverable wasted double-load beats silent missing
 * context). A marker for a DIFFERENT workspace id does not match (the stem is part of the marker).
 *
 * The Mode-C `selfWiredHint` is the ONLY non-scan signal, an explicit reversible fallback for a
 * custom export path the user wired into a file OUTSIDE our scanned set.
 */
export function detectAdoption(workspaceId: string | null, deps: AdoptionDeps): boolean {
  const home = deps.home ?? homedir()
  const folder = deps.resolveFolder(workspaceId)
  const gitRoot = folder ? (deps.gitRoot ?? gitToplevel)(folder) : null

  // The literal signals we grep for in the host CLAUDE-family files (NO @import expansion — v1):
  //  1. THIS workspace's §B.1 marker — present if the user pasted the exported file's body
  //     directly, or if a host file's @import was already expanded into it.
  //  2. OUR managed "Wire it in for me" block delimiter — what the reversible insert writes.
  //  3. The exact `@import` line this export advertises — what the user pastes via "Copy line".
  // All carry the workspace identity (the marker embeds the stem; the import path embeds the
  // workspace's own export location), so a DIFFERENT workspace's signal never matches.
  const marker = workspaceMemoryMarker(stemFor(workspaceId))
  const importLine = deps.importLine?.(workspaceId)?.trim()
  const needles = [marker, IMPORT_BLOCK_START]
  if (importLine) needles.push(importLine)

  // A RELATIVE import line is workspace-INVARIANT (every Mode-A workspace advertises the same
  // `@./.claude-tui/workspace-memory.md`), so honoring it in a SHARED/ancestor/global host file
  // would FALSE-POSITIVE workspace B off workspace A's wiring → silently drop B's workspace tier
  // (the worse §E direction). So a relative import (signal #3, and the import-line-in-block
  // disambiguation of #2) only counts in F's OWN CLAUDE-family files.
  const ownFiles = folder
    ? new Set([join(folder, "CLAUDE.md"), join(folder, "CLAUDE.local.md")])
    : new Set<string>()
  const relativeImport = importLine ? isRelativeImport(importLine) : false

  for (const path of adoptionScanFiles(folder, gitRoot, home)) {
    let text: string
    try {
      if (!existsSync(path)) continue
      const st = statSync(path)
      if (!st.isFile()) continue
      text = readFileSync(path, "utf8")
    } catch {
      // UNREADABLE host file → contribute nothing (default-safe). NEVER infer adoption from a
      // file we couldn't read.
      continue
    }
    const relativeOk = !relativeImport || ownFiles.has(path) // a relative import only counts in own files
    // LITERAL exact-string grep — no @import expansion (deferred).
    for (const needle of needles) {
      if (needle && text.includes(needle)) {
        // The advertised import line (#3): a relative one is only meaningful in F's own files.
        if (needle === importLine && !relativeOk) continue
        // The bare block delimiter (#2) belongs to ANY workspace's wire — confirm it's OURS by
        // also requiring this workspace's import line inside that block. Without an importLine
        // hint we can't disambiguate the bare delimiter, so we don't treat it alone as adoption;
        // and a relative import inside the block follows the same own-files rule.
        if (needle === IMPORT_BLOCK_START && !importLine) continue
        if (needle === IMPORT_BLOCK_START) {
          const block = findImportBlock(text)
          if (!block || !block.inner.includes(importLine!)) continue
          if (!relativeOk) continue
        }
        return true
      }
    }
  }

  // Mode-C fallback only: an explicit, reversible "I wired a custom path myself" hint.
  if (deps.selfWiredHint?.(workspaceId)) return true

  return false
}

// ── the reversible CLAUDE.local.md insert (§B.5) — MAIN-WINDOW, NON-MCP ──────────────────

/** The result of a wire/unwire attempt, surfaced to the UI so it can explain a refusal. */
export interface WireResult {
  ok: boolean
  /** "wired" (block appended), "already" (idempotent — block already present), "removed"
   *  (Unwire stripped a pristine block), "absent" (Unwire found no block), or "refused"
   *  (a guard tripped: concurrent edit, or a user edit inside the block). */
  status: "wired" | "already" | "removed" | "absent" | "refused" | "error"
  /** Present on a refusal/error: a human-readable reason. */
  error?: string
  /** The absolute path of the host file we (would have) edited. */
  path?: string
}

/** The `@import` line the wire writes (Mode A relative, Mode C absolute). The caller passes the
 *  exact line the ExportService already derives (`importLine`) so the two can never disagree. */
export interface WireInput {
  /** The CLAUDE.local.md to edit — `<F>/CLAUDE.local.md`. */
  hostFile: string
  /** The exact `@import` line (e.g. `@./.claude-tui/workspace-memory.md`). */
  importLine: string
  /** The file's expected pre-image (or its content) captured when the UI READ the state, so the
   *  change-guard can abort if the user edited it between read and write. Undefined when the UI
   *  has no pre-image (then we capture our own immediately before the write — a smaller window). */
  expectedPreImage?: string | null
}

/** Detect a file's EOL (preserve it), defaulting to CRLF for a brand-new/empty file on Windows. */
function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : text.includes("\n") ? "\n" : "\r\n"
}

/**
 * ATOMIC write of the USER-OWNED CLAUDE.local.md: temp-then-rename with a Windows
 * EPERM/EACCES/EBUSY retry-backoff (a reader — an editor or a `claude` — may transiently hold
 * the dest). The rename is atomic, so a crash/power-loss/disk-full mid-write can NEVER leave the
 * user's file truncated (§B.5 "read-modify-RENAME"). Cleans up the temp on a failed rename, then
 * rethrows so the caller surfaces it. Mirrors `ExportService.writeAtomic`/`renameWithRetry`.
 */
function atomicWriteHostFile(dest: string, content: string): void {
  const tmp = `${dest}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmp, content, "utf8")
  let lastErr: unknown
  for (let i = 0; i < 5; i++) {
    try {
      renameSync(tmp, dest)
      return
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") break
      const until = Date.now() + 20 * (i + 1) // brief synchronous backoff for a transient lock
      while (Date.now() < until) {
        /* spin — the contended window is milliseconds */
      }
    }
  }
  try {
    unlinkSync(tmp)
  } catch {
    /* best-effort temp cleanup */
  }
  throw lastErr
}

/** A DANGLING half-block — a START delimiter with no matching END (the user hand-deleted the
 *  END). We must neither append (→ a duplicate block) nor silently no-op; both wire + unwire
 *  REFUSE so the user fixes it manually. */
function hasDanglingStart(text: string): boolean {
  const s = text.indexOf(IMPORT_BLOCK_START)
  if (s === -1) return false
  return text.indexOf(IMPORT_BLOCK_END, s) === -1
}

/** A RELATIVE `@import` line (`@./…` / `@../…`) is NOT self-identifying — every Mode-A workspace
 *  advertises the SAME `@./.claude-tui/workspace-memory.md`, and a relative import resolves
 *  against the file that contains it. So a relative line only counts as adoption when found in F's
 *  OWN CLAUDE-family files; an absolute / home line (Mode C, whose path embeds the workspace id)
 *  self-identifies and may match in any scanned host file. */
function isRelativeImport(line: string): boolean {
  return /^@\.\.?\//.test(line.trim())
}

/**
 * Locate OUR managed block in `text`, CRLF-agnostically. Returns the [startIndex, endIndex)
 * character range that spans from the START delimiter line through the END delimiter line
 * (inclusive of the end delimiter, exclusive of the trailing newline), plus the inner content
 * BETWEEN the delimiters, or null when no block is present. Matching is whitespace-tolerant on
 * the delimiter lines so a re-run never appends a second block.
 */
export function findImportBlock(
  text: string,
): { start: number; end: number; inner: string } | null {
  const startIdx = text.indexOf(IMPORT_BLOCK_START)
  if (startIdx === -1) return null
  const endMarkerIdx = text.indexOf(IMPORT_BLOCK_END, startIdx)
  if (endMarkerIdx === -1) return null
  const end = endMarkerIdx + IMPORT_BLOCK_END.length
  const inner = text.slice(startIdx + IMPORT_BLOCK_START.length, endMarkerIdx)
  return { start: startIdx, end, inner }
}

/** The pristine inner content our wire writes between the delimiters, for a given import line +
 *  EOL. Unwire compares the on-disk inner against this (modulo the line itself) to decide whether
 *  the user hand-edited inside the block. */
function pristineInner(importLine: string, eol: string): string {
  return `${eol}${importLine}${eol}`
}

/**
 * "Wire it in for me" — append OUR delimited `@import` block to `<F>/CLAUDE.local.md` (creating
 * the file if absent). Idempotent (re-run → no duplicate block), CRLF-agnostic match, EOL-preserving,
 * with a read-modify-rename CHANGE-GUARD: if `expectedPreImage` is provided and the file changed
 * since (the user edited it meanwhile), ABORT without writing. We touch ONLY our own block.
 */
export function wireImport(input: WireInput): WireResult {
  const { hostFile, importLine } = input
  try {
    let existing = ""
    const exists = existsSync(hostFile)
    if (exists) {
      existing = readFileSync(hostFile, "utf8")
    }

    // CHANGE-GUARD: abort if the file changed since the UI captured its pre-image.
    if (input.expectedPreImage !== undefined && input.expectedPreImage !== null) {
      if (existing !== input.expectedPreImage) {
        return {
          ok: false,
          status: "refused",
          path: hostFile,
          error:
            "CLAUDE.local.md changed since it was read (you may have edited it). " +
            "Nothing was written — re-open and try again.",
        }
      }
    }

    // A dangling half-block (START, no END) → REFUSE rather than append a second block.
    if (hasDanglingStart(existing)) {
      return {
        ok: false,
        status: "refused",
        path: hostFile,
        error:
          "CLAUDE.local.md has a malformed import block (a start marker with no end). " +
          "Fix it manually, then try again.",
      }
    }

    // Idempotent: if our block already exists, no-op (never a duplicate).
    if (findImportBlock(existing)) {
      return { ok: true, status: "already", path: hostFile }
    }

    const eol = detectEol(existing)
    let next = existing
    if (next.length > 0 && !next.endsWith("\n")) next += eol // terminate the prior line
    if (next.length > 0) next += eol // a blank line before our block for readability
    next += `${IMPORT_BLOCK_START}${pristineInner(importLine, eol)}${IMPORT_BLOCK_END}${eol}`

    atomicWriteHostFile(hostFile, next)
    return { ok: true, status: "wired", path: hostFile }
  } catch (err) {
    logWarn("adoption", `wireImport(${hostFile}) failed: ${String(err)}`)
    return { ok: false, status: "error", path: hostFile, error: String(err) }
  }
}

/**
 * "Unwire" — remove OUR exact delimited block from `<F>/CLAUDE.local.md`, but REFUSE (no-op +
 * surface) when the user HAND-EDITED content inside our delimiters (we only auto-remove a
 * PRISTINE block we wrote). Preserves all other content + the file's EOL. The `importLine` is
 * the line we expect inside (so a pristine block = exactly our delimiters around that line).
 */
export function unwireImport(input: { hostFile: string; importLine: string }): WireResult {
  const { hostFile, importLine } = input
  try {
    if (!existsSync(hostFile)) return { ok: true, status: "absent", path: hostFile }
    const existing = readFileSync(hostFile, "utf8")
    // A dangling half-block (START, no END) is not auto-removable — REFUSE so the user fixes it.
    if (hasDanglingStart(existing)) {
      return {
        ok: false,
        status: "refused",
        path: hostFile,
        error:
          "CLAUDE.local.md has a malformed import block (a start marker with no end) — " +
          "refusing to auto-remove it. Edit it manually.",
      }
    }
    const block = findImportBlock(existing)
    if (!block) return { ok: true, status: "absent", path: hostFile }

    // PRISTINE check: the inner content (between the delimiters), normalized for EOL, must equal
    // exactly our import line (surrounded by line breaks). Anything else = a user edit → REFUSE.
    const innerLines = block.inner.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
    const pristine = innerLines.length === 1 && innerLines[0] === importLine.trim()
    if (!pristine) {
      return {
        ok: false,
        status: "refused",
        path: hostFile,
        error:
          "The import block has hand-edited content inside our delimiters — refusing to auto-remove it. " +
          "Edit CLAUDE.local.md manually to remove it.",
      }
    }

    const eol = detectEol(existing)
    // Remove the block plus a single leading blank-line separator if we added one (so we don't
    // leave a dangling blank line). We strip from the start of the block back over one preceding
    // EOL if present.
    let cutStart = block.start
    // Drop a preceding blank line (the readability separator wireImport inserts).
    const before = existing.slice(0, cutStart)
    const trimmedBefore = before.replace(/(\r?\n)\s*$/u, (m, nl) => nl) // collapse trailing blank run to one EOL
    cutStart = trimmedBefore.length
    let cutEnd = block.end
    // Consume the trailing EOL after the end delimiter so we don't leave a stray blank line.
    const after = existing.slice(cutEnd)
    const afterTrimmed = after.replace(/^\r?\n/, "")
    cutEnd = existing.length - afterTrimmed.length

    const next = existing.slice(0, cutStart) + existing.slice(cutEnd)
    atomicWriteHostFile(hostFile, next)
    void eol
    return { ok: true, status: "removed", path: hostFile }
  } catch (err) {
    logWarn("adoption", `unwireImport(${hostFile}) failed: ${String(err)}`)
    return { ok: false, status: "error", path: hostFile, error: String(err) }
  }
}
