# Worktree-Isolated Workers + Diff-Review Merge — Design Spec

> Phase 2, feature 3. Authored 2026-06-13 during the autonomous run (no live brainstorm —
> built safe-by-construction; every decision documented for your review). Serves the
> identity thesis ([00-identity.md](../00-identity.md)): orchestration that's safe at
> scale + agents whose work you review through the app, not a raw terminal.

## Problem

Mission workers spawn in the shared mission cwd. Parallel workers editing the same tree
collide — the exact hazard recorded in the user's own memory ("`git add -A` can grab
another agent's WIP"). And there's no in-app way to review what a worker did before its
work lands: the Conductor commits, and you find out after. This blocks safe parallel
dispatch and undercuts the "review agents through the app" pillar.

## Design principles (why this is safe to build unattended)

- **Opt-in.** Worktree isolation is a per-mission flag, default OFF. Existing mission
  behavior is byte-identical unless explicitly enabled. I'm adding a capability, not
  changing the default flow — a wrong UX guess costs nothing because the feature is off.
- **Review-gated.** When enabled, a worker's diff is ALWAYS presented for review before it
  merges. Approve → merge; reject → discard the worktree. Nothing lands unseen.
- **Non-auto-resolving.** A merge conflict is surfaced (notification + the worktree/branch
  preserved + task flagged), never auto-resolved. The user/Conductor resolves manually.

## Decisions

1. **Worktree per task.** On dispatch (when isolation is on), create a git worktree for
   the task at `<missionCwd>/.claude-tui/worktrees/<missionId>/<taskId>` on branch
   `claudetui/mission/<missionShortId>/<taskShortId>`, based on the mission cwd's current
   HEAD at dispatch time. Sequential tasks that merge build on each other; parallel tasks
   share the dispatch-time base and may conflict at merge (surfaced, not resolved). The
   worker spawns with that worktree path as its cwd.
2. **Review on resolve.** When the Conductor calls `mission_resolve(...,"done")` for an
   isolated task, instead of immediately finishing: capture the worktree's combined diff
   (`git diff <base>...HEAD` plus uncommitted changes the worker left), set the task to a
   new `awaiting-review` status, and raise an attention-queue tier-1 entry +
   `show_panel` a **worktree review panel** (reuses `DiffPanel`, adds Approve / Reject
   actions). The task does not count as `done` until approved.
3. **Approve / Reject.**
   - Approve → merge the task branch into the mission cwd's working branch
     (`git merge --no-ff`). Clean → task `done`, worktree removed. Conflict → task
     `merge-conflict`, worktree + branch preserved, notification raised, surfaced in the
     mission dashboard; no auto-resolution.
   - Reject (optional reason) → discard: remove the worktree, delete the branch, set task
     back to `pending` (re-dispatchable) with the rejection reason recorded in the
     mission event log.
4. **Worktree commit hygiene.** Workers may leave uncommitted changes. At review-capture,
   auto-commit the worktree's working tree to its branch (`git add -A` is SAFE here — the
   worktree is the task's private tree, the whole point of isolation) with a
   `wip: <task title>` message, so the diff and merge are well-defined.
5. **Cleanup.** Worktree removal uses the junction-safe Windows pattern
   (`rmdir` the dir, then `git worktree prune`). On mission stop/finish, all of the
   mission's worktrees and branches are cleaned up. Orphaned worktrees from a crashed run
   are reaped on next mission load (best-effort, logged).
6. **Config / surface.** `mission_create` / `mission_plan` gain an optional
   `isolate_workers?: boolean`. The mission dashboard shows per-task worktree status
   (isolated / awaiting-review / merge-conflict). No global default change.

## Components

### WW-1 — `WorktreeService` (`electron/services/worktree.ts`)

Pure git-worktree primitives over a repo dir, fully unit-testable against a real temp git
repo (these are deterministic git ops — the most testable kind). Injected `runGit(args,
cwd)` seam (default: real `child_process` git) so tests can use a real throwaway repo and
production uses the system git. API:
- `create({ repoCwd, branch, base, path }): { path, branch }` — `git worktree add -b`.
- `commitAll(worktreePath, message): void` — `git add -A && git commit` (safe: private tree).
- `diff(worktreePath, base): string` — combined diff vs base.
- `merge({ repoCwd, branch }): { ok: true } | { ok: false, conflict: string }` —
  `git merge --no-ff`; on conflict, abort (`git merge --abort`) and return the conflict
  summary (preserving the branch for manual handling).
- `remove({ repoCwd, path, branch? }): void` — junction-safe worktree removal + optional
  branch delete + prune.
- `list(repoCwd): WorktreeInfo[]` and `reapOrphans(repoCwd, keepBranches): void`.

Tests: against a real temp repo created in the test (init, commit, branch, worktree add,
edit, commit, diff, clean merge, conflicting merge → abort+report, remove+prune). Hermetic
(temp dir, no network, no app, no real mission). This is the whole of WW-1 — no mission
coupling.

### WW-2 — Mission integration + review/merge UX

- `Mission.isolateWorkers?: boolean`; `MissionTask.status` gains `awaiting-review` and
  `merge-conflict`; `MissionTask.worktreePath?`/`branch?`/`diff?`.
- `MissionService.dispatch`: when `isolateWorkers`, create the worktree (via WorktreeService)
  and spawn the worker with the worktree path as cwd (instead of `m.cwd`).
- `MissionService.resolve(...,"done")`: when isolated, `commitAll` + capture `diff`, set
  `awaiting-review`, emit an attention tier-1 entry routed to a worktree review panel,
  and return WITHOUT finishing the task. New methods `approveTask(missionId, taskId)` and
  `rejectTask(missionId, taskId, reason?)` perform the merge/discard per Decision 3.
- MCP: `mission_review_queue` (list awaiting-review tasks + their diffs),
  `mission_approve_task`, `mission_reject_task`; `isolate_workers` on create/plan. The
  Conductor's seed prompt gains a line about the review gate for isolated missions.
- Renderer: a `worktree-review` panel (DiffPanel + Approve/Reject buttons that call the
  new IPC → MCP-less direct service path); the mission dashboard shows per-task status.
  Attention entries for awaiting-review route their jump to the review panel.

## Error handling

- Every WorktreeService op is wrapped; a git failure returns a structured error (never
  throws into the supervisor loop). Worktree creation failure aborts that dispatch with a
  logged mission event and leaves the task `pending`.
- Merge conflicts are a normal outcome, not an error — surfaced per Decision 3.
- If the mission cwd isn't a git repo, `isolate_workers` is refused at create/plan with a
  clear message (isolation requires git).

## Testing

- WW-1: full WorktreeService suite against a temp repo (above).
- WW-2: mission.test.ts with a fake WorktreeService — dispatch-creates-worktree,
  resolve→awaiting-review (not done), approve→done (clean) / merge-conflict path,
  reject→pending+cleanup, non-isolated path unchanged (regression). attention.test.ts:
  awaiting-review enqueues tier-1 routed to review.
- UI: manual smoke (pending user verification).

## Delivery

| Item | Scope | Model | Depends on |
|------|-------|-------|-----------|
| WW-1 | `WorktreeService` + full temp-repo test suite | Opus | — (✅ `201bb5f`) |
| WW-2a | Mission backend: worktree lifecycle, review/merge logic, MCP, attention review entries, tests (fake WorktreeService) | Opus | WW-1 |
| WW-2b | Review UX: `worktree-review` panel, companion approve/reject IPC, attention jump routing, dashboard per-task status | Opus | WW-2a |

## Out of scope (v1)

- Auto-merge for hands-off missions (always review-gated in v1), rebase-instead-of-merge,
  cross-task dependency ordering, conflict resolution UI (conflicts surface for manual
  handling), worktree isolation for non-mission sessions, partial-hunk approval.
