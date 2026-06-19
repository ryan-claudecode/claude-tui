# A11Y — Accessibility pass

- **Phase:** 3 · **Depends on:** — · **Worktree: yes** · **Model: Sonnet** · **Size:** M
- **Why:** the original audit flagged: no focus trapping in modals, almost no aria labels,
  no `prefers-reduced-motion`, missing focus-visible rings. Table stakes for a product.
  Purely additive — no behavior change beyond accessibility, so low-risk for the unattended run.

## Current state (verified this session)

- Overlays (each handles Escape + arrow nav already, but leak Tab focus to the background
  and lack dialog semantics): `src/components/CommandPalette.tsx`, `ShortcutsHelp.tsx`,
  `HistorySearch.tsx`, `MissionPrompt.tsx`, `MissionsList.tsx`. Verify exact filenames.
- Only `WindowControls.tsx` buttons have `aria-label`. Icon-only buttons elsewhere lack
  labels: sidebar action buttons, the ⊕ overview + ⌚ timeline row buttons, tab close ✕,
  attention/mission row dismiss ×, mission `+` / conductor icons, toast close.
- `src/App.css` animations (panel slides, modal drop-in, spinner, status-dot pulse,
  progress shimmer) have NO `prefers-reduced-motion` guard.
- Theme tokens + `:focus`/`:focus-visible`: only form inputs and split panes have visible
  focus styling; most interactive elements have none.

## Scope

1. **Shared focus trap** — create `src/hooks/useFocusTrap.ts`: given a ref to the overlay
   container and an `active` flag, it (a) moves focus into the overlay on open (first
   focusable or a given initial element), (b) traps Tab/Shift+Tab within the overlay's
   focusable set, (c) restores focus to the previously-focused element on close. One hook,
   applied to ALL five overlays — do not hand-roll per overlay.
2. **Dialog semantics** — each overlay's root gets `role="dialog"` + `aria-modal="true"` +
   an `aria-label` (or `aria-labelledby` pointing at its title). Apply `useFocusTrap`.
   Preserve existing Escape-to-close and arrow-key behavior exactly.
3. **aria-labels** — add concise `aria-label` to every icon-only button listed above (and
   any others found). Keep visible text buttons as-is.
4. **prefers-reduced-motion** — add a single `@media (prefers-reduced-motion: reduce)`
   block near the top of `App.css` that disables/neutralizes transitions+animations
   (`animation: none; transition: none;` for the app's animated classes, or a broad
   `*` reduction scoped carefully). The status-dot pulse, restoring-overlay spinner, panel
   slide, and modal drop must all stop animating under the preference.
5. **focus-visible rings** — add a consistent `:focus-visible` outline (using an existing
   accent token) for interactive elements that currently show nothing (buttons, sidebar
   rows, tabs, overlay options). Use `:focus-visible` (not `:focus`) so mouse clicks don't
   ring. Don't touch elements that already have focus styling.

## Non-goals

- No behavior changes beyond accessibility; no restructuring of overlays; no new deps; no
  electron/main-process changes (this is renderer + CSS only). No screen-reader live-region
  work beyond the existing toast `role="status"`.

## Acceptance criteria

- `npm run build` + `npm test` green (219 baseline unchanged — this is additive UI).
- If `useFocusTrap` has any pure logic worth testing (e.g. focusable-element selection),
  add a small test; otherwise the build/type-check is the gate (no jsdom in the suite — do
  NOT add one).
- Every overlay: `role="dialog"`, `aria-modal`, a label, and the shared trap.
- `prefers-reduced-motion` block present and covering the named animations.
- Manual smoke (pending user verification, list in report): Tab cycles within each open
  overlay and doesn't escape to the terminal; Escape still closes; OS "reduce motion"
  setting stops the pulse/spinner.
- Commit only changed files by explicit path.

## Mandatory base check (stale-base quirk recurs)

`git rev-parse HEAD` vs `git rev-parse main`; if different `git reset --hard main`; confirm
HEAD ≥ `5c5040d` and `npm test` = 15 files / 219 tests BEFORE editing. Stop+report if wrong.

## Safety

Never kill a process you didn't launch+record. Don't launch the app or claude CLI.
Renderer + CSS only — do NOT touch `electron/` (a concurrent agent is editing the backend there).
