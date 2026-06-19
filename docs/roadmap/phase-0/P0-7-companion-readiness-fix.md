# P0-7 — Land + test the companion-window readiness fix

- **Phase:** 0 · **Depends on:** none · **Worktree:** NO — this item finishes existing
  uncommitted work already sitting in the main working tree (`git status` shows
  `M electron/services/companion.ts`). Do not start it while any other agent has the main
  tree checked out for edits.
- **Conflicts:** P0-3 also modifies `companion.ts` — serialize (this item first, since it
  owns the in-flight diff).
- **Size:** S (~2 hours, mostly the test)
- **Why:** `sendToCompanion` used to fire `webContents.send` immediately after creating the
  BrowserWindow — events sent before the renderer finished loading were dropped, so the
  first panel of a fresh companion window could silently never render. The fix (queueing
  sends behind a `did-finish-load` promise) is already written but uncommitted and untested.
  Panels are the bidirectionality pillar ([identity doc](../00-identity.md)); their delivery
  must not race.

## Current state (verified 2026-06-10)

- Uncommitted diff in `electron/services/companion.ts`: adds `readyPromise` resolved on
  `webContents.once("did-finish-load")`; `getOrCreate()` returns `{ win, ready }`;
  `sendToCompanion` awaits `ready` (and checks `!win.isDestroyed()`) before sending;
  promise cleared on window `closed`. The diff is correct and well-scoped — review it,
  don't rewrite it.
- `CompanionService` constructs `BrowserWindow` directly, so it has no test seam; there are
  currently no tests for it.
- Note: the file currently has LF endings and git warns it will become CRLF — keep the
  repo's existing line-ending behavior, don't fight it.

## Scope

1. Review the existing diff for the one edge it may miss: `sendToCompanion` called while a
   PREVIOUS window is mid-close (`closed` fired → `this.win = null`) must create a fresh
   window, not send into the void. Confirm `getOrCreate`'s `isDestroyed()` guard covers it.
2. Add a minimal test seam: allow injecting a window factory, e.g. a constructor option or
   internal method
   `protected createWindow(): CompanionWindowLike` where `CompanionWindowLike` is the small
   surface the service uses (`webContents.send`, `webContents.once`, `on`, `show`,
   `isDestroyed`, `loadURL`/`loadFile`, `close`). Production behavior unchanged.
3. Write `electron/services/companion.test.ts` (vitest, fake window object):
   - events sent BEFORE `did-finish-load` fires are delivered exactly once, in order,
     AFTER it fires;
   - events sent after load deliver immediately;
   - events to a destroyed window are dropped without throwing;
   - reopening after `closed` creates a new window and a new ready gate.
4. Commit the result as a `fix:` commit. Commit ONLY `electron/services/companion.ts` and
   the new test file — other files may carry unrelated WIP; never `git add -A`.

## Non-goals

- No sandbox change (P0-3), no companion UX changes, no panel-event protocol changes.
- No refactor of `CompanionService` beyond the injectable factory seam.

## Acceptance criteria

- All four test cases above pass; `npm run build` and `npm test` pass.
- Manual: from a session, `show_panel` a markdown panel while the companion window is
  closed → window opens AND the panel renders on first try (this was the original bug);
  state the check in the commit message.

## Files

- Modify: `electron/services/companion.ts` (existing diff + test seam)
- Create: `electron/services/companion.test.ts`
