import { ipcMain } from "electron"
import type { SessionService } from "../services/sessions"
import type { RecallService, RecallScope } from "../services/recall"
import type { WorkspaceMemoryService, PromoteEntry } from "../services/workspaceMemory"
import type { PanelService } from "../services/panels"

export function registerWorkSessionHandlers(deps: {
  workSessionService: SessionService
  recallService: RecallService
  workspaceMemoryService: WorkspaceMemoryService
  /**
   * CAPP-106 / S1 (F1) — used ONLY by `worksession:open-overview` to SHOW the fetched
   * overview as a panel (the main-window parity for the companion's `openSessionOverview`,
   * which RecallPanel's session-header click drives). Injected so the handler stays
   * decoupled from the panel layer; absent → open-overview is a no-op returning null.
   */
  panelService?: PanelService
  /**
   * CAPP-101 (P1) — the "export settled" SPAWN BARRIER (§C). Awaited BEFORE a fresh agent
   * spawn for the spawning session's OWN workspace: for an ADOPTED workspace it blocks until
   * any in-flight `ExportService.regenerate(W)` settles, so the spawn doesn't read a
   * stale/torn @import-delivered export mid-regen; otherwise it resolves immediately (a true
   * no-op — never slows the common path). Injected (not the services directly) so it stays
   * decoupled + the handler can't accidentally re-derive the workspace from the active
   * selection. Absent → no barrier (byte-unchanged); a throw inside is swallowed by the
   * default-safe wrappers below so a barrier failure never blocks a spawn.
   */
  awaitExportSettled?: (workspaceId: string | undefined) => Promise<void>
}) {
  const { workSessionService, recallService, workspaceMemoryService, awaitExportSettled, panelService } =
    deps

  /** Default-safe barrier await: no-op when unwired, and a throw never blocks the spawn. */
  const settle = async (workspaceId: string | undefined): Promise<void> => {
    if (!awaitExportSettled) return
    try {
      await awaitExportSettled(workspaceId)
    } catch {
      /* a barrier failure must never block a spawn */
    }
  }

  // Work-session (container) IPC -- the durable session tier above terminals
  ipcMain.handle("worksession:list", () => workSessionService.list())
  ipcMain.handle("worksession:open", async (_e, cwd?: string) => {
    // CAPP-101 (P1) — a NEW session is stamped with the ACTIVE workspace at create() time, so
    // gate the spawn on THAT workspace's export-settled barrier. (Scoped to the workspace the
    // session will own, never an unrelated one.)
    await settle(workSessionService.activeWorkspaceIdForSpawn())
    return workSessionService.openSession(cwd)
  })
  ipcMain.handle("worksession:add-terminal", async (_e, sessionId: string, cwd?: string) => {
    // CAPP-101 (P1) — a terminal added to an EXISTING session gates on THAT session's own
    // workspaceId (never the active selection).
    await settle(workSessionService.workspaceIdOf(sessionId))
    return workSessionService.addTerminalToSession(sessionId, cwd)
  })
  // CAPP-101 (P1) — the re-prime action (a USER affordance, NOT MCP): bracket-paste the
  // get_session_context PULL prompt to a running terminal whose owning session's workspace
  // memory changed since spawn, and clear the pending-delta mark. It PROMPTS the pull — it does
  // NOT itself inject the finding (honest, zero-magic propagation to a live session).
  ipcMain.handle("worksession:reprime", (_e, sessionId: string, terminalId: string) =>
    workSessionService.reprimeTerminal(sessionId, terminalId),
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
  // CAPP-87 / U3 — the Keep modal's editable candidate list: the dying session's
  // confirmed notes (active + ruled-out) mapped into PromoteEntry[]. Pure read.
  ipcMain.handle("worksession:promotable-findings", (_e, sessionId: string) =>
    workSessionService.getPromotableFindings(sessionId),
  )
  // CAPP-87 / U3 — atomic promote-then-kill ("Keep & delete"). Resolve the OWNING
  // session's workspace (NOT the active selection), promote its (edited) findings
  // into that workspace's memory FIRST, then kill the session. If promote throws,
  // the kill below NEVER runs (fail-safe: the session survives with findings intact).
  // The existing worksession:kill above stays as the "Delete everything" path.
  ipcMain.handle(
    "worksession:kill-with-promote",
    (_e, sessionId: string, editedEntries: PromoteEntry[]) => {
      const wsId = workSessionService.get(sessionId)?.workspaceId ?? null
      workspaceMemoryService.promoteFindings(wsId, editedEntries)
      workSessionService.killSession(sessionId)
    },
  )
  // CAPP-94 / U6 — "Push context to workspace" (the SessionOverviewPanel button):
  // promote a LIVE session's confirmed findings into its OWNING workspace's memory,
  // WITHOUT killing the session. The destination is the OWNING session's workspaceId
  // (NOT the active selection) — same resolution rule as kill-with-promote — so a
  // finding never re-homes across workspaces. Idempotent on (originSessionId,
  // originNoteId): re-pushing the same session updates the existing twins in place
  // rather than duplicating. Returns the resolved workspace + count for the caller.
  ipcMain.handle("worksession:promote-to-workspace", (_e, sessionId: string) => {
    const wsId = workSessionService.get(sessionId)?.workspaceId ?? null
    const entries = workSessionService.getPromotableFindings(sessionId)
    const promoted = workspaceMemoryService.promoteFindings(wsId, entries)
    return { ok: true, count: promoted.length, workspaceId: wsId }
  })
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
  // CAPP-106 / S1 (F1) — fetch a session's overview and SHOW it as a panel. The
  // main-window parity for the companion's `openSessionOverview` (RecallPanel's
  // session-header click). From the main-window modal this is recursive-by-design:
  // it opens ANOTHER panel into the same host. Returns the new panel (or null when
  // there's no overview / no panel layer wired).
  ipcMain.handle("worksession:open-overview", (_e, sessionId: string) => {
    const overview = workSessionService.getOverview(sessionId)
    if (!overview || !panelService) return null
    return panelService.show("session-overview", overview, "right")
  })
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

  // CAPP-86 — "The Lexicon": read-only cross-session recall (the RecallPanel +
  // future Rail KNOWS digest). Scope defaults to 'workspace', resolved from the
  // caller's session's workspaceId so a finding from project A doesn't leak into B.
  // Both handlers are pure reads — they cannot mutate any canonical session file.
  ipcMain.handle(
    "worksession:recall",
    (_e, query: string, scope?: RecallScope, sessionId?: string) => {
      const workspaceId = recallService.workspaceIdOf(sessionId)
      return recallService.recall(query, scope ?? "workspace", { sessionId, workspaceId })
    },
  )
  ipcMain.handle(
    "worksession:recall-summary",
    (_e, scope?: RecallScope, sessionId?: string) => {
      const workspaceId = recallService.workspaceIdOf(sessionId)
      return recallService.summary(scope ?? "workspace", { sessionId, workspaceId })
    },
  )
}
