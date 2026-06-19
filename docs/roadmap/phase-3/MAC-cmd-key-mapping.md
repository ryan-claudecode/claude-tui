# MAC — macOS Cmd-key mapping

- **Phase:** 3 · **Depends on:** — · **Worktree: yes** · **Model: Sonnet** · **Size:** S
- **Why:** every shortcut is hardcoded to `Ctrl` (`e.ctrlKey`). On macOS users expect `Cmd`
  (`e.metaKey`); today Cmd+N does nothing and Ctrl+N is non-idiomatic. Blocks macOS
  shippability (Phase 3). Built BLIND (no mac to test on) — so the change is
  platform-conditional and **provably leaves win32/linux behavior byte-identical**.

## Current state (verified this session)

- The app has NO native menu (`Menu.setApplicationMenu(null)` in `main.ts`) — so there are
  no menu accelerators to remap; this is purely the renderer keydown handler.
- `src/App.tsx` handles shortcuts in a keydown effect using `e.ctrlKey` (Ctrl+N/T/W/K,
  Ctrl+\, Ctrl+1-9, Ctrl+Shift+P/F/Z, Ctrl+/, Ctrl+J, Ctrl+Shift+H). Alt+1-9 uses altKey.
- `src/components/ShortcutsHelp.tsx` displays the shortcut list with literal "Ctrl".
- `electron/preload.ts` exposes `window.api`; renderer has no platform info today.

## Scope

1. **Expose platform** — in `electron/preload.ts`, add `platform: process.platform` to the
   exposed `window.api` (a string: `"darwin"|"win32"|"linux"`). Add it to the `Window.api`
   type in `src/App.tsx`.
2. **`isCmdOrCtrl` helper** — `src/lib/platform.ts`:
   `export const isMac = (platform: string) => platform === "darwin"` and
   `export function cmdOrCtrl(e: KeyboardEvent | React.KeyboardEvent, platform: string): boolean`
   returning `platform === "darwin" ? e.metaKey : e.ctrlKey` (and NOT the other — so Cmd on
   Windows or Ctrl on mac don't double-trigger). Pure, unit-tested.
3. **Apply in App.tsx** — replace each `e.ctrlKey` shortcut check in the keydown handler
   with `cmdOrCtrl(e, platform)` where `platform = window.api.platform`. Leave `altKey`
   (Alt+1-9) and `shiftKey` exactly as-is. CRITICAL: on win32, `cmdOrCtrl` returns exactly
   `e.ctrlKey`, so behavior is IDENTICAL to today — verify by reading the diff: every
   former `e.ctrlKey` becomes `cmdOrCtrl(e, platform)` and nothing else changes.
4. **Display** — `ShortcutsHelp.tsx` shows "Cmd" instead of "Ctrl" when
   `window.api.platform === "darwin"` (a label swap; the chord list is otherwise the same).
   Use a small `modKeyLabel(platform)` returning "Cmd"/"Ctrl".

## Non-goals

- No change to Alt/Shift chords, no native menu, no per-OS shortcut REMAPPING (just the
  modifier key), no electron main.ts changes beyond... none (preload only on the electron side).

## Acceptance criteria

- `src/lib/platform.test.ts`: `cmdOrCtrl` returns ctrlKey on win32/linux, metaKey on darwin,
  and does NOT trigger on the opposite modifier; `modKeyLabel` correct per platform.
- `npm run build` + `npm test` green (222 baseline stays green).
- Diff review self-check (state in report): every win32 code path is behavior-identical to
  pre-change (the only win32 effect of `cmdOrCtrl` is `=== e.ctrlKey`).
- Commit only changed files by explicit path.

## Mandatory base check (stale-base quirk recurs)

`git rev-parse HEAD` vs `git rev-parse main`; if different `git reset --hard main`; confirm
HEAD ≥ `932605d` and `npm test` = 16 files / 222 tests BEFORE editing. Stop+report if wrong.

## Safety

Never kill a process you didn't launch+record. Don't launch the app or claude CLI. Touch
only `electron/preload.ts` (platform expose) + `src/` files — a concurrent agent owns the
rest of `electron/`.
