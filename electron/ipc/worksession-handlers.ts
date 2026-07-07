import { ipcMain } from "electron"
import type { SessionService } from "../services/sessions"
import type { PanelService } from "../services/panels"

export function registerWorkSessionHandlers(deps: {
  workSessionService: SessionService
  /**
   * CAPP-106 / S1 (F1) — used ONLY by `worksession:open-overview` to SHOW the fetched
   * overview as a panel (the main-window parity for the companion's `openSessionOverview`).
   * Injected so the handler stays decoupled from the panel layer; absent → open-overview is
   * a no-op returning null.
   */
  panelService?: PanelService
}) {
  const { workSessionService, panelService } = deps

  // Work-session (container) IPC -- the durable session tier above terminals
  ipcMain.handle("worksession:list", () => workSessionService.list())
  ipcMain.handle("worksession:open", (_e, cwd?: string) => workSessionService.openSession(cwd))
  ipcMain.handle("worksession:add-terminal", (_e, sessionId: string, cwd?: string) =>
    workSessionService.addTerminalToSession(sessionId, cwd),
  )
  // CAPP-75 — list every Claude Code conversation discoverable for a folder
  // (including ones started OUTSIDE the app), newest first. Read-only.
  ipcMain.handle("worksession:list-folder-conversations", (_e, folder: string) =>
    workSessionService.listFolderConversations(folder),
  )
  // CAPP-75 — restore a discovered conversation: spawn a fresh terminal running
  // `claude --resume <id>` with cwd=folder in a new work session bound to it.
  ipcMain.handle(
    "worksession:restore-conversation",
    (_e, folder: string, conversationId: string) =>
      workSessionService.openConversationInFolder(folder, conversationId),
  )
  ipcMain.handle("worksession:reopen-terminal", (_e, sessionId: string, terminalId: string) =>
    workSessionService.reopenTerminal(sessionId, terminalId),
  )
  ipcMain.handle("worksession:close-terminal", (_e, sessionId: string, terminalId: string) =>
    workSessionService.closeTerminal(sessionId, terminalId),
  )
  ipcMain.handle("worksession:kill", (_e, sessionId: string) =>
    workSessionService.killSession(sessionId),
  )
  // CAPP-82 — rename the durable work-session container (the sidebar row). Distinct
  // from `terminal:rename` (the terminal-tier rename); returns whether it applied.
  ipcMain.handle("worksession:rename", (_e, sessionId: string, newName: string) =>
    workSessionService.renameSession(sessionId, newName),
  )
  ipcMain.handle("worksession:overview", (_e, sessionId: string) =>
    workSessionService.getOverview(sessionId),
  )
  // CAPP-106 / S1 (F1) — fetch a session's overview and SHOW it as a panel. The
  // main-window parity for the companion's `openSessionOverview`. Returns the new
  // panel (or null when there's no overview / no panel layer wired).
  ipcMain.handle("worksession:open-overview", (_e, sessionId: string) => {
    const overview = workSessionService.getOverview(sessionId)
    if (!overview || !panelService) return null
    return panelService.show("session-overview", overview, "right")
  })
  ipcMain.handle("worksession:handoff", (_e, sessionId: string, terminalId: string) =>
    workSessionService.handoffTerminal(sessionId, terminalId),
  )
  // CAPP-132 — the Agent Rail OUTPUTS feed: read the current FIFO snapshot (mount /
  // active-session switch), remove one entry (the row ✕), or clear the whole feed
  // (the section header Clear). Live updates ride the worksession:outputs-changed push.
  ipcMain.handle("worksession:get-outputs", (_e, sessionId: string) =>
    workSessionService.getOutputs(sessionId),
  )
  ipcMain.handle("worksession:remove-output", (_e, sessionId: string, outputId: string) =>
    workSessionService.removeOutput(sessionId, outputId),
  )
  ipcMain.handle("worksession:clear-outputs", (_e, sessionId: string) =>
    workSessionService.clearOutputs(sessionId),
  )
  // CAPP-39 gate ② — launch a one-time INTERACTIVE `claude /login` terminal (the
  // structured engine can't show the OAuth UI). Lands beside the caller's session.
  ipcMain.handle("worksession:start-login", (_e, sessionId?: string) =>
    workSessionService.startLogin(sessionId),
  )
  // BO-6 — switch a structured terminal's model (respawns it, resuming the same
  // conversation with the new --model).
  ipcMain.handle(
    "worksession:set-terminal-model",
    (_e, sessionId: string, terminalId: string, model: string) =>
      workSessionService.setTerminalModel(sessionId, terminalId, model),
  )
  // CAPP-46 — switch a structured terminal's reasoning effort level (respawns it,
  // resuming the same conversation with the new --effort; a blank value clears it).
  ipcMain.handle(
    "worksession:set-terminal-effort",
    (_e, sessionId: string, terminalId: string, effort: string) =>
      workSessionService.setTerminalEffort(sessionId, terminalId, effort),
  )
  // CAPP-108 — toggle a structured terminal's ultracode posture (respawns it,
  // resuming the same conversation with `--settings '{"ultracode":true}'` added/
  // removed; ON also omits --effort since ultracode forces xhigh).
  ipcMain.handle(
    "worksession:set-terminal-ultracode",
    (_e, sessionId: string, terminalId: string, ultracode: boolean) =>
      workSessionService.setTerminalUltracode(sessionId, terminalId, ultracode),
  )

  // CAPP-39 gate ③ — the per-terminal raw-view escape hatch: toggle one terminal
  // between the structured and xterm engines at runtime, resuming the same
  // conversation. Mirrors set-terminal-model (respawn + re-point); returns the new
  // terminal id so the renderer re-points the active selection.
  ipcMain.handle(
    "worksession:set-terminal-engine",
    (_e, sessionId: string, terminalId: string, targetEngine: "xterm" | "structured") =>
      workSessionService.setTerminalEngine(sessionId, terminalId, targetEngine),
  )

  // BO-10 — the stop/interrupt handbrake: kill the structured proc (rejecting any
  // pending permission as a deny) and respawn it on the SAME conversation via
  // --resume. Lives here (not terminal-handlers) because the respawn reuses the
  // durable session ref's ccConversationId/model, owned by SessionService. Returns
  // the new terminal id so the renderer re-points the active selection.
  ipcMain.handle("agent:interrupt", (_e, terminalId: string) =>
    workSessionService.interruptAgent(terminalId),
  )

  // Restart a terminal in place — kill the proc and respawn it on the SAME conversation
  // (via --resume) + SAME engine/model/effort/ultracode. A fresh spawn re-mints
  // --mcp-config and re-reads config, so MCP/config changes are picked up without
  // closing the app. Lives here (alongside interrupt) because the respawn reuses the
  // durable session ref's ccConversationId/model, owned by SessionService. Returns the
  // new terminal id so the renderer re-points the active selection.
  ipcMain.handle("agent:restart", (_e, terminalId: string) =>
    workSessionService.restartTerminal(terminalId),
  )
}
