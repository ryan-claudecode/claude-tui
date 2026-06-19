# P0-3 — Enable Chromium sandbox on both windows

- **Phase:** 0 · **Depends on:** none · **Worktree:** yes · **Size:** S (~1–2 hours, mostly verification)
- **Conflicts:** P0-7 also modifies `electron/services/companion.ts` — serialize these two
  items or give them to the same agent.
- **Why:** Both BrowserWindows run with `sandbox: false`. With the sandbox off, a
  compromised renderer (e.g. XSS via agent-rendered panel content — panels render
  arbitrary markdown/HTML-ish props from MCP tools) has a much larger escape surface.
  Neither preload needs Node: both are pure `contextBridge`/`ipcRenderer` wrappers
  (verified — no `fs`/`os`/`child_process`/`require` usage in `electron/preload.ts` or
  `electron/companion-preload.ts`). There is no known reason for the relaxation.

## Current state (verified 2026-06-10)

- `electron/main.ts:19-24` — main window webPreferences: `nodeIntegration: false`,
  `contextIsolation: true`, `sandbox: false`.
- `electron/services/companion.ts:40-42` — companion window: same trio, `sandbox: false`.
- Preloads confirmed Node-free (grep for `require(`, `from "fs|os|path|child_process|node:`
  returns nothing in either preload).

## Scope

1. Flip `sandbox: false` → `sandbox: true` in both places.
2. Verify the whole app still functions — this item is 20% edit, 80% verification:
   - App boots, theme applies.
   - Create a session; terminal renders and accepts input (xterm + PTY data flow over IPC).
   - Drag-drop an image onto the terminal area (the DropZone path uses
     `webUtils`-free base64 IPC — confirm it still works; if `webContents`-side file path
     access breaks under sandbox, note it and fix within the IPC pattern, not by reverting
     the sandbox).
   - Open a panel from a session (`show_panel` markdown) — companion window opens and renders.
   - Submit a form panel (`show_form`) — submission round-trips.
   - Restart the app with a live session — restore overlay appears, session resumes.
3. If anything genuinely cannot work sandboxed, do NOT silently revert: document the exact
   API in the work-item PR description and leave that window un-sandboxed with a code
   comment explaining why, flipping only the other one.

## Non-goals

- No preload refactoring, no CSP work, no `webSecurity` changes.
- No changes to panel content sanitization (separate concern, later item).

## Acceptance criteria

- Both windows have `sandbox: true` (or one documented exception per above).
- The six manual smoke steps in Scope #2 all pass — list them with pass/fail in the
  commit/PR description.
- `npm run build` and `npm test` pass.

## Files

- Modify: `electron/main.ts:23`
- Modify: `electron/services/companion.ts:42`
