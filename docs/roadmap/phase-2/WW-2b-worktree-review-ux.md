# WW-2b — Worktree review UX (panel + approve/reject + dashboard)

- **Phase:** 2 · **Spec:** [worktree-workers-design.md](./worktree-workers-design.md) · **Depends on:** WW-2a (✅ `1770af4`) · **Worktree: yes** · **Model: Opus** · **Size:** M
- **Why:** WW-2a made isolated missions fully driveable via MCP and surfaced awaiting-review
  tasks into the attention queue — but those attention entries have NO jump target and there's
  no in-app way to see the diff and approve/reject. This is the user-facing half.

## Current state (verified 2026-06-13, post-WW-2a)

- Backend (WW-2a, all on `electron/`): `MissionService.approveTask`/`rejectTask`/`reviewQueue`;
  `MissionTask` carries `status:"awaiting-review"|"merge-conflict"`, `diff`, `reviewReason`,
  `worktreePath`, `branch`. AttentionService emits tier-1 entries keyed
  `review:<missionId>:<taskId>` carrying `missionId` + `taskId` (a real field on
  `AttentionEntry`). These entries currently have no renderer jump handler.
- `electron/mcp/tools/panels.ts` line ~23: the `show_panel` type `z.enum([...])`.
- `src/companion/CompanionApp.tsx`: `PanelContent` switch routes panel types
  (`case "diff": return <DiffPanel .../>`, `case "mission": ...`, etc.).
- `src/components/panels/DiffPanel.tsx`: renders a diff (takes `files` + `onSend`); REUSE it.
- The mission dashboard panel component (find it — likely `src/components/panels/MissionPanel.tsx`
  or similar, routed as `case "mission"`); it renders tasks — add per-task review status.
- Companion→main IPC precedent: MS-2 added `companion:mission-*` handlers (find them in
  `electron/ipc/panel-handlers.ts`); mirror that for approve/reject. Form submit
  (`panel:form-submit`) is the closest "companion button → main action" precedent.
- `src/hooks/useAttention.ts` + `src/App.tsx`: `jumpTo` routes mission entries (with
  `missionId`) to the dashboard via `jumpToMissionRef` (MS-2). Review entries (with
  `taskId`) need a new route → open the worktree-review panel.

## Scope

1. **`worktree-review` panel type** — add `"worktree-review"` to the `show_panel` enum
   (`tools/panels.ts`) and a `case "worktree-review"` in `CompanionApp.tsx`'s `PanelContent`.
   New component `src/components/panels/WorktreeReviewPanel.tsx`: props
   `{ missionId, taskId, title, diff, reviewReason? }`. Renders the diff (reuse DiffPanel's
   rendering — feed it the captured `diff` string; if DiffPanel needs `files[]`, adapt by
   parsing or pass a single synthetic file entry — match DiffPanel's actual prop shape),
   plus **Approve** and **Reject** buttons (Reject opens a small inline reason input).
   When `reviewReason` is set and status is merge-conflict, show the conflict summary
   prominently with a note that the branch is preserved for manual resolution.
2. **Approve/Reject wiring** — buttons call new preload accessors
   `approveWorktreeTask(missionId, taskId)` / `rejectWorktreeTask(missionId, taskId, reason?)`
   → new IPC channels (`worktree:approve` / `worktree:reject`) handled in
   `electron/ipc/panel-handlers.ts` (or mission-handlers) → `MissionService.approveTask`/
   `rejectTask`. After the call, the panel reflects the result (merged → close/hide;
   conflict → show the conflict state). The mission event seam already repaints the
   dashboard + clears/keeps the attention entry, so no manual refresh needed.
3. **Attention jump routing** — in the `useAttention`/`App.tsx` jump path, an entry with a
   `taskId` opens the worktree-review panel for that `missionId`+`taskId` (load the task's
   diff via a new `getReviewTask(missionId, taskId)` IPC → `MissionService` lookup, or pass
   the diff through the attention entry — prefer an IPC fetch so the panel always has the
   latest diff). Reuse the `jumpToMissionRef` pattern (add a `jumpToReviewRef`).
4. **Mission dashboard per-task status** — in the mission dashboard panel, show
   `awaiting-review` and `merge-conflict` task states distinctly (a small chip/label using
   the attention tier tokens — amber for review-needed, red-ish for conflict), so the
   dashboard reflects the review state at a glance.
5. **MCP `show_panel` doc** — note the new `worktree-review` type in CLAUDE.md's panel list
   and add a short "Worktree review" paragraph under the mission section.

## Non-goals

- No backend/policy changes (WW-2a is frozen — report bugs, don't fix). No partial-hunk
  approval, no conflict-resolution UI (conflicts just display + preserve the branch). No
  changes to non-isolated mission rendering.

## Acceptance criteria

- `npm run build` + `npm test` green (253 baseline stays green). Any pure view helper you
  extract gets a small test.
- The P0-5 toast-on-error pattern on the new async approve/reject calls.
- Manual smoke (pending user verification, list in report): run an isolated mission → a
  task resolves → tier-1 review entry appears → clicking it opens the review panel with the
  diff → Approve merges (clean) or shows the conflict → Reject sends it back; dashboard
  shows awaiting-review/merge-conflict chips.
- Commit only changed files by explicit path.

## Mandatory base check (stale-base quirk recurs)

`git rev-parse HEAD` vs `git rev-parse main`; if different `git reset --hard main`; confirm
HEAD includes `1770af4` (WW-2a) AND the merged MAC commit, and `npm test` is green BEFORE
editing. Stop+report if WW-2a isn't in the base.

## Safety

Never kill a process you didn't launch+record. Don't launch the app or claude CLI.
