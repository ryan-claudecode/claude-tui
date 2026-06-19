# AQ-2 — Attention queue UI: sidebar section, notifications wiring, Ctrl+J

- **Phase:** 2 · **Spec:** [attention-queue-design.md](./attention-queue-design.md) (read it FIRST) · **Depends on:** AQ-1 (merged) · **Worktree:** yes · **Size:** M (~half day)
- **Why:** renders the queue AQ-1 maintains; the user-facing half of the feature.

## Current state (to verify when picked up — AQ-1 will have landed)

- `AttentionService` emits `attention:updated` snapshots and `attention:jump` (OS
  notification click); exposes `seen(terminalId)` / `dismiss(id)` (see AQ-1 + spec).
- Renderer hooks live in `src/hooks/` (P1-4 style: each hook owns its listeners +
  cleanup). Sidebar is `src/components/Sidebar.tsx`; themes are CSS custom properties at
  the top of `src/App.css` (3 themes: light, dark, cold-dark). Keyboard shortcuts +
  `Window.api` typing live in `src/App.tsx`; IPC handler modules in `electron/ipc/`.

## Scope

1. **IPC + preload** — register `attention:seen` / `attention:dismiss` invoke handlers
   (new `electron/ipc/attention-handlers.ts`, P1-3 pattern); preload accessors:
   `onAttentionUpdated`, `onAttentionJump`, `attentionSeen(terminalId)`,
   `attentionDismiss(id)`; extend `Window.api` type.
2. **`src/hooks/useAttention.ts`** — subscribes to `attention:updated` +
   `attention:jump`; exposes `{ entries, dismiss, jumpTo }`; `jumpTo(entry)` focuses the
   session+terminal (reuse the existing select/focus paths in `useSessions`) and calls
   `attentionSeen`. A ~30s interval re-render keeps wait times fresh. Owns its listener
   cleanup.
3. **Sidebar section** — "NEEDS YOU (n)" pinned above WORKSPACES in `Sidebar.tsx`,
   rendered ONLY when entries exist. Two-line rows: terminal/session name, then
   `reason · <wait>` (e.g. `form waiting · 6m`). Tier tinting via theme tokens — add
   tier color variables to each theme block in `App.css` (warm amber for tier 1, muted
   gold tier 2, sage tier 3 — match the Sand & Stone language, no harsh saturation).
   Hover reveals a dismiss ×. Keep the section visually quiet: no animation beyond the
   existing hover transitions.
4. **Ctrl+J** — jump to the top entry (App.tsx keyboard handler + ShortcutsHelp overlay
   entry).
5. **Docs** — CLAUDE.md: shortcuts table row, MCP tools section (the two AQ-1 tools),
   one Key Files row for `attention.ts`, and a short "Attention queue" subsection under
   the session-activity heading.

## Non-goals

- No changes to AttentionService policy, detection, or MCP tools (AQ-1 owns those; if
  you find a policy bug, report it — don't fix it here).
- No companion-window rendering, no sounds, no settings UI (config file only).

## Acceptance criteria

- `npm run build` + `npm test` green (add a small test for any pure view-model helper
  you extract, e.g. wait-time formatting — follow `sessionRow.ts`/its test as precedent).
- Section absent when queue empty; appears/disappears reactively.
- The P0-5 toast-on-error pattern respected for any new async renderer calls.
- Manual smoke list (pending architect verification — include in report): trigger a
  form → tier-1 row + toast + OS notification when unfocused; click row → focus +
  clear; Ctrl+J; dismiss ×; all three themes look right.
- Commit only files you changed, by explicit path.

## Files

- Create: `electron/ipc/attention-handlers.ts`, `src/hooks/useAttention.ts`
- Modify: `electron/ipc.ts`, `electron/preload.ts`, `src/App.tsx`,
  `src/components/Sidebar.tsx`, `src/components/ShortcutsHelp.tsx`, `src/App.css`,
  `CLAUDE.md`
