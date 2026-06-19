import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { spawnSync } from "child_process"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { WorktreeService } from "./worktree"

/**
 * WorktreeService is exercised against a REAL throwaway git repo (no mock git):
 * these are deterministic local git ops, and the point of the service is the
 * exact git behavior, so we test the real thing in a temp dir. Fully hermetic —
 * temp dirs only, no network, no app, no real mission, no ~/.claude-tui.
 */

/** Run git directly (test setup helper) and assert it succeeded. */
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`,
    )
  }
  return (r.stdout ?? "").trimEnd()
}

/** All temp dirs created across the suite, removed in afterAll-style cleanup. */
const tempDirs: string[] = []

/**
 * Create a fresh throwaway repo with a committed file and a real git identity
 * (so commits work in a CI-less env). Returns the repo path.
 */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "wt-svc-"))
  tempDirs.push(repo)
  git(repo, "init", "-b", "main")
  git(repo, "config", "user.email", "test@claudetui.local")
  git(repo, "config", "user.name", "ClaudeTUI Test")
  // Stable default so worktree adds / merges behave the same everywhere.
  git(repo, "config", "commit.gpgsign", "false")
  writeFileSync(join(repo, "base.txt"), "line1\nline2\nline3\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-m", "initial commit")
  return repo
}

describe("WorktreeService", () => {
  let svc: WorktreeService
  let repo: string

  beforeEach(() => {
    svc = new WorktreeService() // real default runGit (spawnSync)
    repo = makeRepo()
  })

  afterEach(() => {
    // Best-effort cleanup of every temp dir created so far — leave zero behind.
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore — temp dir may already be gone */
      }
    }
  })

  it("isGitRepo: true inside a repo, false outside one", () => {
    expect(svc.isGitRepo(repo)).toBe(true)
    const notRepo = mkdtempSync(join(tmpdir(), "wt-norepo-"))
    tempDirs.push(notRepo)
    expect(svc.isGitRepo(notRepo)).toBe(false)
  })

  it("create → edit → commitAll → diff (non-empty) → clean merge", () => {
    const wtPath = join(repo, ".claude-tui", "worktrees", "m1", "t1")
    const created = svc.create({
      repoCwd: repo,
      branch: "claudetui/m1/t1",
      base: "main",
      path: wtPath,
    })
    expect(created).toEqual({ path: wtPath, branch: "claudetui/m1/t1" })
    expect(existsSync(wtPath)).toBe(true)

    // Worker edits the isolated tree.
    writeFileSync(join(wtPath, "base.txt"), "line1\nCHANGED\nline3\n")
    writeFileSync(join(wtPath, "new.txt"), "brand new file\n")

    const committed = svc.commitAll(wtPath, "wip: task 1")
    expect(committed.ok).toBe(true)

    // Diff vs the dispatch-time base is non-empty and shows both changes.
    const d = svc.diff(wtPath, "main")
    expect(d).toContain("CHANGED")
    expect(d).toContain("new.txt")

    // Clean merge back into main (no overlapping edits on main).
    const merged = svc.merge({ repoCwd: repo, branch: "claudetui/m1/t1" })
    expect(merged).toEqual({ ok: true })
    // The change actually landed on main.
    expect(git(repo, "show", "HEAD:base.txt")).toContain("CHANGED")
  })

  it("commitAll on an unchanged worktree returns ok:false (nothing to commit)", () => {
    const wtPath = join(repo, ".claude-tui", "worktrees", "m1", "empty")
    svc.create({
      repoCwd: repo,
      branch: "claudetui/m1/empty",
      base: "main",
      path: wtPath,
    })
    // No edits made — there is nothing to stage/commit.
    const res = svc.commitAll(wtPath, "wip: nothing")
    expect(res.ok).toBe(false)
  })

  it("merge conflict: returns {ok:false, conflict} AND aborts, leaving the branch intact", () => {
    // Diverge main: change line2 to MAIN-SIDE on the base branch.
    writeFileSync(join(repo, "base.txt"), "line1\nMAIN-SIDE\nline3\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "main edits line2")
    const headBeforeMerge = git(repo, "rev-parse", "HEAD")

    // A worktree branched from the ORIGINAL base (before the main edit) that
    // touches the SAME line — guarantees a conflict at merge.
    const wtPath = join(repo, ".claude-tui", "worktrees", "m1", "conflict")
    const branch = "claudetui/m1/conflict"
    svc.create({ repoCwd: repo, branch, base: "HEAD~1", path: wtPath })
    writeFileSync(join(wtPath, "base.txt"), "line1\nWORKER-SIDE\nline3\n")
    expect(svc.commitAll(wtPath, "wip: worker edits line2").ok).toBe(true)

    const result = svc.merge({ repoCwd: repo, branch })
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.conflict.length).toBeGreaterThan(0)
    }

    // The merge was aborted: HEAD is back where it was, no merge in progress.
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBeforeMerge)
    // No MERGE_HEAD → not mid-merge.
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false)
    // No conflict-state entries remain (UU/AA/DD/etc.). The only status noise is
    // the untracked .claude-tui/ worktree dir, which lives inside the repo — that
    // is expected and is not a leftover of the aborted merge.
    const status = git(repo, "status", "--porcelain")
    const conflictRows = status
      .split("\n")
      .filter((l) => l.trim() && /^(DD|AU|UD|UA|DU|AA|UU)/.test(l))
    expect(conflictRows).toEqual([])
    // The branch is preserved for manual handling.
    const branches = git(repo, "branch", "--list", branch)
    expect(branches).toContain(branch)
    // main still has its own edit, untouched by the failed merge.
    expect(git(repo, "show", "HEAD:base.txt")).toContain("MAIN-SIDE")
  })

  it("list includes created worktrees; remove + prune drops it and deletes the branch", () => {
    const wtPath = join(repo, ".claude-tui", "worktrees", "m1", "removable")
    const branch = "claudetui/m1/removable"
    svc.create({ repoCwd: repo, branch, base: "main", path: wtPath })

    // list shows both the main worktree and the new one.
    const before = svc.list(repo)
    expect(before.some((w) => w.path.replace(/\\/g, "/").endsWith("/removable"))).toBe(true)
    expect(before.some((w) => w.branch === branch)).toBe(true)

    // Junction-safe removal: dir gone, pruned from list, branch deleted.
    const res = svc.remove({ repoCwd: repo, path: wtPath, deleteBranch: branch })
    expect(res.ok).toBe(true)
    expect(existsSync(wtPath)).toBe(false)

    const after = svc.list(repo)
    expect(after.some((w) => w.path.replace(/\\/g, "/").endsWith("/removable"))).toBe(false)
    // Branch is gone.
    expect(git(repo, "branch", "--list", branch)).toBe("")
  })

  it("remove succeeds even when the worktree dir lingers (junction-safe direct delete)", () => {
    // Simulate the Windows case where `git worktree remove` can't fully clear
    // the dir by using a runGit seam that no-ops the git `remove`, forcing the
    // service's direct rmSync fallback to do the work.
    const realSvc = new WorktreeService()
    const wtPath = join(repo, ".claude-tui", "worktrees", "m1", "lingering")
    realSvc.create({
      repoCwd: repo,
      branch: "claudetui/m1/lingering",
      base: "main",
      path: wtPath,
    })
    expect(existsSync(wtPath)).toBe(true)

    // Seam that swallows `worktree remove` (returns failure) but lets prune run,
    // so the only thing that can delete the dir is the service's rmSync fallback.
    const spy = new WorktreeService((args, cwd) => {
      if (args.includes("remove")) return { code: 1, stdout: "", stderr: "simulated lock" }
      return spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true }) as never
    })
    const res = spy.remove({ repoCwd: repo, path: wtPath })
    expect(res.ok).toBe(true)
    expect(existsSync(wtPath)).toBe(false)
  })

  it("reapOrphans removes managed worktrees not in keepBranches, keeping the rest", () => {
    const keepPath = join(repo, ".claude-tui", "worktrees", "m1", "keepme")
    const keepBranch = "claudetui/m1/keepme"
    const dropPath = join(repo, ".claude-tui", "worktrees", "m1", "dropme")
    const dropBranch = "claudetui/m1/dropme"
    svc.create({ repoCwd: repo, branch: keepBranch, base: "main", path: keepPath })
    svc.create({ repoCwd: repo, branch: dropBranch, base: "main", path: dropPath })

    const { removed } = svc.reapOrphans(repo, [keepBranch])
    expect(removed.some((p) => p.replace(/\\/g, "/").endsWith("/dropme"))).toBe(true)
    expect(removed.some((p) => p.replace(/\\/g, "/").endsWith("/keepme"))).toBe(false)

    expect(existsSync(dropPath)).toBe(false)
    expect(existsSync(keepPath)).toBe(true)
    // The dropped branch was deleted; the kept one survives.
    expect(git(repo, "branch", "--list", dropBranch)).toBe("")
    expect(git(repo, "branch", "--list", keepBranch)).toContain(keepBranch)
  })

  it("reapOrphans never touches the main worktree (non-managed path)", () => {
    // Only the main worktree exists (no managed worktrees). Nothing should be removed.
    const { removed } = svc.reapOrphans(repo, [])
    expect(removed).toEqual([])
    // The main worktree is still listed and the repo is intact.
    expect(svc.isGitRepo(repo)).toBe(true)
    expect(svc.list(repo).length).toBeGreaterThan(0)
  })

  it("headSha returns the repo's current HEAD commit, advancing on a new commit", () => {
    const first = svc.headSha(repo)
    // 40-char SHA matching git's own rev-parse.
    expect(first).toMatch(/^[0-9a-f]{40}$/)
    expect(first).toBe(git(repo, "rev-parse", "HEAD"))
    // A second commit moves HEAD; headSha tracks it.
    writeFileSync(join(repo, "more.txt"), "more\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "second commit")
    const second = svc.headSha(repo)
    expect(second).toBe(git(repo, "rev-parse", "HEAD"))
    expect(second).not.toBe(first)
  })

  it("headSha returns null on a non-repo path (wrapped, never throws)", () => {
    const bogus = join(tmpdir(), "definitely-not-a-repo-headsha-xyz")
    expect(svc.headSha(bogus)).toBeNull()
  })

  it("never throws on a bad repo path (wrapped): returns safe falsy results", () => {
    const bogus = join(tmpdir(), "definitely-not-a-repo-xyz-123")
    expect(svc.isGitRepo(bogus)).toBe(false)
    expect(svc.list(bogus)).toEqual([])
    expect(svc.diff(bogus, "main")).toBe("")
    expect(svc.create({ repoCwd: bogus, branch: "b", base: "main", path: join(bogus, "wt") })).toBeNull()
    expect(svc.commitAll(bogus, "msg").ok).toBe(false)
    expect(svc.merge({ repoCwd: bogus, branch: "b" }).ok).toBe(false)
    expect(svc.reapOrphans(bogus, []).removed).toEqual([])
  })
})
