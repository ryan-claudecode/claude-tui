# MS-1 — Mission event seam + attention integration (main process)

- **Phase:** 2 · **Spec:** [missions-surface-design.md](./missions-surface-design.md) (read FIRST — authority on semantics) · **Depends on:** — · **Worktree:** yes · **Size:** M (~half day)

## Current state (verified 2026-06-11)

- `electron/services/mission.ts` — NO event seam; the renderer polls. `persist(m)` (line
  ~121) is the mutation choke point (create/plan/dispatch/resolve/pause/resume/stop all
  route through it). `Mission.conductorSessionId?: string` (line ~47). Missions are
  never deleted (verify — if true, emit only `updated`).
- `electron/services/attention.ts` — entry machinery from AQ-1: tiers, replace/upgrade
  rules, `dismiss`, snapshots. Entries are keyed per terminal or session; no mission
  awareness. `AttentionEntry` has no `missionId`.
- `electron/ipc.ts` — constructs both services; AttentionService deps injected there.

## Scope

1. **Event seam on MissionService** — callback-set `onEvent(cb)` (TerminalService
   style), emitting `{ type: "updated", mission }` from `persist()`. Wire renderer push
   in `ipc.ts`: `mission:updated` (full Mission snapshot). If a delete path exists, add
   `{ type: "removed", id }` + `mission:removed`; if not, note it and skip.
2. **Attention integration** — AttentionService subscribes (injected, fake-able):
   - Tracks last-seen status per mission. FIRST sight (incl. app-start load) seeds
     SILENTLY. Only live transitions enqueue:
     → `paused` = tier 2 (`Mission paused — waiting`), → `blocked` = tier 2
     (`Mission blocked — tasks failed`), → `done` = tier 3 (`Mission finished`).
   - Entry key `mission:<id>`, optional `missionId` field added to `AttentionEntry`,
     same replace/upgrade rules.
   - Cleared on: dismiss, transition back to `running`, and a new
     `seenMission(missionId)` method (tier-2/3 clear; expose alongside `seen`). Add the
     matching IPC handler (`attention:seen-mission`) in `electron/ipc/attention-handlers.ts`
     so MS-2 only needs the preload accessor.
3. **Tests** — mission.test.ts: seam emits on each persist-routed mutation.
   attention.test.ts: transition matrix, silent seeding, resume-clears, seenMission,
   keying/dismiss, and that mission entries NEVER fire OS notifications (tier-2/3
   policy holds).

## Non-goals

- NO renderer/preload changes beyond the IPC handler noted above (MS-2 owns the hook,
  Sidebar, MissionsList de-polling, jump routing).
- No mission-service behavior changes (supervisor loop, dispatch logic untouched).
- No tier-1 mission entries — checkpoint forms already cover that path.

## Acceptance criteria

- `npm run build` + `npm test` green; suite stays hermetic (fakes only).
- Mission mutations each produce exactly one `updated` emission (no double-fire from
  nested persists — verify by test).
- Commit only files changed, by explicit path.

## Files

- Modify: `electron/services/mission.ts`, `electron/services/mission.test.ts`,
  `electron/services/attention.ts`, `electron/services/attention.test.ts`,
  `electron/ipc.ts`, `electron/ipc/attention-handlers.ts`
