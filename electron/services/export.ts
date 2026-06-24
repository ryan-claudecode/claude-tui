import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { isAbsolute, join } from "node:path"
import { homedir } from "node:os"
import { logWarn } from "../log"
import { loadVersioned, saveVersioned, type Migration } from "../persist"
import { UNTAGGED_STEM } from "./workspaceMemory"
import {
  buildWorkspacePrimerBody,
  type InjectWorkspaceFinding,
} from "./contextInject"

/**
 * ExportService — CAPP-99 / E1: workspace-tier portability (the EXPORT relationship of the
 * CLAUDE.md coexistence layer; `docs/roadmap/claudemd-coexistence-design.md` §B + §D + §F).
 *
 * Materializes the WORKSPACE tier ONLY (standing instructions + durable findings) into a
 * markdown file the USER owns, so a raw `claude` outside Mission Control can `@import` the
 * workspace brain. Built via the SHARED {@link buildWorkspacePrimerBody} so the inject and
 * the exporter feed off the same finding set + ordering and can never drift.
 *
 * HARD SAFETY INVARIANTS (the design's §B.5/§D, non-negotiable — they protect the user's repos):
 *   • We produce ONLY our own file. We NEVER edit the user's CLAUDE.md / CLAUDE.local.md here
 *     (the "Wire it in for me" insert is the deferred E2 slice). E1 writes OUR export file +
 *     (for Mode A) OUR `/.claude-tui/` `.gitignore` entry, and surfaces a copy-able @import line.
 *   • STRICTLY one-directional: app JSON → file, NEVER file → app store. There is NO code path
 *     in this service that reads an export file back into the WorkspaceMemoryService. The only
 *     `readFileSync` on a destination is the identity-marker guard (so we never clobber a user's
 *     hand-authored file) and the change-guard (only-rewrite-if-changed) — neither feeds the store.
 *   • GITIGNORE-FIRST for Mode A: the `/.claude-tui/` entry is written to `<F>/.gitignore` BEFORE
 *     the export file lands. If the gitignore write can't happen, we DO NOT export (never leave
 *     the file untracked — an untracked file gets grabbed by `git add -A` and collides with
 *     worktree workers). The gitignore edit is CRLF-aware, idempotent, and preserves all content.
 *   • Atomic writes: temp-file-then-rename, with a Windows retry-on-EPERM backoff. Only rewrite
 *     when the body actually changed. The regen listener CATCHES ITS OWN ERRORS (a bad export
 *     must never crash the memory-mutation path).
 *
 * Mirrors the surrounding services' patterns: an injected `{ registryDir, now }` for hermetic
 * tests, a persisted registry envelope (`persist.ts`, like LayoutService), and a callback-set
 * dep style for the live workspace/memory reads (kept decoupled + testable).
 */

/** Persisted registry schema version. v1 = the shape below; no migrations (greenfield). */
export const EXPORT_SCHEMA_VERSION = 1
export const EXPORT_MIGRATIONS: Migration[] = []

/** The relative file name OUR export lands at inside a workspace folder (Mode A). The
 *  CONTAINING dir (`.claude-tui/`) is what the gitignore entry covers. */
export const MODE_A_REL_DIR = ".claude-tui"
export const EXPORT_FILE_NAME = "workspace-memory.md"
/** The exact line written into `<F>/.gitignore` for Mode A. Anchored to the workspace root
 *  (leading `/`) + trailing slash (a directory), so it can never match a nested same-named dir. */
export const GITIGNORE_ENTRY = "/.claude-tui/"

/** Export modes (the design's §B.2 table). Mode B — committed-in-folder — is DEFERRED +
 *  hard-blocked under isolateWorkers, so it is NOT representable here. */
export type ExportMode = "A" | "C"

/** One workspace's export registry entry. */
export interface ExportEntry {
  /** "A" = in-folder gitignored (default); "C" = user-chosen path (the only mode for
   *  untagged/folderless). */
  mode: ExportMode
  /** The resolved absolute target file path. For Mode A this is `<F>/.claude-tui/workspace-memory.md`;
   *  for Mode C it's the custom path (or the default `~/.claude-tui/exports/<id>/workspace-memory.md`). */
  path: string
  /** Whether regen is active. An untagged Mode-C export defaults OFF (max blast radius). */
  enabled: boolean
}

interface ExportRegistry {
  /** Keyed by workspaceId; the untagged bucket uses {@link UNTAGGED_STEM} as its key. */
  entries: Record<string, ExportEntry>
}

/** The live-service reads the exporter needs, injected so it stays decoupled + testable. */
export interface ExportDeps {
  /** Resolve a workspace's validated absolute folder (`WorkspaceService.get(id)?.dir`
   *  expanded + verified to exist), or null when none/folderless/stale. */
  resolveFolder: (workspaceId: string) => string | null
  /** The workspace's durable standing instructions (`getMemory(W).instructions`). */
  getInstructions: (workspaceId: string | null) => string
  /** The recall union @ scope:'workspace' (the durable memory tier) for a workspace —
   *  the SAME source the inject reads, mapped to the inject finding shape. */
  workspaceFindings: (workspaceId: string | null) => InjectWorkspaceFinding[]
}

/** The result of an enable attempt — surfaced to the UI so it can explain a refusal. */
export interface EnableResult {
  ok: boolean
  /** Present on failure: a human-readable reason (gitignore declined, no folder, etc.). */
  error?: string
  /** The full entry + the @import line on success (and on a re-enable / state read). */
  state?: ExportState
}

/** What the UI renders: the entry plus the derived copy-able @import line + warnings. */
export interface ExportState {
  workspaceId: string | null
  mode: ExportMode | null
  path: string | null
  enabled: boolean
  /** The exact `@import` line for the user to paste into their CLAUDE.md / CLAUDE.local.md. */
  importLine: string | null
  /** True when the workspace is untagged/folderless — Mode A is disabled, Mode C only. */
  folderless: boolean
  /** A one-line explanation when Mode A is unavailable (folderless), else undefined. */
  modeANote?: string
  /** The machine-wide warning shown for an untagged export (every raw `claude` would eat
   *  cross-project findings if wired into ~/.claude/CLAUDE.md). */
  untaggedWarning?: string
}

const FOLDERLESS_MODE_A_NOTE =
  "This workspace has no folder, so the in-folder export (Mode A) is unavailable — " +
  "use a custom path (Mode C). Folderless/untagged memory has no in-repo landing site."

const UNTAGGED_WARNING =
  "Untagged memory is global + cross-project. Wiring this export into ~/.claude/CLAUDE.md " +
  "makes EVERY raw `claude` on this machine eat these cross-project findings. Default-OFF on purpose."

export interface ExportServiceOpts {
  /** Where the registry file lives. Defaults to `~/.claude-tui`. Injectable for tests. */
  registryDir?: string
  now?: () => number
}

export class ExportService {
  private registryDir: string
  private registryPath: string
  private now: () => number
  private deps: ExportDeps
  private registry: ExportRegistry

  constructor(deps: ExportDeps, opts: ExportServiceOpts = {}) {
    this.deps = deps
    this.registryDir = opts.registryDir ?? join(homedir(), ".claude-tui")
    this.registryPath = join(this.registryDir, "exports.json")
    this.now = opts.now ?? (() => Date.now())
    this.registry = this.load()
  }

  // ── registry persistence ────────────────────────────────────────────────────────

  private load(): ExportRegistry {
    const onDisk = loadVersioned<ExportRegistry>(
      this.registryPath,
      EXPORT_SCHEMA_VERSION,
      EXPORT_MIGRATIONS,
    )
    if (onDisk && onDisk.entries && typeof onDisk.entries === "object") {
      return { entries: { ...onDisk.entries } }
    }
    return { entries: {} }
  }

  private persist(): void {
    saveVersioned(this.registryPath, EXPORT_SCHEMA_VERSION, this.registry)
  }

  /** Map a public workspaceId (a real id, or `null`/undefined for untagged) to the
   *  registry KEY (the untagged stem for the untagged bucket). */
  private keyFor(workspaceId: string | null | undefined): string {
    return workspaceId == null ? UNTAGGED_STEM : workspaceId
  }

  /** Whether a public workspaceId addresses the untagged / folderless-global bucket. */
  private isUntagged(workspaceId: string | null | undefined): boolean {
    return workspaceId == null || workspaceId === UNTAGGED_STEM
  }

  // ── path resolution ───────────────────────────────────────────────────────────

  /** The Mode-A target file inside a validated workspace folder F. */
  private modeAPath(folder: string): string {
    return join(folder, MODE_A_REL_DIR, EXPORT_FILE_NAME)
  }

  /** The default Mode-C target (outside any repo) for a workspace id. */
  private defaultModeCPath(workspaceId: string | null | undefined): string {
    const stem = this.isUntagged(workspaceId) ? UNTAGGED_STEM : (workspaceId as string)
    return join(this.registryDir, "exports", stem, EXPORT_FILE_NAME)
  }

  /** Normalize a user-supplied Mode-C path: expand a leading `~`, and if they gave a
   *  directory (or a path with no `.md`), land the file inside it as `workspace-memory.md`. */
  private normalizeCustomPath(p: string): string {
    let expanded = p
    if (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
      expanded = join(homedir(), expanded.slice(1))
    }
    // If the path looks like a directory (no .md extension), append our file name.
    if (!/\.md$/i.test(expanded)) {
      return join(expanded, EXPORT_FILE_NAME)
    }
    return expanded
  }

  // ── public API ───────────────────────────────────────────────────────────────

  /**
   * Enable export for a workspace. Mode A is gitignore-first: the entry lands ONLY after a
   * successful gitignore write + a successful first regen — so a failure at any step leaves
   * NO registry entry and NO untracked file. Returns `{ ok, error?, state? }`.
   */
  enableExport(
    workspaceId: string | null,
    mode: ExportMode,
    customPath?: string,
  ): EnableResult {
    const untagged = this.isUntagged(workspaceId)

    // Untagged/folderless: Mode A is unavailable (no in-folder landing site).
    if (mode === "A") {
      if (untagged) {
        return { ok: false, error: FOLDERLESS_MODE_A_NOTE }
      }
      const folder = this.deps.resolveFolder(workspaceId as string)
      if (!folder) {
        return {
          ok: false,
          error:
            "This workspace has no resolvable folder (no dir set, or the path is missing/stale). " +
            "Use a custom path (Mode C) instead.",
        }
      }
      const target = this.modeAPath(folder)

      // GITIGNORE-FIRST: write the entry BEFORE the file lands. Declining / failing → no export.
      const ignored = this.ensureGitignoreEntry(folder)
      if (!ignored) {
        return {
          ok: false,
          error:
            "Could not write the `/.claude-tui/` entry to .gitignore, so the export was NOT created " +
            "(an untracked export file would be grabbed by `git add -A` and collide with worktree workers).",
        }
      }

      // Stage the entry, then do the first regen. If regen fails, roll the entry back so
      // there's no enabled-but-unwritten state.
      const entry: ExportEntry = { mode: "A", path: target, enabled: true }
      this.registry.entries[this.keyFor(workspaceId)] = entry
      this.persist()
      const wrote = this.regenerate(workspaceId)
      if (!wrote.ok) {
        delete this.registry.entries[this.keyFor(workspaceId)]
        this.persist()
        return { ok: false, error: wrote.error ?? "Initial export write failed." }
      }
      return { ok: true, state: this.getExportState(workspaceId) }
    }

    // Mode C — any user path; default outside any repo. The ONLY mode for untagged/folderless.
    const target =
      customPath && customPath.trim()
        ? this.normalizeCustomPath(customPath.trim())
        : this.defaultModeCPath(workspaceId)
    if (!isAbsolute(target)) {
      return { ok: false, error: `Export path must be absolute: ${target}` }
    }
    // Untagged export is default-OFF (max blast radius). A tagged Mode-C export enables now.
    const enabled = !untagged
    const entry: ExportEntry = { mode: "C", path: target, enabled }
    this.registry.entries[this.keyFor(workspaceId)] = entry
    this.persist()
    if (enabled) {
      const wrote = this.regenerate(workspaceId)
      if (!wrote.ok) {
        delete this.registry.entries[this.keyFor(workspaceId)]
        this.persist()
        return { ok: false, error: wrote.error ?? "Initial export write failed." }
      }
    }
    return { ok: true, state: this.getExportState(workspaceId) }
  }

  /** Turn export OFF (keeps the registry entry but stops regen). We never DELETE the user's
   *  exported file behind their back — it just stops updating. */
  disableExport(workspaceId: string | null): ExportState {
    const key = this.keyFor(workspaceId)
    const entry = this.registry.entries[key]
    if (entry) {
      entry.enabled = false
      this.persist()
    }
    return this.getExportState(workspaceId)
  }

  /**
   * Flip an untagged (default-OFF) export ON explicitly. Separate from enableExport so the
   * UI must make a deliberate gesture past the machine-wide warning. No-op if not registered.
   */
  setUntaggedEnabled(enabled: boolean): ExportState {
    const key = UNTAGGED_STEM
    const entry = this.registry.entries[key]
    if (entry) {
      entry.enabled = enabled
      this.persist()
      if (enabled) this.regenerate(null)
    }
    return this.getExportState(null)
  }

  /** Read the current export state for the UI (entry + derived @import line + warnings). */
  getExportState(workspaceId: string | null): ExportState {
    const key = this.keyFor(workspaceId)
    const entry = this.registry.entries[key]
    const untagged = this.isUntagged(workspaceId)
    const folder = untagged ? null : this.deps.resolveFolder(workspaceId as string)
    const folderless = untagged || !folder

    return {
      workspaceId: untagged ? null : (workspaceId as string),
      mode: entry?.mode ?? null,
      path: entry?.path ?? null,
      enabled: entry?.enabled ?? false,
      importLine: entry ? this.importLine(entry) : null,
      folderless,
      ...(folderless ? { modeANote: FOLDERLESS_MODE_A_NOTE } : {}),
      ...(untagged ? { untaggedWarning: UNTAGGED_WARNING } : {}),
    }
  }

  /**
   * The @import line the user pastes into their CLAUDE.md / CLAUDE.local.md. For Mode A
   * (in-folder, relative to the project root F) we emit a relative `@./.claude-tui/...`
   * import; for Mode C (an arbitrary absolute path) we emit the absolute `@<path>`.
   */
  importLine(entry: ExportEntry): string {
    if (entry.mode === "A") {
      return `@./${MODE_A_REL_DIR}/${EXPORT_FILE_NAME}`
    }
    return `@${entry.path}`
  }

  /**
   * Regenerate one workspace's export. No-op (ok:true, but no write) if the workspace isn't
   * exported or is disabled. Re-validates F for Mode A (and confirms the gitignore entry is
   * still present, else skips + surfaces). Builds the body via the SHARED builder, then
   * atomic temp-then-rename with Win EPERM retry; only rewrites when the body changed.
   *
   * NEVER throws — a regen failure returns `{ ok:false, error }` and logs. (The live regen
   * listener additionally wraps this so a bad export can't crash the memory-mutation path.)
   */
  regenerate(workspaceId: string | null): { ok: boolean; wrote?: boolean; error?: string } {
    const key = this.keyFor(workspaceId)
    const entry = this.registry.entries[key]
    if (!entry) return { ok: true, wrote: false } // not exported → nothing to do
    if (!entry.enabled) return { ok: true, wrote: false } // disabled → don't regen

    try {
      const untagged = this.isUntagged(workspaceId)

      // Mode A: re-validate F + the gitignore entry. A vanished folder / removed entry must
      // SKIP (never silently re-create the file untracked) and surface the reason.
      if (entry.mode === "A") {
        if (untagged) {
          return { ok: false, error: "Untagged workspaces cannot use Mode A." }
        }
        const folder = this.deps.resolveFolder(workspaceId as string)
        if (!folder) {
          return { ok: false, error: "Workspace folder no longer resolves — export skipped." }
        }
        // The path may have moved if the folder changed; recompute + persist if so.
        const target = this.modeAPath(folder)
        if (target !== entry.path) {
          entry.path = target
          this.persist()
        }
        if (!this.gitignoreEntryPresent(folder)) {
          return {
            ok: false,
            error:
              "The `/.claude-tui/` .gitignore entry is gone — export skipped (re-enabling re-adds it). " +
              "We won't write an untracked file.",
          }
        }
      }

      const body = this.buildFileContent(workspaceId)
      const wrote = this.writeIfChanged(entry.path, body)
      return { ok: true, wrote }
    } catch (err) {
      logWarn("export", `regenerate(${String(workspaceId)}) failed: ${String(err)}`)
      return { ok: false, error: String(err) }
    }
  }

  /** Regenerate EVERY enabled export — called on app launch (self-heals exports stale from
   *  while the app was closed; §B.0). Best-effort + isolated: one bad export never blocks
   *  the rest, and the whole pass never throws. */
  regenerateAll(): void {
    for (const [key, entry] of Object.entries(this.registry.entries)) {
      if (!entry.enabled) continue
      const workspaceId = key === UNTAGGED_STEM ? null : key
      try {
        this.regenerate(workspaceId)
      } catch (err) {
        logWarn("export", `regenerateAll: ${key} failed: ${String(err)}`)
      }
    }
  }

  // ── file content ────────────────────────────────────────────────────────────────

  /** The full export file body: the §B.1 identity-marker header + the shared workspace-tier
   *  body. The leading HTML-comment marker (workspaceId + schema v1) lets a later regen
   *  confirm OUR file before overwriting, and lets E2's adoption scan find a user `@import`. */
  buildFileContent(workspaceId: string | null): string {
    const stem = this.isUntagged(workspaceId) ? UNTAGGED_STEM : (workspaceId as string)
    const marker = `<!-- mission-control:workspace-memory v1 workspace=${stem} -->`
    const provenance =
      "<!-- AUTO-GENERATED by Mission Control. Overwritten on the next memory change.\n" +
      "     One-way projection of the app's store — edits here are NOT read back. -->"

    const findings = this.deps.workspaceFindings(workspaceId)
    const instructions = this.deps.getInstructions(workspaceId)
    const sharedBody = buildWorkspacePrimerBody({ instructions, workspaceFindings: findings })

    const parts = [marker, provenance, "# Workspace memory"]
    // sharedBody already carries the Standing instructions + Durable findings sections; when
    // it's empty (no instructions, no findings) we still emit the empty section scaffold so
    // the file is a valid, recognizable projection.
    if (sharedBody) parts.push(sharedBody)
    else parts.push("## Standing instructions\n_(none)_\n\n## Durable findings\n_(none)_")

    return parts.join("\n\n") + "\n"
  }

  // ── atomic write (temp-then-rename, only-if-changed, Win EPERM retry) ─────────────

  /**
   * Write `content` to `dest` atomically IFF it differs from what's on disk AND it's safe to
   * overwrite (the destination either doesn't exist, or already carries OUR identity marker
   * for THIS workspace). Returns true when a write happened, false when skipped (unchanged).
   * Throws (caught by callers) only on a hard write failure or a marker-mismatch refusal.
   */
  private writeIfChanged(dest: string, content: string): boolean {
    // Identity-marker + change guards: read the current file once.
    let existing: string | null = null
    if (existsSync(dest)) {
      try {
        existing = readFileSync(dest, "utf8")
      } catch {
        existing = null
      }
      // Refuse to clobber a file that exists but is NOT ours (no marker / wrong workspace).
      // Match the expected marker line from the new content's first line.
      const expectedMarker = content.split("\n", 1)[0]
      if (existing !== null && !existing.startsWith(expectedMarker)) {
        // Be tolerant of a marker on a different first-line position? No — the format pins
        // the marker as the FIRST line. A file whose first line isn't our exact marker is a
        // user-authored (or foreign) file; we must NOT stomp it.
        throw new Error(
          `refusing to overwrite ${dest}: it exists but lacks our identity marker (not a Mission Control export)`,
        )
      }
    }

    // Only-rewrite-if-changed: skip the write (and the git churn) when the body matches.
    if (existing !== null && existing === content) return false

    mkdirSync(join(dest, ".."), { recursive: true })
    const tmp = `${dest}.tmp-${this.now()}-${Math.random().toString(36).slice(2, 8)}`
    writeFileSync(tmp, content, "utf8")
    this.renameWithRetry(tmp, dest)
    return true
  }

  /** rename with a Windows EPERM/EACCES/EBUSY retry-backoff — a reader (a `claude` process,
   *  or an editor) may transiently hold the destination open. Cleans up the temp file if all
   *  retries fail, then rethrows so the caller surfaces it. */
  private renameWithRetry(tmp: string, dest: string, attempts = 5): void {
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      try {
        renameSync(tmp, dest)
        return
      } catch (err) {
        lastErr = err
        const code = (err as NodeJS.ErrnoException).code
        if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") break
        // Tiny synchronous spin-wait backoff (we're on the main process; keep it short).
        const until = Date.now() + (i + 1) * 20
        while (Date.now() < until) {
          /* spin */
        }
      }
    }
    // All retries exhausted (or a non-retryable error) — drop the temp file, then rethrow.
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* best-effort cleanup */
    }
    throw lastErr
  }

  // ── gitignore (CRLF-aware, idempotent, content-preserving) ────────────────────────

  /** True iff `<folder>/.gitignore` already contains our `/.claude-tui/` entry as a whole
   *  line (CRLF-agnostic). Used both before the first export and on every regen (Mode A). */
  private gitignoreEntryPresent(folder: string): boolean {
    const giPath = join(folder, ".gitignore")
    if (!existsSync(giPath)) return false
    let text: string
    try {
      text = readFileSync(giPath, "utf8")
    } catch {
      return false
    }
    return this.hasIgnoreLine(text)
  }

  /** Whole-line, CRLF-agnostic membership test for {@link GITIGNORE_ENTRY}. Also matches a
   *  pre-existing equivalent entry WITHOUT the leading slash (`.claude-tui/`) so we never add
   *  a near-duplicate when the user already ignored the dir. */
  private hasIgnoreLine(text: string): boolean {
    const lines = text.split(/\r?\n/).map((l) => l.trim())
    return (
      lines.includes(GITIGNORE_ENTRY) ||
      lines.includes(".claude-tui/") ||
      lines.includes("/.claude-tui") ||
      lines.includes(".claude-tui")
    )
  }

  /**
   * Ensure `<folder>/.gitignore` carries our `/.claude-tui/` entry. Idempotent (no duplicate
   * on re-run), CRLF-preserving (appends using the file's detected EOL), and content-preserving
   * (every existing line kept). Creates the file if absent. Returns true on success, false if
   * the write failed (→ the caller declines to export).
   *
   * This is THE gitignore-first guarantee's implementation: callers run it BEFORE the export
   * file lands.
   */
  ensureGitignoreEntry(folder: string): boolean {
    const giPath = join(folder, ".gitignore")
    try {
      let existing = ""
      if (existsSync(giPath)) {
        existing = readFileSync(giPath, "utf8")
        if (this.hasIgnoreLine(existing)) return true // already present → idempotent no-op
      }
      // Detect the file's EOL to preserve it; default to the platform EOL for a new file.
      const eol = existing.includes("\r\n") ? "\r\n" : existing.includes("\n") ? "\n" : "\r\n"
      let next = existing
      if (next.length > 0 && !next.endsWith("\n")) next += eol // ensure the prior line is terminated
      next += `${GITIGNORE_ENTRY}${eol}`
      writeFileSync(giPath, next, "utf8")
      return true
    } catch (err) {
      logWarn("export", `ensureGitignoreEntry(${folder}) failed: ${String(err)}`)
      return false
    }
  }

  // ── debug / list ────────────────────────────────────────────────────────────────

  /** List all registry entries (for the regen-all pass + tests). */
  list(): Array<{ workspaceId: string | null; entry: ExportEntry }> {
    return Object.entries(this.registry.entries).map(([key, entry]) => ({
      workspaceId: key === UNTAGGED_STEM ? null : key,
      entry,
    }))
  }
}
