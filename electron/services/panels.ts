import { BrowserWindow } from "electron"

export interface PanelState {
  id: string
  type: string // "diff" | "form" | "image" | "markdown" | "table"
  position: "right" | "bottom"
  width?: number // percentage for right drawer
  height?: number // percentage for bottom drawer
  props: Record<string, any>
  visible: boolean
}

export class PanelService {
  private panels = new Map<string, PanelState>()
  private mainWin: BrowserWindow | null = null
  private nextId = 1

  // Pending form submissions: panelId -> resolver. Used by form panels so the
  // MCP tool call can stay open until the user submits (Task 2.2).
  private pendingForms = new Map<string, (data: Record<string, any>) => void>()

  setMainWindow(win: BrowserWindow) {
    this.mainWin = win
  }

  private sendToRenderer(channel: string, ...args: unknown[]) {
    if (this.mainWin && !this.mainWin.isDestroyed()) {
      this.mainWin.webContents.send(channel, ...args)
    }
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
    this.sendToRenderer("panel:show", panel)
    return panel
  }

  update(id: string, props: Record<string, any>): boolean {
    const panel = this.panels.get(id)
    if (!panel) return false
    panel.props = { ...panel.props, ...props }
    this.sendToRenderer("panel:update", { id, props: panel.props })
    return true
  }

  hide(id: string): boolean {
    const panel = this.panels.get(id)
    if (!panel) return false
    panel.visible = false
    this.panels.delete(id)
    this.sendToRenderer("panel:hide", id)
    // If a form was waiting on this panel, resolve it as cancelled
    const resolver = this.pendingForms.get(id)
    if (resolver) {
      resolver({ cancelled: true })
      this.pendingForms.delete(id)
    }
    return true
  }

  hideAll(): void {
    for (const id of this.panels.keys()) {
      this.sendToRenderer("panel:hide", id)
    }
    this.panels.clear()
    for (const [id, resolver] of this.pendingForms) {
      resolver({ cancelled: true })
      this.pendingForms.delete(id)
    }
    this.sendToRenderer("panel:hide-all")
  }

  list(): PanelState[] {
    return Array.from(this.panels.values())
  }

  /** Show a form panel and return a promise that resolves with submitted data. */
  showForm(props: Record<string, any>, position?: string): Promise<Record<string, any>> {
    const panel = this.show("form", props, position)
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
    }
    this.panels.delete(id)
    this.sendToRenderer("panel:hide", id)
  }
}
