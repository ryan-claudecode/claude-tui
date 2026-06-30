import { BrowserWindow } from "electron"

export interface PanelState {
  id: string
  type: string
  position: "right" | "bottom"
  width?: number
  height?: number
  props: Record<string, any>
  visible: boolean
  /**
   * CAPP-109 / S2 — which surface a panel lives on. **Default `"modal"`** — a fresh
   * panel renders in the in-main-window ModalHost and NEVER touches the companion
   * bridge (so a `show_panel`/`show_form` no longer auto-creates the companion window).
   * `"window"` is set ONLY by `popOut` (S3), after which `route` ALSO emits to the
   * companion so the popped-out panel mirrors there.
   */
  surface: "modal" | "window"
}

interface CompanionBridge {
  sendToCompanion(channel: string, ...args: unknown[]): void
  close(): void
  /**
   * CAPP-110 / S3 — raise the companion window to the top, CREATING it if needed
   * (the create-ALLOWED sibling of `focusIfOpen`). Optional so test bridges that
   * don't model focus stay valid. `popOut` calls it to bring the just-popped-out
   * panel forward.
   */
  focus?(): void
}

/**
 * CAPP-109 / S2 — the MAIN-window bridge (a thin `{ send }` over the main
 * `BrowserWindow.webContents`). `route` ALWAYS writes here so the ModalHost mirror
 * (usePanels) stays current — this is the modal-by-default surface. Wired in `ipc.ts`
 * via `setMainBridge` BEFORE any IPC handler that can call `show` and before the MCP
 * server starts (the modal path has no lazy-create mask, so ordering is load-bearing).
 */
export interface MainBridge {
  send(channel: string, ...args: unknown[]): void
}

/** Where a form originated — the MCP caller's bound work-session/terminal. */
export interface FormOrigin {
  sessionId?: string
  terminalId?: string
}

/**
 * Observable form lifecycle, consumed by AttentionService for tier-1 `blocked`
 * entries. PanelService already holds the pending promise; these events just
 * make the pending/resolved moments observable without changing form behavior.
 */
export type PanelEvent =
  | { type: "form-pending"; panelId: string; origin: FormOrigin }
  | { type: "form-resolved"; panelId: string }

export class PanelService {
  private panels = new Map<string, PanelState>()
  private companion: CompanionBridge | null = null
  private mainBridge: MainBridge | null = null
  private nextId = 1

  // Pending form submissions: panelId -> resolver. Used by form panels so the
  // MCP tool call can stay open until the user submits (Task 2.2).
  private pendingForms = new Map<string, (data: Record<string, any>) => void>()

  // Subscribers to form-pending/resolved — the AttentionService seam. Mirrors
  // TerminalService's `eventListeners`/`onEvent` callback-set style.
  private eventListeners = new Set<(e: PanelEvent) => void>()

  /** Subscribe to form lifecycle events. Returns an unsubscribe fn. */
  onEvent(cb: (e: PanelEvent) => void): () => void {
    this.eventListeners.add(cb)
    return () => this.eventListeners.delete(cb)
  }

  private emitEvent(e: PanelEvent): void {
    for (const cb of this.eventListeners) cb(e)
  }

  setCompanion(companion: CompanionBridge) {
    this.companion = companion
  }

  /**
   * CAPP-109 / S2 — wire the MAIN-window bridge. MUST be called (in `ipc.ts`) BEFORE
   * any IPC handler that can call `show` is registered AND before the MCP server starts
   * (an early/auto-restore `show_panel` would otherwise be silently dropped — the modal
   * path has no lazy-create mask like the companion's). See the ordering comment + the
   * no-bridge log/assert in `show`.
   */
  setMainBridge(bridge: MainBridge) {
    this.mainBridge = bridge
  }

  /** @deprecated Use setCompanion instead. Kept temporarily for any stray callers. */
  setMainWindow(_win: BrowserWindow) {
    // no-op — companion bridge replaces this
  }

  private sendToCompanion(channel: string, ...args: unknown[]) {
    this.companion?.sendToCompanion(channel, ...args)
  }

  /**
   * CAPP-109 / S2 — route a PANEL-scoped event. ALWAYS emit to the main bridge (the
   * ModalHost mirror is the default surface); ALSO emit to the companion when this panel
   * was popped out (`surface === "window"`). A default-`modal` panel therefore never
   * touches the companion bridge → the companion window is never auto-created.
   */
  private route(panel: PanelState, channel: string, ...args: unknown[]) {
    if (this.mainBridge) {
      this.mainBridge.send(channel, ...args)
    } else if (channel === "panel:show") {
      // M5/B.2 — a `show` fired before the main bridge was wired. The modal can't render
      // it (the mirror never received it). Loud, but non-fatal. This should be impossible
      // given the `ipc.ts` wiring order; the log makes a regression in that order visible.
      console.error(
        "[PanelService] route(panel:show) with no main bridge — setMainBridge must be " +
          "wired before any show-capable handler/MCP start (CAPP-109 / B.2).",
      )
    }
    if (panel.surface === "window") {
      this.sendToCompanion(channel, ...args)
    }
  }

  /**
   * CAPP-109 / S2 — route a PANEL-LESS event (`panel:hide-all`). No `panel` to key off,
   * so emit to the main bridge ALWAYS and to the companion unconditionally — `hide-all`
   * is a harmless clear-everything signal even if the companion is closed.
   */
  private routeAll(channel: string, ...args: unknown[]) {
    this.mainBridge?.send(channel, ...args)
    this.sendToCompanion(channel, ...args)
  }

  show(type: string, props: Record<string, any>, position?: string): PanelState {
    const id = `panel-${this.nextId++}`
    const panel: PanelState = {
      id,
      type,
      position: position === "bottom" ? "bottom" : "right",
      props,
      visible: true,
      // CAPP-109 / S2 — modal-by-default. Pop-out (S3) flips this to "window".
      surface: "modal",
    }
    this.panels.set(id, panel)
    this.route(panel, "panel:show", panel)
    return panel
  }

  update(id: string, props: Record<string, any>): boolean {
    const panel = this.panels.get(id)
    if (!panel) return false
    panel.props = { ...panel.props, ...props }
    this.route(panel, "panel:update", { id, props: panel.props })
    return true
  }

  hide(id: string): boolean {
    const panel = this.panels.get(id)
    if (!panel) return false
    panel.visible = false
    this.panels.delete(id)
    this.route(panel, "panel:hide", id)
    // If a form was waiting on this panel, resolve it as cancelled
    const resolver = this.pendingForms.get(id)
    if (resolver) {
      resolver({ cancelled: true })
      this.pendingForms.delete(id)
      this.emitEvent({ type: "form-resolved", panelId: id })
    }
    return true
  }

  hideAll(): void {
    for (const [, panel] of this.panels) {
      this.route(panel, "panel:hide", panel.id)
    }
    this.panels.clear()
    for (const [id, resolver] of this.pendingForms) {
      resolver({ cancelled: true })
      this.emitEvent({ type: "form-resolved", panelId: id })
    }
    this.pendingForms.clear()
    this.routeAll("panel:hide-all")
  }

  list(): PanelState[] {
    return Array.from(this.panels.values())
  }

  /**
   * Show a form panel and return a promise that resolves with submitted data.
   * `origin` attributes the form to the MCP caller's work-session/terminal so the
   * attention queue can show "who is blocked"; it does not change form behavior.
   */
  showForm(
    props: Record<string, any>,
    position?: string,
    origin: FormOrigin = {},
  ): Promise<Record<string, any>> {
    const panel = this.show("form", props, position)
    this.emitEvent({ type: "form-pending", panelId: panel.id, origin })
    return new Promise((resolve) => {
      this.pendingForms.set(panel.id, resolve)
    })
  }

  /** Called from the renderer (via IPC) when a form is submitted. */
  submitForm(id: string, data: Record<string, any>): void {
    const resolver = this.pendingForms.get(id)
    if (resolver) {
      resolver(data)
      this.pendingForms.delete(id)
      this.emitEvent({ type: "form-resolved", panelId: id })
    }
    // CAPP-109 / S2 (F3) — capture the panel and ROUTE `panel:hide` to BOTH surfaces
    // (per the panel's surface) BEFORE deleting it, so neither the main mirror nor the
    // companion keeps a zombie of the now-resolved form. Previously this notified the
    // companion ONLY — after a popped-out submit the main mirror kept the panel
    // `visible:true` and a ModalHost could re-select it. Capture first (delete drops it).
    const panel = this.panels.get(id)
    this.panels.delete(id)
    if (panel) {
      this.route(panel, "panel:hide", id)
    } else {
      // No tracked panel (shouldn't happen) — fall back to clearing both surfaces.
      this.routeAll("panel:hide", id)
    }
  }

  /**
   * CAPP-110 / S3 — move a modal panel OUT to the companion window (a user gesture,
   * NOT MCP-exposed). Flips `surface` to `"window"`, re-emits `panel:show` to the
   * companion (lazily creating the clamped companion window — S0), raises it, and
   * drops the panel from the MAIN mirror ONLY (so the ModalHost unmounts it).
   *
   * CRITICAL form-safety: this sends `panel:hide` to the main bridge DIRECTLY — it
   * MUST NOT call `this.hide(id)`, which would resolve a pending `show_form` as
   * `{cancelled:true}` and orphan the MCP call. The panel stays in `this.panels` and
   * the pending-form promise survives the pop-out untouched; after pop-out the
   * companion `FormPanel` re-mounts and submits via the same `submitForm` seam.
   */
  popOut(id: string): boolean {
    const panel = this.panels.get(id)
    if (!panel) return false
    panel.surface = "window"
    this.companion?.sendToCompanion("panel:show", panel) // lazily creates the companion (S0)
    this.companion?.focus?.() // raise it (CompanionService.focus — create-allowed)
    this.mainBridge?.send("panel:hide", id) // drop from the MAIN mirror ONLY
    return true
  }

  /**
   * CAPP-110 / S3 — the companion window closed (× / OS / app teardown). Every panel
   * that lives THERE is `surface:"window"` (only pop-outs ever flip to it), and the
   * window destroying takes them with it — so reconcile our state:
   *
   *  1. **Form-safety:** resolve any pending `show_form` on a popped-out panel as
   *     `{cancelled:true}`. The MAIN-window close paths already do this via `hide()`;
   *     the companion close had NO equivalent, so popping a form out then closing the
   *     companion (instead of submitting) orphaned the held-open MCP call forever.
   *  2. **No ghost resurrection:** drop the panel from `this.panels` so a later M4
   *     live-refresh (`update` → `route` → `sendToCompanion` → `getOrCreate`) can't
   *     re-spawn the companion the user just closed.
   *
   * Routes `panel:hide` to the MAIN bridge so any stale main-mirror entry clears too
   * (it shouldn't have one — pop-out already dropped it — but this is cheap + safe).
   * Does NOT touch the companion bridge (the window is gone).
   */
  dismissWindowPanels(): void {
    for (const [id, panel] of [...this.panels]) {
      if (panel.surface !== "window") continue
      this.panels.delete(id)
      this.mainBridge?.send("panel:hide", id)
      const resolver = this.pendingForms.get(id)
      if (resolver) {
        resolver({ cancelled: true })
        this.pendingForms.delete(id)
        this.emitEvent({ type: "form-resolved", panelId: id })
      }
    }
  }
}
