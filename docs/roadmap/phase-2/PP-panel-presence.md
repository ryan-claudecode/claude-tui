# PP — Panel presence in the main window (+ live-refresh fix)

- **Phase:** 2 (last feature) · **Depends on:** — · **Worktree: yes** · **Model: Sonnet** · **Size:** S–M
- **Why** ([identity](../00-identity.md), bidirectionality pillar): the original audit flagged
  that panels open *silently* in the companion window with zero indication in the main
  window — "opening a panel doesn't visually feedback in the active window." This closes
  that gap with a presence indicator, and fixes a confirmed live-refresh bug found during WW-2b.

## Current state (verified 2026-06-13)

- The MAIN-window hook `src/hooks/usePanels.ts` ALREADY tracks the open panel list
  (`panels` state, fed by `onPanelShow`/`onPanelUpdate`/`onPanelHide`/`onPanelHideAll` IPC
  — the main window receives these events). It is used only for live-refresh feeding today;
  nothing in the main window DISPLAYS panel presence.
- **Confirmed bug** (`usePanels.ts:74`): the mission-dashboard live-refresh matches
  `\`mission-${x.id}\` === p.id`, but panels get auto-generated `panel-N` ids, so it NEVER
  matches → the open mission dashboard doesn't update live (you must reopen it). The
  overview refresh (line ~98, `p.id.startsWith("overview-")`) likely shares the same
  id-scheme flaw — verify and fix consistently.
- `CompanionService` (`electron/services/companion.ts`) owns the companion BrowserWindow
  (has `focusIfOpen()` from the AQ fix). Main↔companion IPC precedent exists.

## Scope

1. **Presence indicator (main window).** Surface `usePanels().panels` in the main window:
   a small, quiet indicator (in the TabBar, near the window controls — match that area's
   style + `-webkit-app-region: no-drag`). Shows the open-panel count (e.g. a panel glyph +
   "N"); hidden when zero. It briefly pulses/highlights when a panel opens or its props
   update (drive off a short-lived "recently changed" flag in usePanels — set on
   show/update, cleared ~1.2s later). Clicking it raises the companion window.
   - Raise path: new IPC `companion:focus` → `CompanionService.focusIfOpen()` (already
     exists). Add the preload accessor + Window.api type. If no panels are open, the
     indicator is hidden so there's nothing to click.
2. **Fix the live-refresh id matching.** Change the mission match to props-identity:
   `liveMissions.find((x) => x.id === (p.props as { id?: string })?.id)` (a mission panel's
   props IS the mission, so `props.id` is the mission id) — independent of the panel id
   scheme. Apply the analogous props-based fix to the overview refresh if it has the same
   flaw (match the overview panel by its `props` session id rather than an `overview-` id
   prefix). Add/adjust a test if a pure helper is extracted; otherwise verify by reasoning
   and state it in the report.
3. **CLAUDE.md** — one line under the Panel System section noting the main-window presence
   indicator + the props-based live-refresh matching.

## Non-goals (explicitly deferred)

- **Panel state PERSISTENCE across restarts is OUT OF SCOPE** — it has real design surface
  (which panel types survive a restart; forms are pending-promise-bound and can't; stale
  diffs/overviews need a refresh policy) that wants the user's input. Leave a note in the
  roadmap as a follow-up. Do NOT implement persistence here.
- No companion-window changes, no new panel types, no badge on individual sessions.

## Acceptance criteria

- `npm run build` + `npm test` green (276 baseline stays green).
- The indicator renders only when panels are open, pulses on open/update, raises the
  companion on click. P0-5 toast-on-error on the new async call.
- The mission dashboard live-refresh now matches via props (state this fix in the report
  with the before/after line).
- Commit only changed files by explicit path.

## Mandatory base check (stale-base quirk recurs)

`git rev-parse HEAD` vs `git rev-parse main`; if different `git reset --hard main`; confirm
HEAD ≥ `c89a977` and `npm test` = 18 files / 276 tests BEFORE editing. Stop+report if wrong.

## Safety

Never kill a process you didn't launch+record. Don't launch the app or claude CLI.
