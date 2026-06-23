import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { logWarn } from "../log"

/**
 * LocalHistoryService — the local-git data-loss net for the durable "brain" (CAPP-95 / D1).
 *
 * The durable brain (CAPP-87 workspace memory + the per-session findings store)
 * has no backup today: `saveVersioned` overwrites each per-workspace/per-session
 * JSON in place, so a bad edit or a delete is unrecoverable. D1 maintains a
 * SEPARATE local git repo at `<rootDir>/.local-history/` that snapshots the
 * curated subset (`workspace-memory/` + `sessions/` ONLY) so the user can undo a
 * bad edit/delete.
 *
 * STRICT PATH SEPARATION (the design's §D invariant):
 *   - This is git over a SNAPSHOT COPY of the curated subset, NOT a git over the
 *     live `~/.claude-tui` dir, and NOT the future GitHub-sync repo (a distinct
 *     dir containing only the allow-listed subset).
 *   - The history repo is NEVER a push source: no remote is ever added, so a
 *     `push` can never exfiltrate a local-only/untagged bucket. This is a purely
 *     local data-loss net, not an exfil surface.
 *
 * MIRROR semantics so DELETIONS are captured: each `snapshot()` clears the repo's
 * `workspace-memory/` + `sessions/` dirs and re-copies the live files fresh, so a
 * finding deleted from the live store disappears from the working tree and the
 * commit records the removal (recoverable from a prior commit).
 *
 * Fire-and-forget safe: every git call is wrapped to NEVER throw into the app — a
 * snapshot failure logs a warning and returns, it never takes the app down.
 *
 * Mirrors the surrounding services' patterns: an injected `{ rootDir, now }` for
 * hermetic tests (like `SessionService` / `WorkspaceMemoryService`), and the same
 * `spawnSync("git", …)` runner shape as `WorktreeService`.
 */

/** The curated subset D1 snapshots — workspace memory + the per-session store ONLY.
 *  Deliberately EXCLUDES `context/` (machine-local inject artifacts), `missions/`,
 *  `config.json`, and `logs/` (per §D). */
export const CURATED_SUBDIRS = ["workspace-memory", "sessions"] as const

/** One snapshot commit as parsed from `git log`. */
export interface Snapshot {
  hash: string
  /** ISO-ish date string from `git log` (`%cI`). */
  date: string
  message: string
}

/** What a `restore()` put back into the live store. */
export interface RestoreResult {
  /** The relative curated paths written back into the live `<rootDir>`. */
  restored: string[]
  /** Paths requested but NOT restored (non-curated / missing / write error) — lets the
   *  renderer warn on a PARTIAL restore instead of mis-reporting total success/failure. */
  failed: string[]
}

/** Result of a single git invocation, normalized to strings + a numeric code. */
interface GitResult {
  code: number
  stdout: string
  stderr: string
}

export interface LocalHistoryOpts {
  /** Defaults to `~/.claude-tui`. Injectable for hermetic tests. */
  rootDir?: string
  now?: () => number
  /** Debounce window for the change-triggered snapshot. Default ~15s. */
  debounceMs?: number
}

export class LocalHistoryService {
  private rootDir: string
  /** The history repo — a SEPARATE git repo over a snapshot copy. */
  private repoDir: string
  private now: () => number
  private debounceMs: number
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  /** Set after a successful `init()`; guards the change-triggered snapshot from
   *  firing before the repo exists. */
  private ready = false

  /** Reload seam: after a restore, the service whose store changed must drop its
   *  cache + re-fire its change event so the renderer refreshes. Injected (callback
   *  set, like the getters in ipc.ts) to keep this service decoupled from the
   *  memory/session services. */
  private onWorkspaceMemoryRestored?: () => void
  private onSessionsRestored?: () => void

  constructor(opts: LocalHistoryOpts = {}) {
    this.rootDir = opts.rootDir ?? join(homedir(), ".claude-tui")
    this.repoDir = join(this.rootDir, ".local-history")
    this.now = opts.now ?? (() => Date.now())
    this.debounceMs = opts.debounceMs ?? 15_000
  }

  /** Wire the reload hooks (called from ipc.ts). A restore re-fires the affected
   *  service's change event so an open editor / the recall index refreshes. */
  setReloadHooks(hooks: {
    onWorkspaceMemoryRestored?: () => void
    onSessionsRestored?: () => void
  }): void {
    this.onWorkspaceMemoryRestored = hooks.onWorkspaceMemoryRestored
    this.onSessionsRestored = hooks.onSessionsRestored
  }

  // ── git runner ────────────────────────────────────────────────────────────────

  /** Config flags that make the INTERNAL history repo HERMETIC from the user's global
   *  git config — the repo is our own infra, not the user's project. Ignore their hooks
   *  (a global husky/pre-commit that exits non-zero would fail every commit and silently
   *  disable the net), their `excludesfile` (could ignore our JSON → every snapshot
   *  silently empty), CRLF translation (so `git show` is a byte-exact JSON round-trip),
   *  and gpg signing. */
  private static readonly HARDEN = [
    "-c",
    "core.hooksPath=",
    "-c",
    "core.excludesfile=",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.safecrlf=false",
    "-c",
    "commit.gpgsign=false",
  ]

  /** A real synchronous git invocation in the history repo. Mirrors
   *  `WorktreeService`'s defaultRunGit (never throws — a spawn failure → code 1), with
   *  the global-config-hardening flags so the internal repo can't be broken by a user's
   *  global git settings. */
  private git(args: string[]): GitResult {
    const r = spawnSync("git", [...LocalHistoryService.HARDEN, ...args], {
      cwd: this.repoDir,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    })
    return {
      code: typeof r.status === "number" ? r.status : 1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    }
  }

  private isRepo(): boolean {
    if (!existsSync(join(this.repoDir, ".git"))) return false
    const r = this.git(["rev-parse", "--is-inside-work-tree"])
    return r.code === 0 && r.stdout.trim() === "true"
  }

  // ── init ──────────────────────────────────────────────────────────────────────

  /**
   * Ensure `<rootDir>/.local-history/` exists and is a git repo (`git init` on a
   * miss), set a LOCAL identity so commits work without a global git config, and
   * take a baseline snapshot. NEVER adds a remote — the never-pushed invariant.
   *
   * Best-effort: any failure logs a warning and leaves `ready` false (the
   * change-triggered snapshot then no-ops) — the app must boot even if git is
   * misbehaving.
   */
  init(): void {
    try {
      mkdirSync(this.repoDir, { recursive: true })
      if (!this.isRepo()) {
        const r = this.git(["init"])
        if (r.code !== 0) {
          logWarn("localHistory", `git init failed: ${r.stderr.trim()}`)
          return
        }
      }
      // Local identity so commits succeed without a global git config (CI-safe).
      this.git(["config", "user.name", "Mission Control"])
      this.git(["config", "user.email", "mission-control@localhost"])
      // Defense-in-depth for the never-pushed invariant: if a remote somehow got
      // added, this is where we'd notice. We deliberately NEVER add one.
      this.ready = true
      this.snapshot("startup baseline")
    } catch (err) {
      logWarn("localHistory", `init failed: ${String(err)}`)
    }
  }

  // ── snapshot ────────────────────────────────────────────────────────────────────

  /**
   * Mirror the live curated subset into the repo and commit IF there's a staged
   * diff (empty commits are skipped). Clears `workspace-memory/` + `sessions/` in
   * the repo, re-copies the live files fresh (so deletions are captured), then
   * `git add -A` + `git commit`. Fire-and-forget: never throws.
   *
   * Returns the new commit hash, or null when nothing changed / on any failure.
   */
  snapshot(reason?: string): string | null {
    if (!this.ready && !this.isRepo()) return null
    try {
      this.mirrorSubset()
      const add = this.git(["add", "-A"])
      if (add.code !== 0) {
        logWarn("localHistory", `git add failed: ${add.stderr.trim()}`)
        return null
      }
      // Skip empty commits: `git diff --cached --quiet` exits 0 when nothing is
      // staged, 1 when there IS a staged diff.
      const staged = this.git(["diff", "--cached", "--quiet"])
      if (staged.code === 0) return null // nothing changed → no commit

      const ts = new Date(this.now()).toISOString()
      const message = reason ? `${ts} — ${reason}` : ts
      const commit = this.git([
        "commit",
        "--no-gpg-sign",
        "-m",
        message,
      ])
      if (commit.code !== 0) {
        logWarn("localHistory", `git commit failed: ${commit.stderr.trim()}`)
        return null
      }
      const head = this.git(["rev-parse", "HEAD"])
      return head.code === 0 ? head.stdout.trim() || null : null
    } catch (err) {
      logWarn("localHistory", `snapshot failed: ${String(err)}`)
      return null
    }
  }

  /** Clear the repo's curated dirs then re-copy the live ones fresh — the MIRROR
   *  that makes deletions show up as removals in the working tree. */
  private mirrorSubset(): void {
    for (const sub of CURATED_SUBDIRS) {
      const repoSub = join(this.repoDir, sub)
      // Clear the repo copy so a file deleted from the live store is removed here.
      rmSync(repoSub, { recursive: true, force: true })
      const liveSub = join(this.rootDir, sub)
      if (existsSync(liveSub)) {
        cpSync(liveSub, repoSub, { recursive: true })
      } else {
        // Live dir absent — keep an empty placeholder so the curated dir always
        // exists in the tree (and a later re-appearance diffs cleanly).
        mkdirSync(repoSub, { recursive: true })
      }
    }
  }

  // ── debounced change trigger ─────────────────────────────────────────────────────

  /**
   * Schedule a debounced snapshot — coalesces a burst of memory/session edits into
   * one commit. Wired in ipc.ts to `WorkspaceMemoryService.onMemoryChanged` AND
   * the session change emit. A no-op until `init()` has run.
   */
  scheduleSnapshot(reason = "memory/session change"): void {
    if (!this.ready) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.snapshot(reason)
    }, this.debounceMs)
    // Don't keep the event loop / process alive solely for a pending snapshot.
    if (typeof this.debounceTimer.unref === "function") this.debounceTimer.unref()
  }

  // ── list ──────────────────────────────────────────────────────────────────────

  /** Parse `git log` into `{ hash, date, message }` entries, newest first. Returns
   *  `[]` on any failure (or before init). */
  listSnapshots(): Snapshot[] {
    if (!this.isRepo()) return []
    // A unit separator between fields + a record separator between commits keeps the
    // parse robust against messages containing the field delimiters.
    const r = this.git(["log", "--pretty=format:%H%x1f%cI%x1f%s%x1e"])
    if (r.code !== 0) return []
    const out: Snapshot[] = []
    for (const rec of r.stdout.split("\x1e")) {
      const line = rec.trim()
      if (!line) continue
      const [hash, date, ...rest] = line.split("\x1f")
      if (!hash) continue
      out.push({ hash, date: date ?? "", message: rest.join("\x1f") ?? "" })
    }
    return out
  }

  // ── restore ─────────────────────────────────────────────────────────────────────

  /**
   * Restore a single curated file (`relPath`, e.g. `workspace-memory/<id>.json`) —
   * or the whole curated subset when omitted — from snapshot `<hash>` into the LIVE
   * `<rootDir>` store, then reload the affected service's cache + re-fire its change
   * event so the renderer refreshes.
   *
   * Reads each blob at the commit (`git show <hash>:<path>`) and writes it to the
   * live file, so a finding deleted live is brought back. A restore is itself a
   * state change → it fires the reload hooks (which re-emit onMemoryChanged), and
   * the caller's debounced snapshot then records the post-restore state.
   *
   * Returns the list of restored relative paths (empty on failure / nothing to do).
   */
  restore(hash: string, relPath?: string): RestoreResult {
    if (!this.isRepo()) return { restored: [], failed: [] }
    // A snapshot hash from listSnapshots is a full hex object name. Reject anything else
    // BEFORE touching git, so a blank hash can't silently restore from the working index
    // (`git show :path`) and garbage can't be mis-parsed.
    if (!/^[0-9a-fA-F]{7,40}$/.test(hash)) {
      logWarn("localHistory", `refusing restore from a non-commit hash: ${hash}`)
      return { restored: [], failed: [] }
    }
    const paths = relPath ? [relPath] : this.curatedPathsAt(hash)
    const restored: string[] = []
    const failed: string[] = []
    let touchedMemory = false
    let touchedSessions = false
    for (const p of paths) {
      const norm = p.replace(/\\/g, "/")
      if (!this.isCuratedPath(norm)) {
        logWarn("localHistory", `refusing to restore non-curated path: ${norm}`)
        failed.push(norm)
        continue
      }
      // PER-FILE isolation: one bad path (missing blob, EISDIR, read-only, disk-full)
      // must never abort the batch or strand the reload hooks. A half-restore reported
      // as total failure is worse than the original loss for a recovery tool.
      try {
        const show = this.git(["show", `${hash}:${norm}`])
        if (show.code !== 0) {
          // Not present in that commit (created later) — not a failure, just absent.
          continue
        }
        const dest = join(this.rootDir, norm)
        mkdirSync(join(dest, ".."), { recursive: true })
        writeFileSync(dest, show.stdout)
        restored.push(norm)
        if (norm.startsWith("workspace-memory/")) touchedMemory = true
        else if (norm.startsWith("sessions/")) touchedSessions = true
      } catch (err) {
        logWarn("localHistory", `restore of ${norm} failed: ${String(err)}`)
        failed.push(norm)
      }
    }
    // Reload whatever WAS written (even on a partial batch) so the live store + the
    // renderer reflect the recovery.
    if (touchedMemory) this.onWorkspaceMemoryRestored?.()
    if (touchedSessions) this.onSessionsRestored?.()
    // Capture the post-restore state directly (immediate, sync) rather than depending
    // solely on the reload-hook emit chain to re-trigger a snapshot.
    if (restored.length) this.snapshot("after restore")
    return { restored, failed }
  }

  /**
   * Run any pending debounced snapshot SYNCHRONOUSLY — called on app quit so the most
   * recent edit (the one most likely to be regretted) is captured before the 15s
   * debounce window would otherwise drop it. Best-effort: never throws.
   */
  flush(): void {
    try {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer)
        this.debounceTimer = null
      }
      this.snapshot("flush on quit")
    } catch (err) {
      logWarn("localHistory", `flush failed: ${String(err)}`)
    }
  }

  /** List the curated files present in snapshot `<hash>` (`git ls-tree -r --name-only`),
   *  filtered to the curated subdirs. */
  private curatedPathsAt(hash: string): string[] {
    const r = this.git(["ls-tree", "-r", "--name-only", hash])
    if (r.code !== 0) return []
    return r.stdout
      .split("\n")
      .map((l) => l.trim().replace(/\\/g, "/"))
      .filter((l) => l && this.isCuratedPath(l))
  }

  /** True ONLY for a real curated FILE path — `<curated-subdir>/<name>.json`, a single
   *  segment, no `..` traversal. Rejects directory/tree paths (a trailing slash),
   *  `..` escapes, and absolute paths, so a crafted restore `relPath` (reachable over
   *  IPC/MCP) can never write OUTSIDE the store or OVER a directory inside it. */
  private isCuratedPath(relPath: string): boolean {
    if (relPath.split("/").includes("..")) return false
    return CURATED_SUBDIRS.some((sub) => new RegExp(`^${sub}/[^/]+\\.json$`).test(relPath))
  }

  /** Reveal the history repo dir for the OS file-manager affordance. */
  get historyDir(): string {
    return this.repoDir
  }
}
