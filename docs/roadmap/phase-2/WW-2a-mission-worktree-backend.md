# WW-2a — Mission worktree backend: lifecycle + review/merge + MCP

- **Phase:** 2 · **Spec:** [worktree-workers-design.md](./worktree-workers-design.md) (read FIRST — authority) · **Depends on:** WW-1 (✅ `201bb5f`) · **Worktree: yes** · **Model: Opus** · **Size:** L
- Backend only — NO renderer/panel UI (WW-2b owns that). When this lands, an isolated
  mission's flow is fully driveable via MCP tools; the panel just makes it pretty.

## Current state (verified 2026-06-13, post-ST-1)

- `electron/services/worktree.ts` — `WorktreeService` (WW-1) with create/commitAll/diff/
  merge/remove/list/reapOrphans/isGitRepo. `create` returns `{path,branch}|null`;
  `merge` returns `{ok:true}|{ok:false,conflict}`.
- `electron/services/mission.ts`:
  - `MissionService` ctor: `constructor(private sessions: SessionDriver, opts: MissionServiceOpts = {})`.
  - `dispatch` (line ~224): spawns a worker via `this.sessions.create(name, m.cwd)` in the
    SHARED mission cwd. This is where isolation hooks in.
  - `await` (line ~252): sets task `review` on idle.
  - `resolve(missionId, taskId, "done"|"failed", result?)` (line ~270): sets task status,
    recomputes mission status. This is where the "done" path forks for isolated tasks.
  - `persist(m)` emits the MS-1 `{type:"updated",mission}` event seam.
  - Types: `MissionStatus`, `TaskStatus = "pending"|"assigned"|"in-progress"|"review"|"done"|"failed"`,
    `Mission` (has `conductorSessionId?`, `tasks`, `workers`), `MissionTask`.
- `electron/services/attention.ts`: `onMissionEvent` (line ~305) drives mission-status
  entries keyed `mission:<id>`; `seenMission`, `upsert`, `kind: "mission"`. Review entries
  are TASK-level (a mission stays `running`), so they need a NEW signal, not the status path.
- MCP mission tools live in `electron/mcp/tools/missions.ts`; `SERVER_INSTRUCTIONS` in `server.ts`.

## Scope

### Types (`mission.ts`)
- `Mission.isolateWorkers?: boolean`.
- `MissionTask.status` adds `"awaiting-review"` and `"merge-conflict"`.
- `MissionTask` adds `worktreePath?: string`, `branch?: string`, `diff?: string`,
  `reviewReason?: string`.

### WorktreeService injection
- `MissionServiceOpts.worktree?: WorktreeLike` (default: `new WorktreeService()`); define a
  `WorktreeLike` interface = the slice mission uses (create/commitAll/diff/merge/remove/
  reapOrphans/isGitRepo). Tests inject a fake.

### Lifecycle
- **create/plan:** accept `isolateWorkers`. If set true AND `!worktree.isGitRepo(m.cwd)`,
  refuse with a clear error (isolation needs git) — do NOT silently downgrade.
- **dispatch:** when `m.isolateWorkers`, before spawning: `worktree.create({ repoCwd:m.cwd,
  branch:\`claudetui/mission/${shortId}/${taskShortId}\`, base:"HEAD", path:join(m.cwd,
  ".claude-tui","worktrees",m.id,task.id) })`. On null (git failure): log a mission event,
  leave task `pending`, return undefined (no worker spawned). On success: store
  `task.worktreePath`/`task.branch`, spawn the worker with the WORKTREE PATH as cwd
  (`this.sessions.create(name, task.worktreePath)`).
- **resolve(...,"done") when the task has a worktreePath:** do NOT finish. Instead:
  `worktree.commitAll(task.worktreePath, \`wip: ${task.title}\`)`, capture
  `task.diff = worktree.diff(task.worktreePath, baseRef)` (baseRef = the branch's merge-base
  with the mission branch; simplest correct: capture the diff vs the dispatch-time base —
  store `task.baseRef` at dispatch as the then-current `git rev-parse HEAD` of m.cwd via a
  worktree.revParse or reuse list; if a revParse helper is missing, add a tiny
  `worktree.headSha(cwd)` to WorktreeService in THIS item and test it). Set
  `task.status="awaiting-review"`, fire the attention review signal (below), persist,
  return the mission WITHOUT marking done or recomputing completion.
- **resolve(...,"failed") when isolated:** discard the worktree (`worktree.remove({repoCwd,
  path,deleteBranch:true})`) then proceed as the normal failed path.
- **approveTask(missionId, taskId):** `worktree.merge({repoCwd:m.cwd, branch:task.branch})`.
  Clean → remove worktree (keep nothing), set task `done`, recompute mission completion
  (the existing resolve-tail logic — factor it into a private `recomputeCompletion(m)` and
  call from both resolve and approveTask). Conflict → set task `merge-conflict`, store the
  conflict summary in `task.reviewReason`, KEEP the worktree+branch, `notify` + log, persist.
- **rejectTask(missionId, taskId, reason?):** discard worktree+branch, set task back to
  `pending` (re-dispatchable), record reason in the event log, persist.
- **stop/finish:** remove ALL of the mission's worktrees+branches (iterate tasks with a
  worktreePath). On `loadAll`, after loading, best-effort `worktree.reapOrphans(m.cwd,
  keepBranches=<live task branches>)` per mission that isGitRepo — logged, never throws.

### Attention review signal (`attention.ts`)
- Add `requestReview(missionId, taskId, title)` → enqueues a tier-1 entry keyed
  `review:<missionId>:<taskId>`, `kind:"mission"`, carries `missionId` + a new
  `taskId?` field, reason `Review: <title>`. Cleared by a new
  `seenReview(missionId, taskId)` and on the task leaving awaiting-review (MissionService
  calls an injected `onReviewResolved(missionId,taskId)` hook, OR — simpler — attention
  subscribes to the mission event seam and clears `review:*` entries for tasks no longer
  `awaiting-review`). Pick the seam-subscription approach (no new coupling): in
  `onMissionEvent`, after handling status, reconcile review entries against the mission's
  current awaiting-review tasks (add missing, drop resolved). This keeps attention as a
  pure subscriber. MissionService does NOT call attention directly.

### MCP (`tools/missions.ts`)
- `isolate_workers?: boolean` on `mission_create` and `mission_plan`.
- `mission_review_queue` — list awaiting-review tasks (missionId, taskId, title, diff).
- `mission_approve_task(mission_id, task_id)` / `mission_reject_task(mission_id, task_id, reason?)`.
- Conductor seed prompt (the string in mission.ts that seeds a Conductor): add one line —
  for isolated missions, completed tasks enter review; call mission_review_queue and
  approve/reject. One SERVER_INSTRUCTIONS line.

## Non-goals

- NO panel/renderer/companion/IPC-to-renderer changes (WW-2b). The attention entry will
  have no jump target yet — that's fine; WW-2b wires it.
- No auto-merge, no rebase, no conflict-resolution logic (conflicts just surface).
- Do not change non-isolated mission behavior at all (regression-test it).

## Acceptance criteria

- `mission.test.ts` with a FAKE WorktreeService (scripted results): non-isolated path
  unchanged (regression); isolated dispatch creates a worktree + spawns into it;
  resolve-done → awaiting-review (NOT done, mission not complete); approveTask clean →
  done + completion recompute + worktree removed; approveTask conflict → merge-conflict +
  worktree kept + notify; rejectTask → pending + worktree removed; stop removes all
  worktrees; create with isolate on a non-git cwd is refused.
- `attention.test.ts`: awaiting-review task → tier-1 `review:*` entry; leaving
  awaiting-review clears it; multiple tasks → multiple entries.
- If you add `worktree.headSha`, unit-test it in `worktree.test.ts` against the temp repo.
- Hermetic (fakes; real git only in worktree.test.ts). `npm run build` + `npm test` green
  (219 baseline stays green).
- Commit only changed files by explicit path.

## Mandatory base check

`git rev-parse HEAD` vs `git rev-parse main`; if different `git reset --hard main`; confirm
HEAD ≥ `1c94ca0` and `npm test` = 15 files / 219 tests BEFORE editing. Stop+report if wrong.

## Safety

Never kill a process you didn't launch+record. Don't launch the app or claude CLI.
