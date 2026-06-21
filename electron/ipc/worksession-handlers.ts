import { ipcMain } from "electron"
import type { SessionService } from "../services/sessions"

export function registerWorkSessionHandlers(deps: { workSessionService: SessionService }) {
  const { workSessionService } = deps

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
  ipcMain.handle("worksession:context", (_e, sessionId: string) =>
    workSessionService.getContext(sessionId),
  )
  ipcMain.handle("worksession:overview", (_e, sessionId: string) =>
    workSessionService.getOverview(sessionId),
  )
  ipcMain.handle("worksession:timeline", (_e, sessionId: string) =>
    workSessionService.getSessionTimeline(sessionId),
  )
  ipcMain.handle("worksession:handoff", (_e, sessionId: string, terminalId: string) =>
    workSessionService.handoffTerminal(sessionId, terminalId),
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
}
