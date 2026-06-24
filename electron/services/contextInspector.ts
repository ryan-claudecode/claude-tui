import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, dirname, isAbsolute } from "node:path"
import { homedir } from "node:os"
import type { WorkspaceService } from "./workspaces"
import type { WorkspaceMemoryService } from "./workspaceMemory"
import type { RecallService } from "./recall"
import { encodeProjectDir } from "./terminals"
import {
  buildInjectedContext,
  type InjectWorkspaceFinding,
} from "./contextInject"
import { detectAdoption } from "./adoption"
import { loadConfig, resolveInjectMaxBytes } from "../config"

/**
 * CAPP-98 (Slice I1) — the Context Inspector v1 backend (READ-ONLY).
 *
 * Surfaces, for a workspace, the COMPLETE launch-time native context a fresh `claude`
 * eats PLUS our own injected primer — by precedence — so the user can see exactly what
 * the agent reads at spawn. This is the READ relationship of the coexistence layer
 * (design doc `docs/roadmap/claudemd-coexistence-design.md` §A); the INJECT
 * (`contextInject.ts`) and EXPORT (later slices) relationships compose on top.
 *
 * HARD INVARIANT — INSPECT-ONLY. This service may ONLY `existsSync`/`readFileSync`/
 * read directories. It has NO write path into ANY native file: it never edits a
 * CLAUDE.md, never inserts an `@import`, never touches the user's settings. The honest
 * read set is F + F's ancestors up to the git root + `~/.claude/*` + the OS
 * managed-policy paths — all read-only, no network, single device (same posture as
 * workspace memory; not a confidentiality boundary, nothing leaves the device).
 *
 * v1 is DISCOVERY ONLY: it enumerates the launch FILES + their `@import` LINES (shown
 * literally, never expanded) — NO merged/effective view, NO recursive import expansion.
 * The {@link InspectResult} contract leaves `resolved`/`effective` undefined so later
 * phases grow completeness WITHOUT a contract change.
 */

/** The precedence tier a source belongs to (0 = highest precedence). The numbering
 *  matches the design doc §A.1 table; tiers 8/9 (recursive @imports + path-scoped
 *  rules) are DEFERRED, so this v1 enumerates 0–7 and 10. */
export type ContextTier = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 10

/** One enumerated context source in the precedence list. Absent tiers are NEVER
 *  omitted — an absent source renders with `exists:false` and an empty `content`,
 *  because the completeness claim depends on showing every tier. */
export interface ContextSource {
  /** Precedence tier (0 highest). */
  tier: ContextTier
  /** A short human label for the tier (e.g. "Project memory"). */
  label: string
  /** The on-disk path inspected (the canonical one when a tier has alternatives), or a
   *  synthetic descriptor for the injected primer (#10). */
  path: string
  /** Whether the file/source exists + contributed content. */
  exists: boolean
  /** The displayed excerpt — already through the fidelity transforms (comment-strip +
   *  fenced-@import skip) and capped. Empty string when the source is absent. */
  content: string
  /** Literal `@import` lines found OUTSIDE code fences (`@./x`, `@~/x`) — shown but
   *  NEVER expanded in v1. */
  imports: string[]
  /** True when this source is present on disk but EXCLUDED from Claude's launch context
   *  by the `claudeMdExcludes` setting (a tier-3 ancestor). Marked visibly, never dropped. */
  excluded?: boolean
  /** A note explaining WHY content was cut / excluded / capped (e.g. "excluded by
   *  claudeMdExcludes", "cap: 200 lines / 25 KB"). */
  truncatedNote?: string
  /** DEFERRED (later phase): the fully-resolved content with @imports expanded. Undefined
   *  in v1 — the contract carries it so completeness grows without a contract change. */
  resolved?: string
}

/** The stable backend contract returned by {@link ContextInspectorService.inspectWorkspaceContext}.
 *  `resolved`/`effective` stay undefined in v1; later phases populate them WITHOUT a
 *  contract change. */
export interface InspectResult {
  /** The workspace folder F (absolute, validated), or null for a folderless/untagged
   *  workspace. */
  folder: string | null
  /** The git toplevel of F (absolute), or null when F isn't in a git repo / is folderless. */
  gitRoot: string | null
  /** Whether this workspace's export is ADOPTED via the user's `@import` (E2 computes it;
   *  always false in v1 — the field is wired now so the contract is stable). */
  adopted: boolean
  /** The enumerated sources in precedence order (0 first), absent tiers included. */
  sources: ContextSource[]
  /** DEFERRED (later phase): the merged effective context. Undefined in v1. */
  effective?: string
}

/** Per-source display caps so the inspector stays a glanceable summary, not a file dump.
 *  Comfortably larger than the auto-load budget — the inspector is read-by-a-human, not
 *  injected — but bounded so one giant CLAUDE.md can't blow the panel. */
const EXCERPT_CHAR_CAP = 4000

/** Claude's auto-memory file is itself capped by Claude Code at ~200 lines / 25 KB. We
 *  surface that fact on the tier-7 source (we don't re-enforce it — it's Claude's cap). */
const AUTO_MEMORY_CAP_NOTE = "cap: 200 lines / 25 KB"

/** A real synchronous `git` invocation, hardened against the user's global config the
 *  same way LocalHistoryService/WorktreeService are (a global hooks/excludes/autocrlf
 *  setting must not perturb a plain `rev-parse`). Never throws — a spawn failure yields a
 *  non-zero code and the caller treats it as "no git root". */
function gitToplevel(cwd: string): string | null {
  try {
    const r = spawnSync(
      "git",
      ["-c", "core.hooksPath=", "-C", cwd, "rev-parse", "--show-toplevel"],
      { cwd, encoding: "utf8", timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    )
    if (typeof r.status === "number" && r.status === 0) {
      const out = (r.stdout ?? "").trim()
      // git prints forward slashes even on Windows; normalize only when we compare paths.
      return out || null
    }
  } catch {
    /* git missing / not a repo — fall through to null */
  }
  return null
}

/**
 * Read a file's text, returning null on any miss (missing / unreadable / a directory).
 * READ-ONLY — the only fs verbs this service uses are existsSync/readFileSync/readdir.
 */
function readText(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    const st = statSync(path)
    if (!st.isFile()) return null
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

/**
 * The FIDELITY TRANSFORMS (design doc §A.1) applied to a raw file body BEFORE display, so
 * the inspector's excerpt reads like what Claude actually eats:
 *  1. strip block-level `<!-- … -->` HTML comments (Claude strips them on injection — this
 *     is also why our EXPORT identity marker is an HTML comment),
 *  2. collect literal `@import` lines (`@./path`, `@~/path`) that are OUTSIDE a fenced
 *     code block (a fenced ```@import``` is shown as text by Claude, not loaded),
 *  3. return the comment-stripped body PLUS the collected imports.
 *
 * The imports are shown LITERALLY with a count — v1 NEVER expands their bodies.
 */
export function applyFidelityTransforms(raw: string): { body: string; imports: string[] } {
  // ONE fence-tracking line-walk so the transforms only touch content OUTSIDE code fences —
  // a fenced ```<!-- … -->``` or ```@import``` is shown by Claude verbatim, so the inspector
  // must preserve it too (stripping/collecting inside a fence would diverge from what Claude
  // actually reads). Non-fence lines are buffered into regions; comment-stripping runs per
  // region (so a MULTI-line `<!-- … -->` is still removed whole) and @imports are collected
  // from the stripped text.
  const imports: string[] = []
  const out: string[] = []
  let inFence = false
  let region: string[] = []
  const flushRegion = () => {
    if (!region.length) return
    const stripped = region.join("\n").replace(/<!--[\s\S]*?-->/g, "")
    out.push(stripped)
    for (const line of stripped.split("\n")) {
      const t = line.trim()
      // An @import line: `@` then `./`, `../`, `~/`, or an absolute-ish path. Claude only
      // honors `@`-prefixed import lines; we match that literal shape (NEVER expanded in v1).
      if (/^@(\.{1,2}\/|~\/|\/)/.test(t)) imports.push(t)
    }
    region = []
  }
  for (const line of raw.split(/\r?\n/)) {
    // A ``` / ~~~ fence delimiter toggles the code-block state. (We don't validate the info
    // string; a bare ``` flips it — matches how a human reads the file.)
    if (/^(```|~~~)/.test(line.trim())) {
      flushRegion() // close the preceding non-fence region before the fence delimiter
      out.push(line) // the delimiter line itself stays verbatim
      inFence = !inFence
      continue
    }
    if (inFence) out.push(line) // verbatim inside a fence — no strip, no @import collection
    else region.push(line)
  }
  flushRegion()
  return { body: out.join("\n"), imports }
}

/** Cap an excerpt to {@link EXCERPT_CHAR_CAP} chars, returning the (possibly trimmed) text
 *  and a note when it was cut. */
function capExcerpt(text: string): { content: string; truncatedNote?: string } {
  const t = text.trim()
  if (t.length <= EXCERPT_CHAR_CAP) return { content: t }
  return {
    content: t.slice(0, EXCERPT_CHAR_CAP).trimEnd() + "\n…",
    truncatedNote: `excerpt capped at ${EXCERPT_CHAR_CAP} chars — open the file to see the rest`,
  }
}

/** Build a present-or-absent {@link ContextSource} for a single file path, running the
 *  fidelity transforms + excerpt cap. `extraNote` (e.g. the auto-memory cap) is appended. */
function fileSource(
  tier: ContextTier,
  label: string,
  path: string,
  opts: { excluded?: boolean; excludedNote?: string; extraNote?: string } = {},
): ContextSource {
  const raw = readText(path)
  if (raw === null) {
    return { tier, label, path, exists: false, content: "", imports: [] }
  }
  const { body, imports } = applyFidelityTransforms(raw)
  const { content, truncatedNote } = capExcerpt(body)
  const notes = [opts.excludedNote, opts.extraNote, truncatedNote].filter(Boolean)
  return {
    tier,
    label,
    path,
    exists: true,
    content,
    imports,
    ...(opts.excluded ? { excluded: true } : {}),
    ...(notes.length ? { truncatedNote: notes.join(" · ") } : {}),
  }
}

/** A synthetic "none" placeholder source for an ABSENT tier (so an empty tier is shown,
 *  never omitted). */
function nonePlaceholder(tier: ContextTier, label: string, path: string): ContextSource {
  return { tier, label, path, exists: false, content: "", imports: [] }
}

/** Join two optional notes with the standard separator (skips undefined), or undefined when both
 *  are absent. */
function combineNotes(a?: string, b?: string): string | undefined {
  const parts = [a, b].filter(Boolean)
  return parts.length ? parts.join(" · ") : undefined
}

/**
 * Best-effort read of the `claudeMdExcludes` array from the user's Claude settings
 * (`~/.claude/settings.json`) + the project settings (`F/.claude/settings.json`,
 * `F/.claude/settings.local.json`). Full settings-chain merge is DEFERRED — a best-effort
 * union of these is enough for v1 to mark excluded ancestors visibly. Returns an array of
 * raw exclude patterns (strings); a missing/corrupt file contributes nothing.
 */
function readClaudeMdExcludes(home: string, folder: string | null): string[] {
  const out: string[] = []
  const candidates = [
    join(home, ".claude", "settings.json"),
    ...(folder
      ? [join(folder, ".claude", "settings.json"), join(folder, ".claude", "settings.local.json")]
      : []),
  ]
  for (const p of candidates) {
    try {
      const raw = readText(p)
      if (!raw) continue
      const parsed = JSON.parse(raw)
      const ex = parsed?.claudeMdExcludes
      if (Array.isArray(ex)) for (const e of ex) if (typeof e === "string") out.push(e)
    } catch {
      /* corrupt settings → contribute nothing */
    }
  }
  return out
}

/** Best-effort read of the `autoMemoryDirectory` override from Claude settings, so the
 *  tier-7 auto-memory base honors a user override. Returns null when unset. */
function readAutoMemoryDirectory(home: string, folder: string | null): string | null {
  const candidates = [
    join(home, ".claude", "settings.json"),
    ...(folder ? [join(folder, ".claude", "settings.json")] : []),
  ]
  for (const p of candidates) {
    try {
      const raw = readText(p)
      if (!raw) continue
      const parsed = JSON.parse(raw)
      const dir = parsed?.autoMemoryDirectory
      if (typeof dir === "string" && dir.trim()) return dir.trim().replace(/^~/, home)
    } catch {
      /* ignore */
    }
  }
  return null
}

/** Decide whether an ancestor dir is excluded by any `claudeMdExcludes` pattern. v1 keeps
 *  matching simple + honest: a pattern matches when the ancestor's path CONTAINS it as a
 *  substring (after normalizing separators), or its basename equals it. Full glob/settings
 *  semantics are deferred; this is a best-effort VISIBLE mark, never a silent drop. */
function isExcludedAncestor(dir: string, excludes: string[]): string | null {
  if (!excludes.length) return null
  const norm = dir.replace(/\\/g, "/")
  const base = norm.split("/").filter(Boolean).pop() ?? ""
  for (const pat of excludes) {
    const p = pat.replace(/\\/g, "/").replace(/\/+$/, "")
    if (!p) continue
    if (norm.includes(p) || base === p.split("/").filter(Boolean).pop()) {
      return pat
    }
  }
  return null
}

/** List `*.md` files in a `rules/` dir whose front-matter has NO `paths:` key (the
 *  UNCONDITIONED rules — tiers 2 + 5; the conditioned `paths:` rules are tier 9, deferred).
 *  Read-only dir read; a missing dir → []. */
function unconditionedRuleFiles(rulesDir: string): string[] {
  let names: string[] = []
  try {
    if (!existsSync(rulesDir) || !statSync(rulesDir).isDirectory()) return []
    names = readdirSync(rulesDir).filter((f) => f.toLowerCase().endsWith(".md"))
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names.sort()) {
    const full = join(rulesDir, name)
    const raw = readText(full)
    if (raw === null) continue
    if (!hasPathsFrontMatter(raw)) out.push(full)
  }
  return out
}

/** True when a markdown body's leading YAML front-matter block (`--- … ---`) contains a
 *  top-level `paths:` key. Such a rule is CONDITIONED (tier 9, deferred) and excluded from
 *  the unconditioned tiers 2/5. A file with no front-matter is unconditioned. */
export function hasPathsFrontMatter(raw: string): boolean {
  const m = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return false
  // A top-level `paths:` key (line starts with optional space then `paths:`).
  return /^[ \t]*paths\s*:/m.test(m[1])
}

export class ContextInspectorService {
  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly workspaceMemory: WorkspaceMemoryService,
    private readonly recall: RecallService,
    // Injectable home dir so a hermetic test points the machine-global tiers (0/1/2/7) at a
    // temp dir instead of the real `~`. Defaults to `os.homedir()` in production.
    private readonly home: string = homedir(),
    // CAPP-100 / E2 — an optional Mode-C "wired myself" hint (the only non-scan adoption
    // signal). Injected by ipc.ts from the ExportService; defaults to none so the inspector
    // stays constructible without the export service (and tests stay simple).
    private readonly selfWiredHint: (workspaceId: string | null) => boolean = () => false,
    // CAPP-100 / E2 — the export's advertised `@import` line, so the adoption scan matches a
    // MANUAL paste (not just our delimited block). Injected by ipc.ts; defaults to none.
    private readonly importLineHint: (workspaceId: string | null) => string | null = () => null,
  ) {}

  /**
   * Inspect the complete launch-time context for a workspace. READ-ONLY: enumerates every
   * tier (0–7, 10) in precedence order, rendering a "none" placeholder for an absent tier
   * (NEVER omitting it). Returns the stable {@link InspectResult} contract.
   */
  inspectWorkspaceContext(workspaceId: string | null): InspectResult {
    const folder = this.resolveFolder(workspaceId)
    const gitRoot = folder ? gitToplevel(folder) : null
    const excludes = readClaudeMdExcludes(this.home, folder)

    // CAPP-100 / E2 — a FRESH adoption scan (marker grep over the host CLAUDE-family files,
    // bounded by the same home + git-root the inspector uses). When adopted, tier #10
    // self-attributes the workspace portion under the host @import + `adopted` is true.
    const adopted = detectAdoption(workspaceId, {
      resolveFolder: (id) => this.resolveFolder(id),
      gitRoot: () => gitRoot,
      home: this.home,
      selfWiredHint: (id) => this.selfWiredHint(id),
      importLine: (id) => this.importLineHint(id),
    })

    const sources: ContextSource[] = []

    // ── Tier 0 — Managed policy (highest, cannot be excluded) ───────────────────────
    sources.push(this.managedPolicySource())

    // ── Tier 1 — User-global memory (~/.claude/CLAUDE.md) ───────────────────────────
    sources.push(
      fileSource(1, "User-global memory", join(this.home, ".claude", "CLAUDE.md")),
    )

    // ── Tier 2 — User-global unconditioned rules (~/.claude/rules/*.md, no paths:) ──
    sources.push(...this.ruleSources(2, "User-global rule", join(this.home, ".claude", "rules")))

    // ── Tier 3 — Parent-chain memory (walk up from F, bounded at the git root) ──────
    if (folder) sources.push(...this.parentChainSources(folder, gitRoot, excludes))

    // ── Tier 4 — Project memory (F/CLAUDE.md or F/.claude/CLAUDE.md) ────────────────
    if (folder) sources.push(this.projectMemorySource(folder))

    // ── Tier 5 — Project unconditioned rules (F/.claude/rules/*.md, no paths:) ──────
    if (folder) sources.push(...this.ruleSources(5, "Project rule", join(folder, ".claude", "rules")))

    // ── Tier 6 — Project-local override (F/CLAUDE.local.md) ─────────────────────────
    if (folder) sources.push(fileSource(6, "Project-local override", join(folder, "CLAUDE.local.md")))

    // ── Tier 7 — Claude native auto-memory (<autoMemoryDir>/memory/MEMORY.md) ───────
    // CRITICAL: GIT-ROOT-keyed, not raw-F. `encodeProjectDir` is applied to the GIT ROOT
    // (applying it to F is correct for transcripts, WRONG for auto-memory — the bug the
    // design calls out). Folderless → no auto-memory (it's a project-keyed store).
    if (folder) sources.push(this.autoMemorySource(folder, gitRoot))

    // ── Tier 10 — Our injected primer (the WORKSPACE tier, through the truncating path) ─
    sources.push(this.injectedPrimerSource(workspaceId, folder, adopted))

    return {
      folder,
      gitRoot,
      // CAPP-100 / E2 — real adoption from the fresh marker scan over the host CLAUDE-family files.
      adopted,
      sources,
    }
  }

  /** Resolve F = the workspace's single folder, expanded + validated to an existing
   *  absolute dir, or null (missing / no-folder / stale). Mirrors
   *  `WorkspaceService.getActiveWorkspaceDir` but for an EXPLICIT workspace id (the
   *  inspector is workspace-scoped, not active-selection-scoped). A null workspaceId (the
   *  untagged "All" bucket) is folderless by definition. */
  private resolveFolder(workspaceId: string | null): string | null {
    if (workspaceId == null) return null
    const ws = this.workspaces.get(workspaceId)
    const dir = ws?.dir
    if (!dir) return null
    const expanded = dir.replace(/^~/, this.home)
    if (!isAbsolute(expanded)) return null
    try {
      if (!statSync(expanded).isDirectory()) return null
    } catch {
      return null
    }
    return expanded
  }

  /** Tier 0 — managed policy. On Windows the managed-settings path is
   *  `C:\ProgramData\ClaudeCode\managed-settings.json`; we also surface an OS managed
   *  CLAUDE.md if present. Platform-aware but not over-engineered for non-Windows: when no
   *  managed path exists we render "none". */
  private managedPolicySource(): ContextSource {
    const candidates: string[] = []
    if (process.platform === "win32") {
      const programData = process.env.PROGRAMDATA ?? "C:\\ProgramData"
      candidates.push(join(programData, "ClaudeCode", "managed-settings.json"))
      candidates.push(join(programData, "ClaudeCode", "CLAUDE.md"))
    } else {
      candidates.push("/Library/Application Support/ClaudeCode/managed-settings.json")
      candidates.push("/etc/claude-code/managed-settings.json")
    }
    for (const path of candidates) {
      const raw = readText(path)
      if (raw === null) continue
      // The managed-settings.json carries policy as a `claudeMd` key; an OS managed
      // CLAUDE.md is read whole. We try the JSON key first, else show the raw body.
      let display = raw
      if (path.endsWith(".json")) {
        try {
          const parsed = JSON.parse(raw)
          if (typeof parsed?.claudeMd === "string") display = parsed.claudeMd
          else continue // a managed-settings.json with no claudeMd key contributes no context
        } catch {
          continue
        }
      }
      const { body, imports } = applyFidelityTransforms(display)
      const { content, truncatedNote } = capExcerpt(body)
      return {
        tier: 0,
        label: "Managed policy",
        path,
        exists: true,
        content,
        imports,
        ...(truncatedNote ? { truncatedNote } : {}),
      }
    }
    return nonePlaceholder(0, "Managed policy", candidates[0])
  }

  /** Tiers 2 + 5 — the unconditioned `rules/*.md` for a `rules/` dir, one source per file.
   *  When the dir is empty/absent, a single "none" placeholder keeps the tier visible. */
  private ruleSources(tier: 2 | 5, label: string, rulesDir: string): ContextSource[] {
    const files = unconditionedRuleFiles(rulesDir)
    if (!files.length) return [nonePlaceholder(tier, label, rulesDir)]
    return files.map((f) => fileSource(tier, label, f))
  }

  /** Tier 3 — the parent-chain CLAUDE.md walk, from F's PARENT up, BOUNDED at the git root
   *  (inclusive of the git root dir, exclusive of F itself — F is tier 4). Each ancestor's
   *  CLAUDE.md is a source; one excluded by `claudeMdExcludes` is marked visibly. When no
   *  ancestor in range has a CLAUDE.md, a single "none" placeholder keeps the tier shown. */
  private parentChainSources(
    folder: string,
    gitRoot: string | null,
    excludes: string[],
  ): ContextSource[] {
    const out: ContextSource[] = []
    // Normalize for the bound comparison (git prints forward slashes).
    const rootNorm = gitRoot ? gitRoot.replace(/\\/g, "/").replace(/\/+$/, "") : null
    let dir = dirname(folder)
    let prev = ""
    // Walk up until we pass the git root (inclusive) or hit the filesystem root.
    while (dir && dir !== prev) {
      const dirNorm = dir.replace(/\\/g, "/").replace(/\/+$/, "")
      // BOUNDED at the git root: never read ABOVE it (that would scan unrelated projects in
      // the home tree — outside §A.4's read set). If a git root is known and `dir` is neither
      // the root nor a descendant of it, we've already stepped past the boundary → stop. When
      // F IS the git root, dirname(F) is already above it, so the walk emits nothing here and
      // tier 3 falls through to the "none" placeholder (F's own CLAUDE.md is tier 4).
      if (rootNorm && dirNorm !== rootNorm && !dirNorm.startsWith(rootNorm + "/")) break
      const claudeMd = join(dir, "CLAUDE.md")
      if (existsSync(claudeMd)) {
        const excludePat = isExcludedAncestor(dir, excludes)
        out.push(
          fileSource(3, "Parent-chain memory", claudeMd, {
            excluded: excludePat != null,
            excludedNote: excludePat != null ? `excluded by claudeMdExcludes (${excludePat})` : undefined,
          }),
        )
      }
      // Stop AFTER processing the git root dir (the walk is bounded at the git root).
      if (rootNorm && dirNorm === rootNorm) break
      prev = dir
      dir = dirname(dir)
    }
    if (!out.length) return [nonePlaceholder(3, "Parent-chain memory", dirname(folder))]
    return out
  }

  /** Tier 4 — project memory: `F/CLAUDE.md`, else `F/.claude/CLAUDE.md`. The first that
   *  exists is the source; if neither exists, a "none" placeholder at the canonical
   *  `F/CLAUDE.md` path. */
  private projectMemorySource(folder: string): ContextSource {
    const root = join(folder, "CLAUDE.md")
    if (existsSync(root)) return fileSource(4, "Project memory", root)
    const dotClaude = join(folder, ".claude", "CLAUDE.md")
    if (existsSync(dotClaude)) return fileSource(4, "Project memory", dotClaude)
    return nonePlaceholder(4, "Project memory", root)
  }

  /**
   * Tier 7 — Claude native auto-memory at `<autoMemoryDir>/memory/MEMORY.md`. The base is
   * GIT-ROOT-keyed: `<autoMemoryBase>/<encodeProjectDir(gitRoot)>/memory/MEMORY.md`, where
   * `autoMemoryBase` is the `autoMemoryDirectory` override or `~/.claude/projects`. When F
   * is NOT in a git repo we fall back to keying off F itself (best-effort — there's no git
   * root to key on), but the canonical path keys off the GIT ROOT (the design's fix).
   */
  private autoMemorySource(folder: string, gitRoot: string | null): ContextSource {
    const base = readAutoMemoryDirectory(this.home, folder) ?? join(this.home, ".claude", "projects")
    // Key off the GIT ROOT (the design's correctness fix), falling back to F only when F
    // isn't in a repo. encodeProjectDir replaces separators + the drive colon with "-".
    const keyDir = gitRoot ?? folder
    const encoded = encodeProjectDir(keyDir)
    const path = join(base, encoded, "memory", "MEMORY.md")
    const src = fileSource(7, "Claude native auto-memory", path, { extraNote: AUTO_MEMORY_CAP_NOTE })
    // Even an ABSENT auto-memory carries the cap note (so the user sees the constraint).
    if (!src.exists && !src.truncatedNote) src.truncatedNote = AUTO_MEMORY_CAP_NOTE
    return src
  }

  /**
   * Tier 10 — OUR injected primer, rendered through the SAME truncating `buildInjectedContext`
   * path the real spawn uses, so the inspector shows the CAPPED brain (not the untruncated
   * store — the design's fidelity requirement). WORKSPACE-scoped: only the workspace tier
   * (instructions + workspace findings), NO session tier (that's per-spawn, not
   * workspace-level). Sourced from the SAME services the spawn reads
   * (`workspaceMemory.getMemory(W).instructions` + `recall.workspaceTierEntries(W)`).
   */
  private injectedPrimerSource(
    workspaceId: string | null,
    folder: string | null,
    adopted: boolean,
  ): ContextSource {
    const instructions = this.workspaceMemory.getMemory(workspaceId).instructions
    const workspaceFindings: InjectWorkspaceFinding[] = this.recall
      .workspaceTierEntries(workspaceId ?? undefined)
      .map((e) => ({
        text: e.text,
        status: e.status === "ruled-out" ? ("ruled-out" as const) : ("active" as const),
        ...(e.correction ? { correction: e.correction } : {}),
        createdAt: e.createdAt,
        ...(e.pinned ? { pinned: true } : {}),
      }))

    const maxBytes = resolveInjectMaxBytes(loadConfig())
    // CAPP-100 / E2 — tier #10 adoption self-attribution. When this workspace is ADOPTED (the
    // user `@import`s our exported primer), the inject DROPS the workspace tier (`adopted:true`),
    // so the truncating render of the workspace-only inspector primer is empty — the workspace
    // brain is instead "delivered via your @import, not our flag — de-duped". We surface that
    // attribution note rather than a misleading empty/duplicated render.
    const rendered = buildInjectedContext({ instructions, workspaceFindings, adopted }, { maxBytes })

    const folderNote = folder
      ? undefined
      : "Folderless — only the Mission Control primer applies; machine-global tiers 0/1/2 still shown"
    const adoptionNote = adopted
      ? "Adopted — the workspace tier is delivered via your @import of the exported primer, not our " +
        "injected flag (de-duped, loaded exactly once). Our inject carries only the per-session tier."
      : undefined

    if (!rendered) {
      return {
        tier: 10,
        label: "Mission Control primer",
        path: "(injected via --append-system-prompt-file)",
        // When adopted, the workspace-only inject render is empty by design (the @import carries
        // it) — that's not "missing", so mark it present with the attribution note.
        exists: adopted,
        content: "",
        imports: [],
        ...(combineNotes(adoptionNote, folderNote) ? { truncatedNote: combineNotes(adoptionNote, folderNote)! } : {}),
      }
    }
    return {
      tier: 10,
      label: "Mission Control primer",
      path: "(injected via --append-system-prompt-file)",
      exists: true,
      content: rendered,
      imports: [],
      ...(combineNotes(adoptionNote, folderNote) ? { truncatedNote: combineNotes(adoptionNote, folderNote)! } : {}),
    }
  }
}
