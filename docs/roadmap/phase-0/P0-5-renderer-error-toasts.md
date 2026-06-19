# P0-5 — Surface renderer async failures as toasts

- **Phase:** 0 · **Depends on:** none · **Worktree:** yes · **Size:** S–M (~3 hours)
- **Why:** Every user-triggered async operation in the main window is fire-and-forget: if
  spawning a session, adding a terminal, killing, renaming, or handing off fails, the user
  gets *nothing* — the click just doesn't work. Silent failure is the fastest way to lose
  trust in an agent cockpit ([identity doc](../00-identity.md): no silent failures). The
  toast UI already exists (`ToastHost`); it's just only reachable from the main process.

## Current state (verified 2026-06-10)

- `src/App.tsx:309-347` — `handleNewSession`, `handleNewTerminal`, `handleCloseTerminal`,
  `handleHandoff`, `handleKillSession`, `handleRenameTerminal`: zero try/catch; several
  don't even await (`closeTerminal`, `killWorkSession`, `renameSession`).
- `src/App.tsx:372-389` — `handleExportLog` silently returns when output is null.
- `src/App.tsx:296-307` — drop-handler (`saveDroppedImage` → `showPanel`) unguarded.
- `src/components/ToastHost.tsx:38-48` — toasts arrive ONLY via IPC `notification:show`
  (main-process `NotificationService`). There is no renderer-local way to raise one.

## Scope

1. **Renderer-local toast channel.** In `ToastHost.tsx`, additionally listen for a DOM
   `CustomEvent` on `window` (`claudetui:toast`, detail = `ToastState` minus id/createdAt).
   Export a helper from a new tiny module `src/lib/toast.ts`:
   ```typescript
   export function toast(level: ToastState["level"], message: string, title?: string): void
   // dispatches the CustomEvent; id = crypto.randomUUID(), timeout: 6000 (error: 8000)
   ```
   This deliberately reuses the existing toast rendering/stacking/dismiss logic — do not
   build a second toast system.
2. **Wrap the handlers.** In `App.tsx`, wrap each async handler body in try/catch and call
   `toast("error", ...)` with a human message naming the action (e.g. "Couldn't start a new
   session") plus the error message. Await the currently fire-and-forget calls
   (`closeTerminal`, `killWorkSession`, `renameSession`) so failures are catchable.
3. Cover: the six handlers at `App.tsx:309-347`, `handleExportLog` (toast a warning when
   there's no output to export), and the image-drop path at `App.tsx:296-307`.

## Non-goals

- Do NOT redesign error handling in the main process or IPC layer.
- Do NOT add retry logic, error boundaries, or a state library.
- Do NOT convert `window.confirm` in `handleKillSession` to a custom dialog (separate
  UX item later).
- Do NOT touch the companion window.

## Acceptance criteria

- Temporarily making an IPC handler throw (e.g. hack `worksession:open` to reject) produces
  a visible error toast for New Session instead of a dead click — describe this manual
  check in the PR/commit message, then remove the hack.
- A unit test for `src/lib/toast.ts`. Note the vitest setup runs in the default node
  environment (no jsdom in devDependencies) — structure `toast()` so the event-payload
  construction is a pure function you can test without `window` (e.g.
  `buildToast(level, message, title): ToastState` tested directly; the
  `window.dispatchEvent` wrapper stays untested rather than adding a jsdom dependency).
- No remaining un-awaited `window.api.*` calls inside the listed handlers.
- `npm run build` and `npm test` pass.

## Files

- Create: `src/lib/toast.ts`
- Modify: `src/components/ToastHost.tsx` (add CustomEvent listener)
- Modify: `src/App.tsx:296-389` (handler wrapping only — no other refactoring)
- Test: `src/lib/toast.test.ts`
