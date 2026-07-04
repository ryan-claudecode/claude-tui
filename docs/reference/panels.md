# Panel System — ModalHost (main window) + pop-out companion

Claude renders rich UI via panels that appear **modal-by-default in the MAIN window** (CAPP-109). State flows:
**Claude → MCP tool → PanelService → main bridge IPC → `ModalHost`** (`src/components/ModalHost.tsx`, mounted in `App.tsx`).

Both windows render the same panels through the **shared `PanelContent` switch** (`src/components/panels/PanelContent.tsx`) over a typed **`PanelApi`** (`src/lib/panelApi.ts`) — a compile-time parity test asserts BOTH `window.api` and `window.companionApi` satisfy it, so a panel works identically on either surface. The ModalHost has a focus-trapped dialog with a top bar (title + **⤢ pop-out** + ×), a tab strip when several panels are open, and a **form-exclusive active-panel rule** (`src/lib/modalActivePanel.ts`): a pending form always wins the active slot so it can never be buried.

**Pop-out (CAPP-110):** the ⤢ button calls `panel:pop-out` → `PanelService.popOut(id)` flips the panel's `surface` to `"window"`, hands it to the **companion window** (lazily created; placement clamped on-screen via `companionPlacement.ts` — CAPP-105), and drops it from the main mirror WITHOUT cancelling a pending form. The companion keeps its own pill tab bar. Closing the companion reconciles state (`dismissWindowPanels`): popped-out forms resolve `{cancelled:true}`, window panels drop, and nothing can resurrect the closed window — broadcasts like `hide_all_panels` use the NON-CREATING `sendIfOpen` (CAPP-116); only `popOut` may create it.

**Chat → panel trigger (CAPP-111):** blocks in the structured chat are NOT click-to-open; each expandable block (assistant/tool/result/raw) has a statically-visible top-right expand button (`BlockExpandButton`, settled-gated on assistant blocks) that opens the block's detail panel in the ModalHost.

**Panel presence indicator (PP):** the main window's `usePanels` hook tracks open panels (`panel:show`/`update`/`hide` IPC) and exposes a `recentlyChanged` pulse flag (set on show/update, cleared after ~1.2s). When panels are open, `TabBar` shows a quiet pill near the window controls with the open count; it pulses on open/update and clicking it calls `companion:focus` IPC → `CompanionService.focusIfOpen()`. Live-refresh matching (session overview panels) uses `props.id` instead of a panel-id prefix, because panels have auto-generated `panel-N` ids.

**Forms are special:** `show_form` keeps the MCP call open (a pending promise in `PanelService`). Submitting (from the modal or a popped-out companion form) resolves the promise and returns the data to Claude; EVERY close path — modal backdrop/Escape/×/tab-close, `hide_panel`, `hide_all_panels`, companion-window close — resolves a pending form as `{cancelled:true}` so the MCP call never hangs.

## How to add a new panel type

1. **Component** — create `src/components/panels/FooPanel.tsx`; it receives the tool's `props` as React props.
2. **Route it** — add a `case "foo"` to the ONE shared `PanelContent` switch (`src/components/panels/PanelContent.tsx`) — both the ModalHost and the companion render through it.
3. **Allow the type** — add `"foo"` to the `type` enum of `show_panel` in `electron/mcp/tools.ts` (no service change needed — `PanelService` is generic).
4. **Style** — add a `.foo-panel` block in `src/App.css` using the design tokens (shared by both windows).
