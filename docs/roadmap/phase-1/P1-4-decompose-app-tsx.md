# P1-4 — Decompose App.tsx into hooks

- **Phase:** 1 · **Depends on:** none · **Worktree:** yes · **Size:** M (~half day)
- **Why:** `src/App.tsx` (~770 lines after P0-5) holds 16+ pieces of state, a ~100-line
  mount effect registering 13 IPC listeners, and ref-sync workarounds (`exportLogRef`,
  `refreshOverviewsRef`) that exist only because everything shares one closure scope.
  Every Phase 2 feature (attention queue, missions surface) lands in this file — it must
  be navigable first ([identity doc](../00-identity.md)).

## Current state (verified 2026-06-10, post-Phase-0)

- `src/App.tsx`: state for sessions/activeSessionId/activeTerminalId/workspaces/split
  panes/config/panels/dragActive/paletteOpen/helpOpen/historyOpen/missionPromptOpen/
  missionsListOpen/missions/zenMode/themeMode; one large mount `useEffect` registering
  all `window.api.on*` listeners with a matching `removeAllListeners` cleanup block;
  handlers recently wrapped in try/catch+toast by P0-5 — preserve that pattern exactly.
- No `src/hooks/` directory exists yet.

## Scope (structure decided — implement as written)

Create `src/hooks/` with four hooks, moving state + listeners + handlers out of App.tsx:

1. `useSessions.ts` — sessions, activeSessionId, activeTerminalId, workspaces; the
   session/terminal IPC listeners (`onSessionData`-family, `worksession:updated`,
   `terminal:state`, restore-on-mount logic); the P0-5-wrapped handlers (new/close/kill/
   rename/handoff/select). Returns state + handlers.
2. `useSplitView.ts` — splitLeft/splitRight + toggleSplit (depends on useSessions output;
   pass what it needs as arguments).
3. `useOverlays.ts` — paletteOpen/helpOpen/historyOpen/missionPromptOpen/missionsListOpen/
   zenMode + the `ui:*` event listeners that toggle them (focus mode, palette,
   shortcuts, history search) + missions list state/polling if it lives with the overlay.
4. `useTheme.ts` — themeMode + load-on-mount + setTheme; applies `data-theme` attribute.

Rules:
- **No behavior change.** This is a mechanical extraction; UI and IPC flows stay identical.
- Each hook owns the cleanup for exactly the listeners it registers (split the single
  `removeAllListeners` block accordingly).
- Kill the ref-sync workarounds where extraction makes them unnecessary (a hook can close
  over fresh state); keep one only if a listener genuinely needs a stable identity across
  the app's lifetime — justify any survivor in a comment.
- Keep the `Window.api` type declaration wherever it lives today; don't redesign it.
- Drag-drop, panel-meta tracking, and export-log can stay in App.tsx if they don't fit
  cleanly — the goal is App.tsx as composition root (~250–350 lines), not zero logic.

## Non-goals

- No state library (no zustand/jotai/context refactor).
- No new features, no UX changes, no CSS changes.
- Do NOT touch `src/components/`, `electron/`, or preload.

## Acceptance criteria

- `src/App.tsx` ≤ ~350 lines; hooks individually under ~250 lines.
- `npm run build` and `npm test` pass.
- The P0-5 toast-on-error wrapping survives verbatim in the moved handlers.
- Manual smoke (pending architect verification — list in report): launch, create session,
  switch tabs, split panes, open palette/help/history overlays, switch theme.
- Commit only `src/App.tsx` + new `src/hooks/*` files, staged by explicit path.

## Files

- Create: `src/hooks/useSessions.ts`, `src/hooks/useSplitView.ts`,
  `src/hooks/useOverlays.ts`, `src/hooks/useTheme.ts`
- Modify: `src/App.tsx`
