import { spawnSync } from "child_process"
import { existsSync, rmSync } from "fs"

/**
 * Result of a single git invocation. Mirrors the relevant fields of
 * `spawnSync`, normalized to strings and a numeric exit code.
 */
export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * The injected git runner seam. Production uses a real synchronous git via
 * `child_process.spawnSync`; tests can pass their own runner, though the suite
 * mostly exercises the real default against a throwaway temp repo (these are
 * deterministic local git ops — the most testable kind).
 */
export type RunGit = (args: string[], cwd: string) => GitResult

/** One worktree as reported by `git worktree list --porcelain`. */
export interface WorktreeInfo {
  path: string
  branch: string
}

/** A `git -C <repoCwd> worktree add` request and its result. */
export interface CreateWorktreeArgs {
  repoCwd: string
  branch: string
  base: string
  path: string
}

/** Outcome of `merge`: clean success or an aborted-with-summary conflict. */
export type MergeResult = { ok: true } | { ok: false; conflict: string }

/** Marker segment that identifies claudetui-managed worktree paths. */
const MANAGED_SEGMENT = ".claude-tui/worktrees/"

/** Default runner: a real synchronous git invocation via spawnSync. */
const defaultRunGit: RunGit = (args, cwd) => {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    // spawnSync sets `status` null when the process was killed by a signal or
    // failed to spawn; treat that as a non-zero failure.
    code: typeof r.status === "number" ? r.status : 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  }
}

/**
 * WorktreeService — pure git-worktree primitives over a repo dir.
 *
 * Every method is wrapped to never throw into a caller: a git failure returns a
 * structured `{ ok: false }` (or an empty/falsy value), so the mission
 * supervisor loop that drives this in WW-2 can't be taken down by a git hiccup.
 *
 * Cleanup follows the repo's own Windows-safe pattern: a plain
 * `git worktree remove` can hit "file in use" when `node_modules` is a junction,
 * so removal best-efforts the git remove, then deletes the dir directly if it
 * survives, then `git worktree prune` reconciles git's metadata.
 *
 * This is git-worktree *infrastructure* only — no mission/terminal/MCP coupling
 * (WW-2 owns all integration). See docs/roadmap/phase-2/worktree-workers-design.md.
 */
export class WorktreeService {
  constructor(private readonly runGit: RunGit = defaultRunGit) {}

  /**
   * Create a worktree for a task: `git -C <repoCwd> worktree add -b <branch>
   * <path> <base>`. Returns the created `{ path, branch }` on success, or
   * `null` if git failed (e.g. the branch already exists or `base` is invalid).
   */
  create(args: CreateWorktreeArgs): { path: string; branch: string } | null {
    const { repoCwd, branch, base, path } = args
    const r = this.runGit(
      ["-C", repoCwd, "worktree", "add", "-b", branch, path, base],
      repoCwd,
    )
    if (r.code !== 0) return null
    return { path, branch }
  }

  /**
   * Stage and commit everything in the worktree's private tree:
   * `git -C <wt> add -A` then `git -C <wt> commit -m <message>`. Safe to
   * `add -A` here — the worktree is the task's isolated tree, the whole point of
   * isolation. Returns `{ ok: false }` (no error) when there's nothing to commit.
   */
  commitAll(worktreePath: string, message: string): { ok: boolean } {
    const add = this.runGit(["-C", worktreePath, "add", "-A"], worktreePath)
    if (add.code !== 0) return { ok: false }
    // Nothing staged? `git commit` exits non-zero; surface that as ok:false,
    // not an error — an empty worktree is a valid (no-op) outcome.
    const commit = this.runGit(
      ["-C", worktreePath, "commit", "-m", message],
      worktreePath,
    )
    return { ok: commit.code === 0 }
  }

  /**
   * Combined diff of the worktree branch vs its base:
   * `git -C <wt> diff <base>...HEAD`. Returns the patch text, or an empty string
   * if there's nothing (or git failed).
   */
  diff(worktreePath: string, base: string): string {
    const r = this.runGit(
      ["-C", worktreePath, "diff", `${base}...HEAD`],
      worktreePath,
    )
    if (r.code !== 0) return ""
    return r.stdout
  }

  /**
   * Merge a task branch into the repo's working branch:
   * `git -C <repoCwd> merge --no-ff <branch>`. On a clean merge returns
   * `{ ok: true }`. On any non-zero (conflict or other failure), capture the
   * summary, run `git -C <repoCwd> merge --abort` to restore a clean state, and
   * return `{ ok: false, conflict }` — the branch is preserved for manual
   * handling, never auto-resolved.
   */
  merge(args: { repoCwd: string; branch: string }): MergeResult {
    const { repoCwd, branch } = args
    const r = this.runGit(
      ["-C", repoCwd, "merge", "--no-ff", branch],
      repoCwd,
    )
    if (r.code === 0) return { ok: true }
    // Conflict (or other failure): the merge left the index in a conflicted /
    // partial state. Abort to restore the pre-merge HEAD, preserving the branch.
    const conflict = (r.stdout + r.stderr).trim() || "merge failed"
    this.runGit(["-C", repoCwd, "merge", "--abort"], repoCwd)
    return { ok: false, conflict }
  }

  /**
   * Junction-safe worktree removal. A plain `git worktree remove` can fail with
   * "file in use" on Windows when `node_modules` is a junction, so we:
   *   1. best-effort `git worktree remove --force <path>`,
   *   2. if the dir still exists, delete it directly,
   *   3. `git -C <repoCwd> worktree prune` to reconcile git's metadata,
   *   4. optionally `git -C <repoCwd> branch -D <branch>`.
   * Returns `{ ok: false }` if the directory ultimately survived removal.
   */
  remove(args: {
    repoCwd: string
    path: string
    deleteBranch?: string
  }): { ok: boolean } {
    const { repoCwd, path, deleteBranch } = args
    // 1. Ask git to drop the worktree (force, since the worker may have left it dirty).
    this.runGit(["-C", repoCwd, "worktree", "remove", "--force", path], repoCwd)
    // 2. If the directory survives (Windows junction lock, etc.), remove it directly.
    if (existsSync(path)) {
      try {
        rmSync(path, { recursive: true, force: true })
      } catch {
        // Best-effort; reported via the existsSync check below.
      }
    }
    // 3. Reconcile git's worktree metadata so a pruned dir drops out of `list`.
    this.runGit(["-C", repoCwd, "worktree", "prune"], repoCwd)
    // 4. Optionally delete the branch (after the worktree referencing it is gone).
    if (deleteBranch) {
      this.runGit(["-C", repoCwd, "branch", "-D", deleteBranch], repoCwd)
    }
    return { ok: !existsSync(path) }
  }

  /**
   * Parse `git -C <repoCwd> worktree list --porcelain` into `{ path, branch }`
   * entries. The repo's own main worktree is included (its `branch` may be a
   * full ref or "(detached)" — left as reported). Returns `[]` on any failure.
   */
  list(repoCwd: string): WorktreeInfo[] {
    const r = this.runGit(
      ["-C", repoCwd, "worktree", "list", "--porcelain"],
      repoCwd,
    )
    if (r.code !== 0) return []
    const out: WorktreeInfo[] = []
    let path: string | null = null
    let branch = ""
    let detached = false
    const flush = () => {
      if (path !== null) {
        out.push({ path, branch: detached ? "(detached)" : branch })
      }
      path = null
      branch = ""
      detached = false
    }
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        flush()
        path = line.slice("worktree ".length).trim()
      } else if (line.startsWith("branch ")) {
        // e.g. "branch refs/heads/feature" → short name "feature".
        branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "")
      } else if (line.trim() === "detached") {
        detached = true
      }
    }
    flush()
    return out
  }

  /**
   * Best-effort reaping of orphaned claudetui-managed worktrees left by a
   * crashed run. Removes worktrees whose path is under `.claude-tui/worktrees/`
   * and whose branch is NOT in `keepBranches`. Never touches the main worktree
   * or any non-managed path. Returns the list of removed paths (logged by the
   * caller in WW-2).
   */
  reapOrphans(repoCwd: string, keepBranches: string[]): { removed: string[] } {
    const keep = new Set(keepBranches)
    const removed: string[] = []
    for (const wt of this.list(repoCwd)) {
      const managed = wt.path.replace(/\\/g, "/").includes(MANAGED_SEGMENT)
      if (!managed) continue
      if (wt.branch && keep.has(wt.branch)) continue
      const res = this.remove({
        repoCwd,
        path: wt.path,
        deleteBranch: wt.branch && wt.branch !== "(detached)" ? wt.branch : undefined,
      })
      if (res.ok) removed.push(wt.path)
    }
    return { removed }
  }

  /**
   * True if `cwd` is inside a git work tree:
   * `git -C <cwd> rev-parse --is-inside-work-tree`. Isolation requires git, so
   * WW-2 uses this to refuse `isolate_workers` on a non-repo cwd.
   */
  isGitRepo(cwd: string): boolean {
    const r = this.runGit(["-C", cwd, "rev-parse", "--is-inside-work-tree"], cwd)
    return r.code === 0 && r.stdout.trim() === "true"
  }

  /**
   * The current HEAD commit SHA of `cwd`: `git -C <cwd> rev-parse HEAD`.
   * Captured at dispatch time as a task's immutable `baseRef`, so the
   * review-capture diff (`diff(worktreePath, baseRef)`) compares the worker's
   * branch against exactly the commit it was forked from — not a moving `HEAD`
   * that a sibling task's merge may have advanced. Returns `null` on failure.
   */
  headSha(cwd: string): string | null {
    const r = this.runGit(["-C", cwd, "rev-parse", "HEAD"], cwd)
    if (r.code !== 0) return null
    return r.stdout.trim() || null
  }
}
