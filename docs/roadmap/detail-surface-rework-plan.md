# ClaudeTUI / Mission Control — Panel-Modal Refactor: Implementation Plan

> Produced by the `detail-surface-rework-plan` workflow (4 parallel subsystem maps → synthesis → 2-lens adversarial critique → revise). Covers owner items: (2) kill block click-to-open + per-block action buttons, (3) panel → in-main-window modal with a pop-out-to-window button, (4) off-screen pop-out window fix. Owner item (1) ultracode-effort and (5) CAPP-104 rail action buttons are tracked separately.

## (0) Current architecture (two paragraphs)

Panels are window-agnostic state owned by `PanelService` (`electron/services/panels.ts`). Every open path — Claude's MCP `show_panel`/`show_form` (`electron/mcp/tools/panels.ts`), the renderer's `window.api.showPanel` (AgentView block-expand, sidebar ⊕, attention-queue worktree-review, WorkspaceSwitcher memory/context) — funnels through `PanelService.show(type, props)`, which mints a `panel-N` id, stores a `PanelState`, and calls `sendToCompanion("panel:show", panel)`. `CompanionService` (`electron/services/companion.ts`) is the only bridge: `sendToCompanion` lazily creates the companion `BrowserWindow` via `getOrCreate()` and emits after `did-finish-load`. That window runs `CompanionApp.tsx`, whose `PanelContent` switch renders all 23 panel types. **Crucially, that switch is NOT `(panel)` — it threads six companion-bound callbacks** (`onSendToSession`, `onMissionStop`, `onMissionPause`, `onApproveWorktree`, `onRejectWorktree`; `CompanionApp.tsx:266-326`) that drive `diff`'s send-review, `mission`'s Stop/Pause, and `worktree-review`'s Approve/Reject. `show_form` is the one blocking path: `showForm` calls `show("form", …)` then returns `new Promise` stored in `pendingForms` keyed by `panel.id`; the MCP tool `await`s it. The renderer resolves it by firing `panel:form-submit <id> <data>` → `panel-handlers.ts` → `PanelService.submitForm`, which calls the stored resolver. `PanelService.hide` resolves any pending form as `{cancelled:true}`.

Two pre-existing facts de-risk this whole refactor. First, the **main window already mirrors all panel state**: `src/hooks/usePanels.ts` subscribes to `panel:show/update/hide/hide-all` (wired in `electron/preload.ts`) and keeps a full `PanelState[]` — today used only for the presence-pill pulse and overview/mission live-refresh effects (keyed on `props.id`), never rendered. Second, **the form round-trip already works from the main window**: `FormPanel.tsx` already branches `window.companionApi ? companionApi.submitForm : window.api.submitForm`, and `window.api.submitForm` → `panel:form-submit` is wired in the main preload. The off-screen bug is isolated: `companion.ts:43-45` computes `x = mainBounds.x + mainBounds.width + 8` with no clamp to any display work area, and the file imports only `BrowserWindow` — no `screen`.

**Three correctness facts the critiques surfaced and verified, now load-bearing for this plan:**
- **F1 — `window.api` is NOT at parity with `companionApi` for two methods.** `RecallPanel` calls `openSessionOverview(sessionId)` (`RecallPanel.tsx:48,123`) and `SessionOverviewPanel` calls `promoteSessionToWorkspace(id)` (`SessionOverviewPanel.tsx:33`) — **both companion-only, absent from `electron/preload.ts`'s `window.api`** (nearest are `getSessionOverview` and `promoteWorkspaceFindings`, different signatures, verified at preload `:65,:146`). These two accessors must be ADDED to `window.api`.
- **F2 — `PanelContent` carries 6 callbacks for `diff`/`mission`/`worktree-review`, none of which are in the "#19-23" set.** A `(panel, api)`-only extraction renders dead Stop/Pause/Approve/Reject/Send buttons. The extracted component must derive all six behaviors from a single `api` object.
- **F3 — `submitForm` (panels.ts:149-150) does `panels.delete(id)` + `sendToCompanion("panel:hide")` ONLY** — it never notifies the main window. After a popped-out form submits, `usePanels`' main-window mirror still holds the (now server-deleted, promise-resolved) panel as `visible:true` → a zombie ModalHost can re-select it. `submitForm` must route to BOTH surfaces.

---

## (A) The ModalHost + the shared, fully-typed PanelContent

**New component `src/components/ModalHost.tsx`**, rendered inline in `App.tsx` as a sibling of the other overlays (KillSessionModal, CommandPalette) — **no React portal** (the codebase has none; stay consistent). It is one generic host that renders the **extracted shared `PanelContent`**, not a per-type modal.

### A.1 — Prerequisite extraction (CAPP-S1): the REAL `PanelContent` contract

Lift `PanelContent` out of `CompanionApp.tsx:283-326` into **`src/components/panels/PanelContent.tsx`** (one switch, all 23 cases). Both `CompanionApp` and `ModalHost` import it. This kills the existing 3-way drift (`CompanionApp` / the stale `PanelDrawer.tsx` / the new modal).

**The contract is `(panel, api)` where `api` is a single behavior object — NOT a thin pass-through of `window.api`.** `PanelContent` derives EVERY callback the switch needs internally from `api`, so callers supply one object and the switch owns the wiring (this folds F2's six callbacks into the `api` object instead of dropping them):

```ts
// src/lib/panelApi.ts — the surface contract both windows satisfy.
export interface PanelApi {
  // #1 diff, #23 worktree-review send-review:
  sendToSession: (text: string) => boolean
  // #18 mission Stop/Pause:
  missionStop: (id: string) => void
  missionPause: (id: string) => void
  // #23 worktree-review:
  approveWorktreeTask: (m: string, t: string) => Promise<ReviewActionResult | null>
  rejectWorktreeTask: (m: string, t: string, reason?: string) => Promise<ReviewActionResult | null>
  // #19 recall row-click opens an overview into the SAME host (recursive-by-design):
  openSessionOverview: (sessionId: string) => void
  // #20 session-overview "Push context to workspace":
  promoteSessionToWorkspace: (sessionId: string) => Promise<unknown>
  // #21 workspace-memory mutators, #22 context-inspector, #19 recall search:
  recall: PanelApiRecall
  getWorkspaceMemory: ...; setWorkspaceFindingPinned: ...; inspectWorkspaceContext: ...
  // ...every method any of the 23 panels calls. Exhaustive — see A.3.
}
```

`PanelContent` switch wires from `api`:
```tsx
case "diff":      return <DiffPanel {...panel.props} onSend={api.sendToSession} />
case "mission":   return <MissionPanel {...panel.props} onStop={api.missionStop} onPause={api.missionPause} />
case "session-overview": return <SessionOverviewPanel {...panel.props} api={api} />
case "recall":    return <RecallPanel {...panel.props} api={api} />
case "worktree-review": return <WorktreeReviewPanel {...panel.props}
  onSend={api.sendToSession}
  onApprove={api.approveWorktreeTask}
  onReject={api.rejectWorktreeTask} />
// ...
```

**The two callers each build a `PanelApi` over their native bridge:**
- **`CompanionApp`** builds it over `window.companionApi` (a 1:1 wrap of today's six inline callbacks, plus the panel-internal accessors the #19-23 panels used to read off `window.companionApi`).
- **`ModalHost`** builds it over `window.api`, using the F1-added accessors.

This makes the parameterized set **#1, #18, #19-23** (diff, mission, recall, session-overview, workspace-memory, context-inspector, worktree-review) — the eight panels that take behavior — NOT just "#19-23". Panels with no callbacks/external reads (#2-17) ignore `api`.

**Also extract `tabLabel` + `PANEL_LABELS`** (`CompanionApp.tsx:41-66`) into the same shared module — both surfaces now need the specialized labels (overview→session name, review→title, memory/context→workspace name). The companion tab strip AND the modal's title/tab strip read from one source.

### A.2 — Resolve F1: add the two missing `window.api` accessors (HARD part of S1)

`openSessionOverview` and `promoteSessionToWorkspace` do not exist on `window.api`. S1 ADDS them to `electron/preload.ts`:
- `openSessionOverview: (sessionId) => ipcRenderer.invoke("worksession:open-overview", sessionId)` — backed by an IPC handler that calls `panelService.show("session-overview", await sessionService.getOverview(sessionId))`. From the modal this is **recursive-by-design** (opens another panel into the same ModalHost) — explicitly fine; call it out in the S1 test.
- `promoteSessionToWorkspace: (sessionId) => ipcRenderer.invoke("worksession:promote-to-workspace", sessionId)` — the handler already exists (used by the companion path); just expose the main-window accessor. It resolves the owning workspace from the bare `sessionId` server-side (do NOT substitute `promoteWorkspaceFindings`, whose signature is `(workspaceId, entries[])`).

**Type-parity pin (a GATE, not an afterthought — it would have caught F1):** a compile-time test (`src/lib/panelApiParity.test.ts`) asserts that BOTH `window.api` and `window.companionApi` structurally satisfy `PanelApi`. The build fails if either window lacks a method any panel needs. This is the standing guard against this exact class of drift.

### A.3 — Per-panel `api`-method audit (do this concretely in S1, don't assert it)

Enumerate every `window.companionApi.*` / `window.api.*` call site in panels #1, #18, #19-23, list each method, and confirm `window.api` has it (adding via F1 where missing). Known sites: `WorkspaceMemoryPanel` (~18 sites — all export/adoption/memory mutators, **confirmed present on `window.api`**), `ContextInspectorPanel:101` (`inspectWorkspaceContext` — present), `SessionOverviewPanel:33` (`promoteSessionToWorkspace` — **add via F1**), `RecallPanel:47-48,123` (`recall`, `openSessionOverview` — `recall` present, **`openSessionOverview` add via F1**), `WorktreeReviewPanel` (`approveWorktreeTask`/`rejectWorktreeTask` — present at preload `:270,:272`), `DiffPanel`/`MissionPanel` (callback-fed, no direct bridge reads). The `PanelApi` interface (A.1) is the single typed manifest of this audit.

### A.4 — Resolve B2: RecallPanel's guard degrades to EMPTY, so its conversion is load-bearing

`RecallPanel`'s `recallApi()` guard (`RecallPanel.tsx:47-48`) returns undefined when `window.companionApi` is absent, rendering a **blank/disabled** box — not a graceful fallback. So in the modal it MUST receive a working `api` (with `recall` AND `openSessionOverview`) via the prop. The conversion is functional, not cosmetic; the S1 render-test for `recall` asserts it shows results given a mock `api`, and that an empty `api` (negative control) shows the disabled state — never a throw.

### A.5 — ModalHost skeleton (cloned from `KillSessionModal.tsx:145-156`, reusing tokens)

```tsx
function ModalHost({ panels, onClose, onPopOut, onActivate }: ModalHostProps) {
  const visible = panels.filter((p) => p.visible)
  const active = useActivePanel(visible)        // see A.6 — form-exclusive selection
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, !!active)
  const api = useMemo(buildMainPanelApi, [])    // PanelApi over window.api (A.1)
  if (!active) return null
  return (
    <div className="modal-host-overlay" onMouseDown={() => onClose(active.id, "backdrop")}>
      <div ref={panelRef} className="modal-host-panel" role="dialog" aria-modal="true"
           aria-label={tabLabel(active)}
           onMouseDown={(e) => e.stopPropagation()}
           onKeyDown={(e) => { if (e.key === "Escape") onClose(active.id, "escape") }}>
        {visible.length > 1 && (
          <div className="modal-host-tabs">                {/* A.6 — real tab strip */}
            {visible.map((p) => (
              <button key={p.id} className={`modal-host-tab ${p.id === active.id ? "active" : ""}`}
                      onClick={() => onActivate(p.id)}>
                {tabLabel(p)}
                <span className="modal-host-tab-close"
                      onClick={(e) => { e.stopPropagation(); onClose(p.id, "tab-close") }}>×</span>
              </button>
            ))}
          </div>
        )}
        <div className="modal-host-bar">                   {/* statically visible — no hover-reveal */}
          <span className="modal-host-title">{tabLabel(active)}</span>
          <button className="modal-host-popout" onClick={() => onPopOut(active.id)}>⤢ Pop out</button>
          <button className="modal-host-close" onClick={() => onClose(active.id, "button")}>×</button>
        </div>
        <div className="modal-host-body">
          <PanelContent panel={active} api={api} />
        </div>
      </div>
    </div>
  )
}
```

### A.6 — Resolve M1/M2: form-exclusive active-panel selection + a real tab strip

The naive `topVisible` ("most-recent visible") **strands a pending form** when Claude calls `show_panel` after a `show_form` (M2): the form unmounts from the DOM while its promise hangs server-side, with no way back. Two coupled rules, both implemented in `useActivePanel` (`src/lib/modalActivePanel.ts`, pure + tested):

1. **Form exclusivity.** If any visible panel is a `form`, it WINS the active slot regardless of recency. A pending form is the user's blocking obligation; it must stay reachable. (If multiple forms ever stack — agents rarely do — the oldest pending form wins so the queue drains in order.)
2. **A real tab strip is a HARD prerequisite of S2, not "if more than one panel."** When `visible.length > 1`, render the tab strip (A.5) so the user can return to ANY open panel — including a form pushed behind a later `show_panel`. Tabs are statically visible (no hover), use the extracted `tabLabel`, key identity on `panel.id` (`panel-N`), and each tab-close routes through `onClose → hidePanel(id)` so closing a form-tab still resolves `cancelled:true`. The active-tab pick matches mission/overview live-refresh on `props.id` (risk #7), but tab *identity* is `panel.id`.

This is the consistent choice under the no-hover / always-visible-control rule: the form is never silently hidden, and every open panel has a visible, clickable tab. (The companion already has this exact UX via its pill tabs — we are reaching parity, not inventing scope. The tab logic is shared via the extracted `tabLabel`; we do NOT revive `PanelDrawer`'s tab code — that file is deleted in S5.)

### A.7 — Styling (`src/App.css`), all via existing tokens

- `.modal-host-overlay`: `position:fixed; inset:0; z-index:2000; display:flex; align-items:center; justify-content:center; padding:var(--s-5); background:rgba(0,0,0,.45); backdrop-filter:blur(3px); -webkit-backdrop-filter:blur(3px); animation:drop-fade .12s var(--ease-out)`.
- `.modal-host-panel`: `width:min(820px,calc(100vw - 64px)); max-height:min(80vh,calc(100vh - 64px)); background:var(--bg-1); border:1px solid var(--border-strong); border-radius:var(--r-lg); box-shadow:var(--shadow-3),0 0 0 1px var(--accent-soft); animation:cmdk-pop .16s var(--ease-out); display:flex; flex-direction:column`.
- `.modal-host-tabs`: flex row, scrollable, `gap:var(--s-1)`; `.modal-host-tab.active` uses `--accent-soft`. Mirrors `.companion-tab` tokens.
- `.modal-host-bar`: flex row, `gap:var(--s-2)`; title left, the two buttons pushed right (`margin-left:auto` on the popout). Both buttons **statically visible** (full opacity at rest — no hover-reveal).
- `.modal-host-body`: `overflow:auto; padding:var(--s-4)`.
- **Add `.modal-host-overlay`/`.modal-host-panel` to the `prefers-reduced-motion` no-animation list** (`App.css:~388`).

### A.8 — Mount in `App.tsx`

`usePanels` already holds `panels`. Render `<ModalHost panels={panels} onClose={…} onPopOut={…} onActivate={setModalActiveId} />` next to the other overlays. `onClose(id, _reason)` → `window.api.hidePanel(id)` (PanelService.hide resolves a pending form as cancelled — never orphan it). `onPopOut(id)` → `window.api.popOutPanel(id)` (new, §B). `onActivate` updates a renderer-side active-tab id (the modal's tab selection; falls back to the form-exclusive default from A.6 when unset or when the active id is no longer visible).

---

## (B) Routing — modal-by-default, companion as pop-out target

The single behavior change: `PanelService.show` must **emit to the main window by default** and **only emit to the companion when a panel is targeted there** (pop-out). Today `show` emits to the companion only, and that emit lazily creates the window — that's the auto-pop we're killing.

### B.1 — Per-panel surface + a main-window bridge + `route` over BOTH the panel and panel-less channels

- `PanelState` gains `surface: "modal" | "window"` (default `"modal"`).
- `PanelService` gains `setMainBridge(bridge)` (a `{ send(channel, ...args) }` writing to the **main** `BrowserWindow.webContents`), wired in `ipc.ts` alongside `setCompanion`.
- New private `route(panel, channel, ...args)`:
  - always `this.mainBridge?.send(channel, ...args)` (the modal mirrors state);
  - if `panel.surface === "window"`, also `this.companion?.sendToCompanion(channel, ...args)`.
- **Panel-less channel (`panel:hide-all`):** `route` keys off a `panel`, but `hideAll` has none. Add a sibling `routeAll(channel, ...args)` that emits to the main bridge ALWAYS and to the companion if ANY tracked panel had `surface:"window"` (or unconditionally to the companion — it's a clear-everything signal and harmless if the companion is closed). `hideAll` uses `routeAll`.
- **`show`/`update`/`hide`/`hideAll` AND `submitForm` call `route`/`routeAll`** instead of `sendToCompanion`. **This includes `submitForm` (resolves F3):** `submitForm` must `route(panel, "panel:hide", id)` BEFORE `this.panels.delete(id)` (capture the panel first), so the main-window mirror drops the resolved form and can never re-select a zombie. Default `surface:"modal"` means a fresh panel never touches the companion bridge → the companion window is never auto-created.

### B.2 — `setMainBridge` ordering (resolve M5)

`route` does `this.mainBridge?.send(...)`; if a `show` fires before `setMainBridge` is wired (a startup `show_panel`, or auto-restore replay), the modal silently drops it. **`setMainBridge` MUST be wired in `ipc.ts` BEFORE any IPC handler that can call `show` is registered AND before the MCP server starts.** Add an explicit ordering comment at the wiring site and an `ipc.ts`-level assertion/log if `show` is ever called with no main bridge. (The companion path masks this today via lazy creation; the modal path has no such mask, so order is load-bearing.)

### B.3 — `popOut(id)` (the user gesture, NON-MCP)

```ts
popOut(id: string): boolean {
  const panel = this.panels.get(id)
  if (!panel) return false
  panel.surface = "window"
  this.companion?.sendToCompanion("panel:show", panel)  // lazily creates the companion (clamped — §D)
  this.companion?.focus?.()                              // raise it (new CompanionService.focus, §B.5)
  this.mainBridge?.send("panel:hide", id)                // close ONLY the in-main modal; NOT PanelService.hide
  return true
}
```
`mainBridge.send("panel:hide", id)` removes the panel from the main mirror (so the modal/tab drops it) but does **NOT** call `PanelService.hide` (which would cancel a pending form). Wire it: `ipcMain.handle("panel:pop-out", (_e, id) => panelService.popOut(id))` in `panel-handlers.ts`; preload `popOutPanel: (id) => ipcRenderer.invoke("panel:pop-out", id)` (main window only). The modal's "⤢ Pop out" calls it.

### B.4 — How a `show_form` pending-promise resolves through the modal (spelled out)

1. MCP `show_form` → `PanelService.showForm` → `show("form", …)` with `surface:"modal"` → `route` emits `panel:show` to the **main** window. `usePanels` records it; `useActivePanel` (form-exclusive, A.6) makes it active; `ModalHost` renders `FormPanel` (via `PanelContent`, `api` built over `window.api`). The promise is stored in `pendingForms[panel.id]`; the MCP HTTP/SSE request hangs open in the main process — **unchanged**.
2. User submits → `FormPanel.tsx:56-60` calls `window.api.submitForm(panel.id, values)` (main-window branch, already present) → `panel:form-submit` IPC → `panel-handlers.ts` → `PanelService.submitForm(id, data)` → stored resolver fires → MCP returns the values → `submitForm` now `route`s `panel:hide` to BOTH surfaces (F3) so neither window keeps a zombie.
3. **Cancel safety (the sharpest correctness point):** `ModalHost.onClose` (backdrop / Escape / × / tab-close — ALL paths) calls `window.api.hidePanel(id)` → `PanelService.hide` → resolves the pending form as `{cancelled:true}` (`panels.ts:98-103`). The modal must **never** unmount a form without going through `hidePanel`. The form-exclusive selection (A.6) means another `show_panel` can never silently unmount a pending form — it gets a tab, and the form stays active until resolved.
4. **Pop-out preserves the promise:** `popOut` flips `surface`, re-emits `panel:show` to the companion (where `FormPanel` re-mounts and submits via `window.companionApi.submitForm` — the other branch, same IPC, same `submitForm`), and sends `panel:hide` to the **main window only** — it does **NOT** call `PanelService.hide`. The promise survives untouched, and on the companion submit `submitForm` (F3) routes `panel:hide` to both, clearing the now-empty main mirror.

### B.5 — `CompanionService.focus()`
A create-allowed sibling of `focusIfOpen` (which stays create-free for the OS-notification contract). It chains off the existing `readyPromise` so `show()/moveTop()` happen after `did-finish-load`.

### B.6 — Renderer-opened panels (#1, #18, #19-23) keep working
They already call `window.api.showPanel` → `panel:show` IPC → `PanelService.show` → now `surface:"modal"` → ModalHost. Their accessors resolve through the `api` object (A.1) built over `window.api`. Worktree-review's Approve/Reject (`api.approveWorktreeTask`), SessionOverview's promote (`api.promoteSessionToWorkspace`, F1-added), Mission's Stop/Pause (`api.missionStop/Pause`), Diff's send-review (`api.sendToSession`), workspace-memory's mutators, context-inspector's inspect, recall's row-click-to-overview (`api.openSessionOverview`, F1-added) all run against `window.api` equivalents.

### B.7 — Retire/guard `PanelDrawer.tsx`
Stale (missing recall/workspace-memory/context-inspector/worktree-review) and unmounted. **S5 greps for any live import before deleting** (the plan claims "unmounted" — verify, don't assert).

---

## (C) Item 2 — kill block click-to-open, add per-block top-right button

**Source of truth:** a block has a detail view iff `panelForBlock(block) != null` (`src/lib/agentTranscript.ts:483-515`). Buttons appear on exactly 4 kinds: `assistant`, `tool`, `result`, `raw` — the same 4 that have `onClick={onExpand}` today. `user`/`thinking`/`error`/`model_error`/`needs_auth` never had click-to-open → no button → **nothing regresses** (state this explicitly in S4 so reviewers don't flag missing affordances on those kinds).

### C.1 — Remove whole-block click (keep `expand`/`onExpand` logic — only the trigger moves)
- `AssistantBlock` (`AgentView.tsx:575-580`): remove `onClick={onExpand}` + `title`.
- `ToolView` (`:688-693`): remove `onClick={onExpand}` + `title`.
- `ResultView` (`:704-706`): remove `onClick={onExpand}` + `title` from the `agent-result-text` div.
- `raw` case in `BlockView` (`:653-657`): remove `onClick={onExpand}` + `title`.

### C.2 — Pure helper `expandLabelForBlock(block): {label, compact} | null` in `agentTranscript.ts`
Drives the label off the resolved panel type (never drifts from what opens). **Resolve M1: compact icon-only for dense rows, text label for prose blocks:**

| Kind | Condition | Rendering |
|---|---|---|
| `tool` | edit/multiedit/write → diff | icon-only `⤢`, `title="Open diff"` |
| `tool` | other → markdown | icon-only `⤢`, `title="Open tool I/O"` |
| `raw` | code | icon-only `⤢`, `title="Open raw event"` |
| `assistant` | markdown | `⤢ Open in markdown` (text) |
| `result` | markdown | `⤢ Open result` (text) |

Icon-only on `tool`/`raw` avoids the summary-squeeze the always-on label causes on narrow panes (the `title` carries the full label for discoverability/accessibility); text label stays on the lower-frequency `assistant`/`result`. The helper returns `{ label, compact }`. Drift-pin test: `expandLabelForBlock(b) != null` ⟺ `panelForBlock(b) != null` across one fixture per kind.

### C.3 — `BlockExpandButton` (`src/components/BlockExpandButton.tsx`), statically visible
```tsx
<button type="button" className={`agent-block-expand ${compact ? "compact" : ""}`}
        onClick={(e) => { e.stopPropagation(); onExpand() }} title={label} aria-label={label}>
  <span aria-hidden="true">⤢</span>{compact ? null : <span className="agent-block-expand-text">{label}</span>}
</button>
```
`BlockView` computes `const ex = expandLabelForBlock(block)` once and passes it down; each per-kind component renders the button **only when `ex != null`**.

### C.4 — Placement
- `ToolView`, `raw`: append as last flex child, `margin-left:auto`; give the summary `min-width:0; overflow:hidden` so the (now compact) button always wins without crushing the summary text.
- `AssistantBlock` (resolve M2 — streaming interaction): the assistant block is the actively-streaming surface, and the WS5 caret + CAPP-77 `:last-child` reveal are fragile (stream-reveal-flicker-trap). **Render the assistant button ONLY when the block is settled (`!streaming`)** — gate on the same stable whole-turn flag the reveal animation uses, so the button never appears over reveal-animated text or the caret. Placement: `position:relative` on the block root, button `position:absolute; top; right`, **kept OUTSIDE `.markdown-body` flow**. Reserve top-right padding on the settled block so the absolute button never overlaps a long first line/heading.
- `ResultView`: `position:relative` on the block root, button absolute top-right (the meta row is bottom — no collision).

### C.5 — CSS
`.agent-block-expand`: small font, muted border + subtle bg (match `.agent-load-earlier-btn`/`.agent-cost-chip`), `border-radius`/`padding` tokens, **full opacity at rest** (no `:hover` reveal). `.agent-block-expand.compact` drops the text span, icon-only square. Drop the now-orphaned clickable cursor/hover styles on `.agent-tool`/`.agent-raw`/`.agent-result-text`.

`expand` (`:383-391`) → `window.api.showPanel(req.type, req.props)` is **unchanged** — only the trigger moves; under §B that call now lands in the ModalHost. Item 2 changes the trigger; item 3 changes the destination — they compose cleanly. **S4 confirms with a screenshot** (icon-only density on a multi-tool transcript; assistant button absent during stream, present when settled).

---

## (D) Item 4 — off-screen positioning fix (multi-monitor)

**New pure file `electron/services/companionPlacement.ts`** (zero electron-runtime imports → node-testable, like `sessionRow.ts`). **All math is in DIP** (Electron `screen` bounds/workArea AND `BrowserWindow` x/y are both DIP/scale-independent — resolve M4: no `devicePixelRatio` enters this function, ever):

```ts
export interface Rect { x: number; y: number; width: number; height: number }
/** Pure, DIP-only. Never reads devicePixelRatio — screen + window coords are both DIP. */
export function placeCompanion(
  main: Rect, size: { width: number; height: number }, workArea: Rect, gutter = 8,
): { x: number; y: number } {
  const rightX = main.x + main.width + gutter
  const leftX  = main.x - size.width - gutter
  let x =
    rightX + size.width <= workArea.x + workArea.width ? rightX        // fits right
    : leftX >= workArea.x ? leftX                                       // else left
    : workArea.x + workArea.width - size.width                         // else flush-right overlap
  let y = main.y
  const maxX = workArea.x + workArea.width  - size.width
  const maxY = workArea.y + workArea.height - size.height
  x = Math.max(workArea.x, Math.min(x, maxX))                          // hard clamp both axes
  y = Math.max(workArea.y, Math.min(y, maxY))
  return { x, y }
}
```

**In `companion.ts`:** import `screen`; add a `protected computePlacement(size)` (overridable so `TestCompanionService` stubs it — keeps `companion.test.ts`'s `FakeWindow` seam intact, since the screen API is never called inline):
```ts
import { BrowserWindow, screen } from "electron"
protected computePlacement(size: { width: number; height: number }): { x?: number; y?: number } {
  const main = this.mainWin?.getBounds()
  if (!main) return {}                                   // no main → let Electron center
  const center = { x: main.x + Math.floor(main.width / 2), y: main.y + Math.floor(main.height / 2) }
  const display = screen.getDisplayNearestPoint(center)  // monitor where the main window mostly lives
  return placeCompanion(main, size, display.workArea)    // workArea excludes taskbar/dock
}
```
Replace `companion.ts:42-55` so `createWindow` does `const size = {width:680,height:860}; const {x,y} = this.computePlacement(size)` and passes `width:size.width,height:size.height,x,y`. `display.workArea` (not `bounds`) clears the taskbar; `getDisplayNearestPoint(center)` always returns a live display (handles a maximized main and a since-unplugged monitor).

**Tests** `companionPlacement.test.ts`: right-fits; falls back left; overlap flush-right clamp; window wider than work area (left edge stays visible — `Math.max(workArea.x, …)` wins); multi-monitor negative-origin display; **DIP purity** (identical output regardless of any ambient scale — assert the function reads no global); **main-window-center-in-dead-space** (center between two monitors → nearest live display chosen, result clamped on-screen). The readiness gate / `did-finish-load` / `getOrCreate` / `close` / `focusIfOpen` are untouched.

---

## (E) Phasing — S-prefixed CAPP units, dependency order

- **CAPP-S0 — Companion off-screen clamp (item 4).** `companionPlacement.ts` + `placeCompanion` + `computePlacement` + tests. Self-contained, no renderer change. **Independently valuable** — it fixes the current off-screen bug immediately (the companion is still auto-created on every `show` until S2; that's fine and desirable to fix now). **S3 depends on S0** (a pop-out must land on-screen); S0 depends on nothing and is NOT blocked on pop-out. *Depends on: nothing.*
- **CAPP-S1 — Extract shared `PanelContent` + the typed `PanelApi` + parameterize the 8 behavior panels + ADD the two missing `window.api` accessors.** `src/components/panels/PanelContent.tsx` (the real switch with all 6 callbacks derived from `api`); extract `tabLabel`/`PANEL_LABELS`; `src/lib/panelApi.ts` (the `PanelApi` interface = the audit manifest, A.3); convert #1/#18/#19-23 to consume `api`; **add `openSessionOverview` + `promoteSessionToWorkspace` to `electron/preload.ts` + their IPC handlers (F1)**; the type-parity GATE test (A.2). Per-panel render-with-mock-`api` tests, incl. RecallPanel's empty-`api` negative control (A.4) and worktree-review/mission/diff callback wiring. No routing change yet (still companion-only). *Depends on: nothing.* **Hard prerequisite for S2.**
- **CAPP-S2 — ModalHost + modal-by-default routing + the tab strip + form-exclusivity (item 3 core).** `PanelState.surface`; `PanelService.setMainBridge` + `route` + `routeAll` (incl. `submitForm` in the routed set — F3); `ipc.ts` wires the main bridge BEFORE any `show`-capable handler/MCP start (M5/B.2) with an ordering assertion; `ModalHost.tsx` mounted in `App.tsx` off `usePanels`, with `useActivePanel` (form-exclusive) + the multi-panel tab strip (A.6); CSS + reduced-motion list. Integration tests: `showForm` → modal renders → `submitForm` resolves the promise + clears BOTH mirrors; Escape/backdrop/tab-close → `hidePanel` → `cancelled:true`; **`show_form` then `show_panel` → form stays active, markdown gets a tab, form still submittable** (the M2 strand-guard). *Depends on: S1.*
- **CAPP-S3 — Pop-out plumbing.** `PanelService.popOut`; `CompanionService.focus`; `panel:pop-out` IPC + preload; modal "⤢ Pop out" button. Tests: pop-out flips `surface`, emits to companion, hides the main modal, does NOT cancel a pending form; **post-pop-out companion submit clears the main mirror (F3 regression test)**; popped-out form completes via the companion branch. **Resolve M4 — popped-out live-refresh ownership:** before S3 lands, TRACE which window refreshes a popped-out `mission`/`session-overview`. Today `usePanels`' refresh effects are main-side-only (`setPanels` locally, no re-emit to companion). After pop-out the panel leaves the main mirror, so those effects stop driving it. Verify the companion's own refresh path (the `mission:updated` push consumed by `CompanionApp`/usePanels-companion, and `update_panel` from the agent) keeps a popped-out mission/overview live; if NOT, S3 adds a main→companion `panel:update` re-emit for `surface:"window"` panels (the refresh effect calls `panelService.update`, which already `route`s to the companion when `surface==="window"` — confirm the overview/mission refresh goes THROUGH `panelService.update` and not a renderer-local `setPanels`). This trace is a S3 acceptance gate. *Depends on: S2 (+ S0 for safe placement).*
- **CAPP-S4 — Per-block expand button (item 2).** `expandLabelForBlock` (with `compact`) + drift-pin test; `BlockExpandButton` (icon-only compact / text variants); remove the 4 whole-block `onClick`s; render on the 4 kinds; assistant button gated on `!streaming` (M2); CSS; drop orphaned clickable styles; e2e (button visible without hover, click opens the modal) + a density screenshot. *Depends on: nothing functionally; pairs naturally after S2 so the click lands in the modal.*
- **CAPP-S5 — Retire `PanelDrawer.tsx`.** Grep for any live import (verify "unmounted"); delete once `PanelContent` is the single switch. *Depends on: S1.*

**Order:** S0 → S1 → S2 → S3, with S4 anytime after S2 and S5 anytime after S1.

---

## (F) Risks + hard-constraint compliance

1. **`show_form` orphaning (highest).** Any modal-close path bypassing `panel:hide`/`submitForm` hangs the MCP call forever. Mitigation: ModalHost close/backdrop/Escape/tab-close **all** call `window.api.hidePanel(id)` (resolves `cancelled:true`); `popOut` sends `panel:hide` to the main window only (never `PanelService.hide`); **form-exclusive selection (A.6) prevents a later `show_panel` from silently unmounting a pending form** — it always has a visible tab. Integration tests cover submit-resolves, cancel-resolves, and the form-behind-panel strand-guard; e2e drives a real `show_form`.
2. **`companionApi` absence + `window.api` non-parity (F1).** `openSessionOverview`/`promoteSessionToWorkspace` are NOT on `window.api` — **S1 adds them + their IPC handlers**, and the `PanelApi` type-parity test is a **build GATE** (would have caught this). RecallPanel's guard degrades to EMPTY not graceful (A.4) — its `api` must carry both `recall` and `openSessionOverview`. #1/#18/#23's callbacks are folded into the `api` object, not dropped (F2).
3. **Zombie main-mirror form state (F3).** `submitForm` formerly notified the companion only → after a popped-out submit, the main mirror kept the resolved panel as `visible:true`. Mitigation: `submitForm` joins the routed set (B.1), routing `panel:hide` to BOTH surfaces; S3 has a dedicated regression test.
4. **Double-render of forms.** `surface:"modal"` default means `route` reaches the companion only after pop-out — a form lives in exactly one surface at a time. `submitForm` is idempotent (`pendingForms.delete` guards the second call).
5. **No hover-reveal (HARD rule).** The modal's "⤢ Pop out"/×, every tab, and every per-block expand control are `opacity:1` static (icon-only where compact, never `:hover`-revealed). Put this verbatim in the S2/S4 dispatch prompts (agents keep defaulting to hover).
6. **Streaming interaction (M2).** The assistant-block button renders only when settled (`!streaming`), gated on the stable whole-turn flag, outside `.markdown-body` — protects the WS5 caret + CAPP-77 reveal (stream-reveal-flicker-trap).
7. **Design-token reuse.** ModalHost clones the KillSessionModal skeleton — `useFocusTrap`, `role="dialog" aria-modal`, `onMouseDown` backdrop dismiss + panel `stopPropagation`, Escape on the panel — and uses only `var(--bg-1)/--border-strong/--r-lg/--shadow-3/--accent-soft/--s-*/--ease-out`, the shared `cmdk-pop`/`drop-fade` keyframes + the reduced-motion list. z-index 2000 clears the companion-presence pill (TabBar, z~50).
8. **Companion-presence pill (D1).** `usePanels` tracks `panel:show/update/hide` regardless of surface, so the open-count keeps working; after S2 it counts modal-hosted panels too. Clicking it (`companion:focus`) focuses the companion if one was popped out, else focuses an empty/closed window — a known UX inconsistency, **flagged in the S2 dispatch so it isn't reported as a bug**; relabel/repurpose deferred to a later ticket (no regression).
9. **Live-refresh ownership (M4).** Mission/overview refresh keys on `props.id` not `panel-N`; the modal's tab identity is `panel.id` while refresh-match is `props.id` (both spelled out, D2). Popped-out live-refresh ownership is a **S3 acceptance gate** (see S3) — ensure the refresh path routes `panel:update` to the companion for `surface:"window"` panels.
10. **`route` panel-less channel.** `hideAll`'s `panel:hide-all` has no `panel`; `routeAll` (B.1) handles it. `setMainBridge` ordering (M5/B.2) is a wiring gate, asserted in `ipc.ts`.

**Key files touched:** `src/components/ModalHost.tsx` (new), `src/components/BlockExpandButton.tsx` (new), `src/components/panels/PanelContent.tsx` (new — extracted, full 6-callback switch), `src/lib/panelApi.ts` (new — `PanelApi` contract + parity test), `src/lib/modalActivePanel.ts` (new — form-exclusive selection, tested), `electron/services/companionPlacement.ts` (new) + test; `electron/services/panels.ts` (`PanelState.surface`, `setMainBridge`, `route`/`routeAll`, `submitForm` routed, `popOut`), `electron/services/companion.ts` (`computePlacement`, `focus`), `electron/ipc/panel-handlers.ts` (`panel:pop-out`, `worksession:open-overview`), `electron/preload.ts` (`popOutPanel`, `openSessionOverview`, `promoteSessionToWorkspace`), `electron/ipc.ts` (wire main bridge — ordered before any `show`-capable handler/MCP start), `src/App.tsx` (mount ModalHost), `src/companion/CompanionApp.tsx` (import shared `PanelContent`/`tabLabel`, build `PanelApi` over `companionApi`), `src/components/AgentView.tsx` + `src/lib/agentTranscript.ts` (`expandLabelForBlock`, button gating), the #1/#18/#19-23 panels (consume `api`), `src/App.css` (modal + tab + button styles, reduced-motion list); delete `src/components/PanelDrawer.tsx` (after import grep).
