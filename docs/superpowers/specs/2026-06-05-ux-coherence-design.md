# ② UX Coherence — Design

**Date:** 2026-06-05
**Sub-project:** ② of the ClaudeTUI "major pass" (Cleanup → **UX coherence** → Forward)
**Predecessor:** ① Internal cleanup (`2026-06-05-cleanup-design.md`), complete on `main`.

## Problem

Selecting a session in the sidebar fires **two simultaneous transformations**:

1. **Sidebar reflow** — the clicked session inline-expands to list its terminals; sibling rows collapse to a one-line activity preview and shift position.
2. **Main-area swap** — the TabBar + TerminalPanes re-render for the newly active session.

On top of that, terminals are rendered **redundantly in two places**: the sidebar's inline tree *and* the TabBar. The result feels incoherent — a uniform list that violently rearranges itself on click, with the same objects shown twice.

This sub-project also carries two items deferred from ①:
- **M5** — the Session Overview panel is a one-shot static snapshot that goes stale.
- **IPC channel-string rename** — channels named `session:*` that actually move per-PTY bytes, a wire-protocol change held back from ①'s symbols-only rename.

## Guiding principle (load-bearing invariant)

**Terminal navigation is a surface-agnostic action, not a property of where it is rendered.**

`activeSessionId` + `activeTerminalId` remain centralized in `App.tsx`, driven by a single `selectTerminal(sessionId, terminalId)` handler. The TabBar is *one renderer* of a session's `terminals[]` membership (which lives on the `SessionService` container). Choosing "tabs-only" is a **rendering** decision, not an architectural one — we remove one renderer of the terminal list (the inline accordion), not the capability.

**Why this matters:** it keeps the door open to reintroducing visible terminals elsewhere later (a sidebar tree, a dedicated terminals panel, a palette). Adding such a surface = adding a second caller of the same `selectTerminal` handler, reading the same `terminals[]` prop already in hand. Zero model change. This invariant is written here on purpose so a future revisit sees the door was left open deliberately.

## Decisions

The foundational fork (where terminal nav lives) was resolved to **tabs-only**. Full chosen scope: click&expand fix + live Overview + IPC rename + tab-bar polish.

## Components

### 1. Sidebar — uniform, non-reflowing rows
**File:** `src/components/Sidebar.tsx`

- **Remove** the inline-expansion block (the `selected && s.terminals.map(...)` accordion). This is what kills the reflow-on-click.
- Every row becomes a **fixed two-line cell**, identical height whether selected or not:
  - **Line 1:** status dot (derived session status — the busiest terminal's state) · session name · terminal-count badge (e.g. `3 ▣`).
  - **Line 2:** the effective activity of the busiest terminal (e.g. `● Edit(auth.ts)`), or an idle string (e.g. `idle · 12m`).
- Selecting a session highlights the row and swaps the main area **only** — one transform, no height change, no sibling shift.
- Keep the ⊕ Overview button on each row.
- "Busiest terminal" selector: prefer a terminal in the `active` state; otherwise the most-recently-active. The exact selector is pinned in the plan; it reuses the existing per-terminal `effectiveActivity`/state already surfaced to the renderer.

**Regression guard:** a row's rendered height must be invariant across selected/unselected — this is the bug the section exists to kill, so it gets an explicit test.

### 2. TabBar — promoted to primary terminal nav
**File:** `src/components/TabBar.tsx`

Tabs are now the *only* terminal switcher, so the TabBar must carry weight it previously shared with the sidebar tree:

- **Per-tab status dot** (active/idle), mirroring the terminal's state.
- **Hover tooltip** = the tab's full activity line (the same effective-activity string).
- **Overflow handling** — horizontal scroll when a session has many terminals, so tabs never wrap or overflow the bar.
- **New-tab affordance** (`+`) spawns a new terminal in the active session; per-tab close (`×`).

All tab interactions drive the existing centralized `selectTerminal` / spawn / close handlers — no new state ownership.

### 3. Session Overview — live refresh (M5)
**Files:** `electron/services/sessions.ts` (`getOverview`), `src/App.tsx` (panel wiring), Overview panel component.

- Today `getOverview` builds a one-shot snapshot and the panel renders it once; as terminals keep working, summary / findings / per-terminal activity go stale.
- Make an **open** Overview panel **re-fetch and re-render** when its session changes: subscribe to the relevant renderer-side events (`session:state` and the `worksession:updated` event already emitted for the container) for the panel's `sessionId`, re-invoke `getOverview(sessionId)` over its existing IPC, and replace the panel's contents with the fresh snapshot (debounced so a burst of events coalesces into one refresh). This reuses ①'s lesson that the Overview must route through stable IPC, not a stale `sessions` closure.
- Single affordance: ⊕ → pinned live Overview in the drawer. **No hover-peek** — deferred as a purely additive follow-up if ever wanted (tabs-only made selecting cheap, so peek-without-selecting lost most of its value).

### 4. IPC channel rename — coherence cleanup
**Files (lockstep):** `electron/services/terminals.ts` (sendToRenderer), `electron/ipc.ts` (handlers), `electron/preload.ts` (bridge), `src/App.tsx` (listeners).

The export `sessionService = new TerminalService()` (ipc.ts:41) means the `session:*` channels are **all** bound to `TerminalService` and operate on individual PTYs (`terminal.id`). The misnaming is systemic. Genuine container channels are already correctly named `worksession:*` and stay untouched.

**Complete inventory — every `session:*` channel renames to `terminal:*`:**

| Kind | Current | New |
|------|---------|-----|
| handle | `session:create` | `terminal:create` |
| handle | `session:kill` | `terminal:kill` |
| handle | `session:focus` | `terminal:focus` |
| handle | `session:list` | `terminal:list` |
| handle | `session:activity` | `terminal:activity` |
| handle | `session:rename` | `terminal:rename` |
| handle | `session:get-output` | `terminal:get-output` |
| handle | `session:search-output` | `terminal:search-output` |
| handle | `session:handoff` | `terminal:handoff` |
| send (R→M) | `session:write` | `terminal:write` |
| send (R→M) | `session:resize` | `terminal:resize` |
| emit (M→R) | `session:data` | `terminal:data` |
| emit (M→R) | `session:exit` | `terminal:exit` |
| emit (M→R) | `session:created` | `terminal:created` |
| emit (M→R) | `session:state` | `terminal:state` |
| emit (M→R) | `session:renamed` | `terminal:renamed` |
| emit (M→R) | `session:focus` | `terminal:focus` |

Notes:
- `session:focus` appears both as a request (ipc.ts:148) and an emitted event (preload.ts:106, terminals.ts:573); both rename to `terminal:focus` consistently.
- This is **all-or-nothing per channel**: a string renamed on one side but not the other silently breaks the wire. Each channel must be changed across all four files in the same task.
- The `sessionService` **variable** name in `ipc.ts` (and the many services taking it as a constructor arg) is *also* a misnomer (it is a `TerminalService`). Renaming the variable is adjacent coherence cleanup but is a large cross-file symbol change and is **out of scope** for ② unless explicitly pulled in — the channel-string rename is the user-requested wire-protocol change; the JS identifier is separate.

## Data flow (unchanged)

No service-layer model changes. `SessionService` still owns the durable container + `terminals[]` membership; `TerminalService` still owns runtime PTYs. ② only changes (a) which renderer surfaces draw the terminal list, (b) the freshness of the Overview panel, and (c) the names of existing channels. The `selectTerminal` action, the membership data, and the event stream are all pre-existing.

## Error handling

- Overview live-refresh must no-op gracefully if the panel's session was killed mid-refresh (guard on missing session → leave last content or close).
- Channel rename: since it is all-or-nothing, the verification is end-to-end round-trip, not unit-level — a renamed-but-unmatched channel manifests as a dead terminal (no output / no input), caught by the E2E smoke.

## Testing strategy

- **Sidebar:** row rendered height is invariant across selected/unselected (regression test for the reflow bug); row renders the count badge + one activity line.
- **TabBar:** renders exactly one tab per terminal in the active session; clicking a tab drives `selectTerminal`; `+` spawns into the active session; overflow does not wrap.
- **Overview:** an open Overview re-renders when a simulated `session:state` / `worksession:updated` event arrives for its session; no-ops when the session is gone.
- **IPC rename:** end-to-end round-trip — create a terminal, write input, receive output, rename, kill — all over the new `terminal:*` channels; assert no remaining `session:*` PTY channel strings (a grep-style guard).
- **Standing gate (inherited from ①):** `npm run typecheck` exits 0 **and** `npm test` all green before any commit.

## Out of scope (explicit)

- Hover-peek / inline session preview (additive follow-up only).
- Master-detail or accordion sidebar layouts (rejected at the fork in favor of tabs-only).
- `sessionService` JS-variable rename (adjacent, large, not requested).
- Cross-device, observer, notifications (sub-project ③ and beyond).
