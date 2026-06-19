# MS-2 — Missions sidebar section + de-polling (renderer)

- **Phase:** 2 · **Spec:** [missions-surface-design.md](./missions-surface-design.md) (read FIRST) · **Depends on:** MS-1 (merged) · **Worktree:** yes · **Size:** M (~half day)

## Current state (to verify when picked up — MS-1 will have landed)

- `mission:updated` snapshots push from main; `attention:seen-mission` IPC handler
  exists; `AttentionEntry.missionId?` populated for mission entries.
- The 3s mission poll lives in `src/hooks/usePanels.ts` (it exposes `missions` to App;
  `MissionsList.tsx` just renders what it's given — verify and remove the poll at its
  actual location). Sidebar/attention-row/theme-token patterns from AQ-2 are the
  precedents to mirror.

## Scope

1. **`src/hooks/useMissions.ts`** — P1-4 pattern: seeds with one `listMissions()` on
   mount, then maintains state from `mission:updated`/(`mission:removed` if MS-1 added
   it); renderer-side dismissed-ids Set (terminal-state rows only; lost on reload —
   acceptable per spec); exposes `{ missions, visible, dismiss }` where `visible`
   applies the spec's section-scope rule (active always; done/blocked/stopped until
   dismissed).
2. **Preload + types** — `onMissionUpdated`, (`onMissionRemoved`), `attentionSeenMission`
   accessors; `Window.api` typing.
3. **Sidebar section** — `MISSIONS (n)` between NEEDS YOU and WORKSPACES, absent when
   `visible` is empty. Two-line rows per spec: goal excerpt + status chip; `done/total
   tasks` + thin progress bar + worker count. Status-chip colors reuse the attention
   tier tokens (running → accent, paused/blocked → `--attn-2`, done → `--attn-3`).
   Primary click → open the mission dashboard panel (same call MissionsList uses) and
   fire `attentionSeenMission(missionId)`. Secondary icon (visible on hover) → focus the
   Conductor's session (`conductorSessionId`; hide the icon when unset). Hover × on
   terminal-state rows → dismiss. Header `+` → open the existing MissionPrompt overlay.
4. **De-poll** — remove the 3s mission `setInterval`; `MissionsList` + the mission
   dashboard live-refresh consume `useMissions` data instead. No behavior change other
   than freshness.
5. **Attention jump routing** — attention rows carrying `missionId` route `jumpTo` to
   the dashboard panel (+ `attentionSeenMission`) instead of terminal focus (branch in
   the `focusEntry` path in `App.tsx`).
6. **Docs** — CLAUDE.md: missions-surface paragraph under the Mission orchestration
   section; pure helpers (goal excerpt, progress derivation) extracted to
   `src/lib/missionRow.ts` with tests (sessionRow precedent).

## Non-goals

- No MissionService/AttentionService changes (MS-1 owns those; report bugs, don't fix).
- No new mission actions in the sidebar (pause/stop stay in MissionsList/dashboard).
- No OS notifications.

## Acceptance criteria

- `npm run build` + `npm test` green; `missionRow` helper tests included.
- Zero remaining mission polling intervals (grep `setInterval` across `src/`).
- The P0-5 toast-on-error pattern on all new async calls.
- Manual smoke list in report (pending verification): create mission → row appears live;
  pause/resume reflected without reopening; click row → dashboard; hover icon → conductor;
  dismiss a done mission; `+` opens prompt; all three themes.
- Commit only files changed, by explicit path.

## Files

- Create: `src/hooks/useMissions.ts`, `src/lib/missionRow.ts`, `src/lib/missionRow.test.ts`
- Modify: `electron/preload.ts`, `src/App.tsx`, `src/hooks/usePanels.ts`,
  `src/components/Sidebar.tsx`, `src/components/MissionsList.tsx`, `src/App.css`, `CLAUDE.md`
