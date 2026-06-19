# WW-1 — WorktreeService (git worktree primitives)

- **Phase:** 2 · **Spec:** [worktree-workers-design.md](./worktree-workers-design.md) (read FIRST — authority) · **Depends on:** — · **Worktree: yes** · **Model: Opus** · **Size:** M

## Current state (verified 2026-06-13)

- No worktree code exists in `electron/`. Mission workers spawn via
  `SessionDriver.create(name, cwd)` in the shared mission cwd (`mission.ts:232`).
- The repo's own dev flow uses git worktrees under `.claude/worktrees/` with junction
  `node_modules` — Windows cleanup needs `rmdir` the dir then `git worktree prune` (a
  plain `git worktree remove` can hit "file in use" on Windows). Mirror that.
- `electron/services/git.ts` exists (read-only git via a runner) — look at how it invokes
  git for the runner style to match, but WW-1 is a NEW service, not an extension of it.

## Scope — build ONLY `WorktreeService`, no mission coupling

`electron/services/worktree.ts` exporting `WorktreeService` with an injected
`runGit(args: string[], cwd: string) => { code: number; stdout: string; stderr: string }`
seam (default: real synchronous git via `child_process.spawnSync("git", args, { cwd })`;
tests inject a real temp-repo-backed runner OR use the real default against a temp repo).

Methods (all wrapped — never throw into a caller; return structured results):
- `create({ repoCwd, branch, base, path }): { path: string; branch: string }` —
  `git -C <repoCwd> worktree add -b <branch> <path> <base>`.
- `commitAll(worktreePath, message): { ok: boolean }` — `git -C <wt> add -A` then
  `git -C <wt> commit -m <message>`; ok:false (no error) when there's nothing to commit.
- `diff(worktreePath, base): string` — `git -C <wt> diff <base>...HEAD` (empty string if none).
- `merge({ repoCwd, branch }): { ok: true } | { ok: false; conflict: string }` —
  `git -C <repoCwd> merge --no-ff <branch>`; on non-zero, capture the conflict summary,
  run `git -C <repoCwd> merge --abort`, return `{ ok:false, conflict }` (branch preserved).
- `remove({ repoCwd, path, deleteBranch? }): { ok: boolean }` — junction-safe: best-effort
  `git worktree remove --force`, then if the dir still exists remove it directly, then
  `git -C <repoCwd> worktree prune`, then optionally `git branch -D <branch>`.
- `list(repoCwd): { path: string; branch: string }[]` — parse `git worktree list --porcelain`.
- `reapOrphans(repoCwd, keepBranches: string[]): { removed: string[] }` — remove
  claudetui-managed worktrees (path under `.claude-tui/worktrees/`) whose branch isn't in
  `keepBranches`. Logged, best-effort.
- `isGitRepo(cwd): boolean` — `git -C <cwd> rev-parse --is-inside-work-tree`.

## Non-goals

- NO mission.ts / terminals.ts / MCP / renderer changes (WW-2 owns all integration).
- No async/streaming git; spawnSync is fine (these are fast local ops).
- No partial-hunk logic, no rebase, no conflict resolution.

## Acceptance criteria

- `electron/services/worktree.test.ts` runs against a REAL throwaway git repo created in a
  temp dir in the test (`mkdtempSync`), exercising: init→commit→`create`→edit→`commitAll`→
  `diff` (non-empty), clean `merge` (ok), a deliberately conflicting branch → `merge`
  returns `{ok:false, conflict}` AND leaves the repo unmerged (verify `git status` clean
  of merge state, branch still exists), `remove`+prune drops it from `list`, `reapOrphans`
  respects `keepBranches`, `isGitRepo` true/false. Set a git identity in the temp repo
  (`git config user.email/name`) so commits work in CI-less envs.
- Hermetic: temp dirs only, NO writes outside them, no network, no app, no real mission,
  no real `~/.claude-tui`. Clean up temp repos in `afterEach`/`afterAll`.
- `npm run build` + `npm test` green (the suite grows; existing 203 stay green).
- Commit only `electron/services/worktree.ts` + `electron/services/worktree.test.ts` by
  explicit path.

## Mandatory base check (stale-base quirk recurs)

Before editing: `git rev-parse HEAD` vs `git rev-parse main`; if different
`git reset --hard main`; confirm HEAD ≥ `471df08` and `npm test` shows 14 files / 203
tests BEFORE changing anything. Stop and report if the base is wrong.

## Safety

Never kill a process you didn't launch+record. Don't launch the app or claude CLI.
