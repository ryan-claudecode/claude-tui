# Missions Surface — Design Spec

> Phase 2, feature 2. Brainstormed + approved 2026-06-11. Serves the identity thesis
> ([00-identity.md](../00-identity.md)): orchestration becomes visible, ambient state —
> not a feature hidden behind Ctrl+Shift+P.

## Problem

Missions are the app's most ambitious capability and are nearly invisible: creation and
inspection live only behind command-palette entries, the missions list polls every 3s
while open, and a mission finishing/pausing while the user works elsewhere vanishes
silently.

## Decisions (settled in brainstorm)

1. **Sidebar section** `MISSIONS (n)` between NEEDS YOU and WORKSPACES. Shows active
   missions (planning/running/paused) always; terminal-state missions
   (done/blocked/stopped) linger until dismissed (hover ×).
   **REVISED 2026-06-11 (user feedback):** the section header + `+` button render even
   when empty, with a muted clickable "No missions — start one" row opening the
   MissionPrompt. Hiding the section when idle recreated the original discoverability
   failure — missions are a *capability*, unlike NEEDS YOU which is transient *signal*
   and correctly stays absent-when-empty.
2. **Row content:** two-line. Line 1 — goal excerpt + status chip. Line 2 — task
   progress (`3/7 tasks` + thin progress bar) and worker count.
3. **Row click → mission dashboard panel** in the companion window (the existing
   `mission` panel type). Secondary icon on the row → jump to the Conductor's terminal.
   Header `+` → existing MissionPrompt overlay.
4. **Push, not poll:** `MissionService` gains an event seam; the sidebar AND the
   existing MissionsList overlay consume pushed snapshots; the overlay's 3s polling is
   removed.
5. **Attention integration:** mission status TRANSITIONS feed the attention queue —
   → `paused`/`blocked` enqueue tier-2, → `done` enqueues tier-3. Checkpoint forms
   already enqueue tier-1 via the existing form path; nothing new there.

## Components

### MissionService event seam (`electron/services/mission.ts`)

- Callback-set seam (same style as TerminalService/PanelService):
  `onEvent(cb)` emitting `{ type: "updated", mission }` from the `persist()` choke point
  (every mutation already routes through it) and `{ type: "removed", id }` from any
  delete path (verify whether one exists; if missions are never deleted, emit only
  `updated`).
- Renderer push: wired in `ipc.ts` — `mission:updated` (full mission snapshot) /
  `mission:removed`. Snapshots are the full `Mission` object (it already serializes to
  JSON for disk; tasks/workers/eventLog included — the dashboard panel needs them
  anyway).

### Attention integration (`electron/services/attention.ts`)

- AttentionService subscribes to the mission seam. It tracks each mission's last-seen
  status; on TRANSITION (not on every persist):
  - → `paused`: tier-2, reason `Mission paused — <pause reason if recorded, else "waiting">`
  - → `blocked`: tier-2, reason `Mission blocked — tasks failed`
  - → `done`: tier-3, reason `Mission finished`
- Entry keying: `mission:<missionId>` (session-less, like error entries). One entry per
  mission (same replace/upgrade rules as terminals).
- Cleared on: manual dismiss, the mission transitioning back to `running` (resume), or
  the renderer reporting the dashboard was opened for that mission (reuse `seen`
  semantics: `seenMission(missionId)` clears its tier-2/3 entries).
- These entries' `jumpTo` opens the mission dashboard panel (not a terminal) — the
  attention row carries `missionId` so the renderer can route. Add an optional
  `missionId?: string` to `AttentionEntry`.

### Renderer (`src/hooks/useMissions.ts`, `Sidebar.tsx`, `MissionsList.tsx`)

- `useMissions` (P1-4 pattern): subscribes to `mission:updated`/`mission:removed`,
  seeds initial state with one `listMissions()` call on mount, exposes
  `{ missions, dismissed, dismiss }`. Dismissed terminal-state missions are tracked
  renderer-side (a Set of ids in the hook — no main-process state needed; reappearing
  after reload is acceptable and arguably correct).
- Sidebar: `MISSIONS (n)` section per the decisions; `n` = visible rows. Status-chip
  colors reuse the attention tier tokens (paused/blocked → tier-2 gold, done → tier-3
  sage, running → accent) — no new palette entries unless a gap appears.
- Row primary click → `showPanel("mission", ...)` path already used by MissionsList;
  secondary icon → focus Conductor session (mission records the conductor session id —
  verify the field name in mission.ts; fall back to hiding the icon if no conductor yet).
- `MissionsList.tsx`: replace its 3s `setInterval` polling with `useMissions` data.
- Attention rows with `missionId` route their jump to the dashboard panel (small branch
  in the existing `focusEntry` path).

## Error handling

- Event-seam emission failures are impossible by construction (callback set, no IPC in
  the service); renderer IPC sends guard `isDestroyed()` as everywhere else.
- Attention transition tracking: the first sight of a mission (including all missions
  loaded at app start) seeds the tracker SILENTLY — no enqueue for state that predates
  this app session. Only transitions observed live afterwards enqueue. Stale "mission
  finished 3 days ago" noise on every launch would be worse than missing old news.

## Testing

- mission.test.ts: seam emits on persist-routed mutations (create/plan/dispatch/resolve/
  pause/resume/stop).
- attention.test.ts: mission transitions enqueue per the matrix above; silent seeding on
  first sight; resume clears; `seenMission` clears; keying/dismiss.
- Pure helpers (progress derivation, goal excerpt) get unit tests if extracted.
- UI: manual smoke (pending architect/user verification).

## Delivery

| Item | Scope | Model | Depends on |
|------|-------|-------|-----------|
| MS-1 | Mission event seam + renderer push wiring + attention integration + tests | Opus | — |
| MS-2 | `useMissions` + Sidebar section + MissionsList de-polling + attention-row mission routing + CSS + CLAUDE.md | Sonnet | MS-1 |

## Out of scope (v1)

- Mission deletion UI, mission history browsing, per-task rows in the sidebar, OS
  notifications for mission events (tier-2/3 don't fire them by existing policy),
  Conductor health indicators, persistence of renderer-side dismissals.
