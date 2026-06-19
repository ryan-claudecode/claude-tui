import { BrowserWindow } from "electron"

export interface PanelState {
  id: string
  type: string
  position: "right" | "bottom"
  width?: number
  height?: number
  props: Record<string, any>
  visible: boolean
}

interface CompanionBridge {
  sendToCompanion(channel: string, ...args: unknown[]): void
  close(): void
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

  /** @deprecated Use setCompanion instead. Kept temporarily for any stray callers. */
  setMainWindow(_win: BrowserWindow) {
    // no-op — companion bridge replaces this
  }

  private sendToCompanion(channel: string, ...args: unknown[]) {
    this.companion?.sendToCompanion(channel, ...args)
  }

  show(type: string, props: Record<string, any>, position?: string): PanelState {
    const id = `panel-${this.nextId++}`
    const panel: PanelState = {
      id,
      type,
      position: position === "bottom" ? "bottom" : "right",
      props,
      visible: true,
    }
    this.panels.set(id, panel)
    this.sendToCompanion("panel:show", panel)
    return panel
  }

  update(id: string, props: Record<string, any>): boolean {
    const panel = this.panels.get(id)
    if (!panel) return false
    panel.props = { ...panel.props, ...props }
    this.sendToCompanion("panel:update", { id, props: panel.props })
    return true
  }

  hide(id: string): boolean {
    const panel = this.panels.get(id)
    if (!panel) return false
    panel.visible = false
    this.panels.delete(id)
    this.sendToCompanion("panel:hide", id)
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
    for (const id of this.panels.keys()) {
      this.sendToCompanion("panel:hide", id)
    }
    this.panels.clear()
    for (const [id, resolver] of this.pendingForms) {
      resolver({ cancelled: true })
      this.emitEvent({ type: "form-resolved", panelId: id })
    }
    this.pendingForms.clear()
    this.sendToCompanion("panel:hide-all")
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
    this.panels.delete(id)
    this.sendToCompanion("panel:hide", id)
  }
}
