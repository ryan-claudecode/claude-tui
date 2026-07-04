import { ipcMain, BrowserWindow } from "electron"
import type { PanelService } from "../services/panels"
import type { NotificationService } from "../services/notifications"
import type { CompanionService } from "../services/companion"
import type { TerminalService } from "../services/terminals"

export function registerPanelHandlers(deps: {
  panelService: PanelService
  notificationService: NotificationService
  companionService: CompanionService
  sessionService: TerminalService
}) {
  const { panelService, notificationService, companionService, sessionService } =
    deps

  // Panel IPC
  ipcMain.handle("panel:list", () => panelService.list())
  ipcMain.handle(
    "panel:show",
    (_e, type: string, props: Record<string, any>, position?: string) =>
      panelService.show(type, props, position),
  )
  ipcMain.handle("panel:hide", (_e, id: string) => panelService.hide(id))
  ipcMain.handle("panel:hide-all", () => panelService.hideAll())
  // CAPP-110 / S3 — pop a modal panel out to the companion window. MAIN-window only
  // (a user gesture, NOT MCP-exposed). Preserves a pending show_form's promise.
  ipcMain.handle("panel:pop-out", (_e, id: string) => panelService.popOut(id))
  ipcMain.on("panel:form-submit", (_e, id: string, data: Record<string, any>) =>
    panelService.submitForm(id, data),
  )

  // Companion window IPC
  ipcMain.on("companion:close", () => companionService.close())
  ipcMain.on("companion:focus", () => companionService.focusIfOpen())
  ipcMain.on("companion:minimize", (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
  })
  ipcMain.on("companion:maximize", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win?.isMaximized()) win.unmaximize()
    else win?.maximize()
  })
  ipcMain.on("companion:send-to-session", (_e, text: string) => {
    const terminals = sessionService.list()
    const active = terminals.find((t) => t.state === "active")
    if (active) sessionService.write(active.id, text + "\n")
  })

  // Notification IPC
  ipcMain.handle("notification:list", () => notificationService.list())
  ipcMain.handle("notification:dismiss", (_e, id: string) =>
    notificationService.dismiss(id),
  )
}
