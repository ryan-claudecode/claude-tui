import { app, BrowserWindow, dialog } from "electron"
import { join } from "path"
import { TerminalService } from "./services/terminals"
import { WorkspaceService } from "./services/workspaces"
import { AppService } from "./services/app"
import { PanelService } from "./services/panels"
import { NotificationService } from "./services/notifications"
import { GitService } from "./services/git"
import { TemplateService } from "./services/templates"
import { TestRunnerService } from "./services/tests"
import { LayoutService } from "./services/layouts"
import { BroadcastService } from "./services/broadcast"
import { ClipboardService } from "./services/clipboard"
import { ShellService } from "./services/shell"
import { NotesService } from "./services/notes"
import { FileService } from "./services/files"
import { UiService } from "./services/ui"
import { MissionService } from "./services/mission"
import { SessionService } from "./services/sessions"
import { CompanionService } from "./services/companion"
import { AttentionService } from "./services/attention"
import { Notification } from "electron"
import { loadConfig, resolveRenderingEngine, resolveRenderingModel, claudeDefaultModel, resolveRenderingEffort, claudeDefaultEffort, resolveSkipApproval } from "./config"
import { startMcpServer } from "./mcp/server"
import { registerTerminalHandlers } from "./ipc/terminal-handlers"
import { registerWorkSessionHandlers } from "./ipc/worksession-handlers"
import { registerPanelHandlers } from "./ipc/panel-handlers"
import { registerMissionHandlers } from "./ipc/mission-handlers"
import { registerAppHandlers } from "./ipc/app-handlers"
import { registerAttentionHandlers } from "./ipc/attention-handlers"

export const sessionService = new TerminalService()
export const workspaceService = new WorkspaceService(sessionService)
export const appService = new AppService()
export const panelService = new PanelService()
export const notificationService = new NotificationService()
export const gitService = new GitService()
export const templateService = new TemplateService(sessionService)
export const testRunnerService = new TestRunnerService()
export const layoutService = new LayoutService(sessionService)
export const broadcastService = new BroadcastService(sessionService)
export const clipboardService = new ClipboardService()
export const shellService = new ShellService()
export const notesService = new NotesService()
export const fileService = new FileService()
export const uiService = new UiService()
export const companionService = new CompanionService()
export const missionService = new MissionService(sessionService, {
  notify: (text, level) => notificationService.notify(text, level as any),
})
export const workSessionService = new SessionService()

/**
 * The attention queue (AQ-1). Constructed in setupIpc once the main window
 * exists (it needs window-focus + a renderer to push snapshots to). Exported as
 * a mutable binding so the MCP layer and tests can reach it after wiring.
 */
export let attentionService: AttentionService

export async function setupIpc(win: BrowserWindow) {
  const config = loadConfig()

  // Attention queue: single source of truth for "who needs me?". Subscribes to
  // panel/terminal/notification seams in its constructor; deps are injected so
  // window-focus and the OS notification stay testable.
  attentionService = new AttentionService(
    panelService,
    sessionService,
    notificationService,
    missionService,
    {
      sendToRenderer: (channel, ...args) => {
        if (!win.isDestroyed()) win.webContents.send(channel, ...args)
      },
      sessionOf: (terminalId) => workSessionService.sessionIdOf(terminalId),
      isWindowFocused: () => !win.isDestroyed() && win.isFocused(),
      osNotificationsEnabled: () => loadConfig().attention?.osNotifications !== false,
      notify: (message, level, title) => notificationService.notify(message, level, title),
      showOsNotification: ({ title, body, onClick }) => {
        const n = new Notification({ title, body })
        n.on("click", () => {
          // Bring the main window to the actual foreground. On Windows,
          // BrowserWindow.focus() alone cannot steal foreground from another
          // app (focus-stealing prevention) — win.show() + moveTop() +
          // app.focus({ steal: true }) is required.
          if (!win.isDestroyed()) {
            if (win.isMinimized()) win.restore()
            win.show()
            win.moveTop()
            app.focus({ steal: true })
          }
          // Raise the companion window on top of the main window — the form
          // (tier-1 trigger) lives there and should be immediately actionable.
          companionService.focusIfOpen()
          onClick()
        })
        n.show()
      },
      logWarn: (message) => console.warn(message),
    },
  )

  // Push mission mutations to the main renderer (MS-2's useMissions consumes
  // these instead of polling). The full Mission rides along — the sidebar +
  // dashboard panel need tasks/workers/eventLog. No `removed` event: missions
  // are never deleted (see MissionServiceEvent docs).
  missionService.onEvent((e) => {
    if (win.isDestroyed()) return
    if (e.type === "updated") win.webContents.send("mission:updated", e.mission)
    else win.webContents.send("mission:removed", e.id)
  })

  sessionService.setMainWindow(win)
  sessionService.setDefaults(
    config.defaultCommand ?? "claude",
    config.defaultArgs ?? ["--dangerously-skip-permissions"],
  )
  // BO-4a — flip the structured engine ON when config.rendering.engine says so;
  // defaults to "xterm" (resolveRenderingEngine), so create() is unchanged unless
  // the user opts in. From here, the normal new-session / new-terminal / reopen
  // paths (all routed through SessionService → TerminalService.create) spawn the
  // headless stream-json engine instead of an interactive PTY.
  sessionService.setEngine(resolveRenderingEngine(config))
  // BO-6 — the default `--model` new structured terminals spawn with. An unset
  // config.rendering.model seeds (best-effort) from the user's own
  // ~/.claude/settings.json model, then falls back to the `opus` ALIAS. Aliases
  // resolve to the latest model for the user's tier and are immune to a specific
  // version being disabled (the fable-5 failure). A per-terminal override (the
  // in-app picker) persists on the ref and wins over this default on respawn.
  sessionService.setModel(resolveRenderingModel(config, claudeDefaultModel()))
  // CAPP-46 — the default `--effort` new structured terminals spawn with. An unset
  // config.rendering.effort seeds (best-effort) from the user's own
  // ~/.claude/settings.json effortLevel, then falls back to UNDEFINED — when no
  // level is configured the spawn OMITS `--effort` so the default is byte-unchanged.
  // A per-terminal override (the in-app picker) persists on the ref and wins on respawn.
  sessionService.setEffort(resolveRenderingEffort(config, claudeDefaultEffort()))
  // DEV-skip-permissions (RELEASE BLOCKER) — the structured permission posture.
  // resolveSkipApproval defaults to TRUE (skip the BO-3 gate, spawn with
  // --dangerously-skip-permissions, matching the legacy xterm path) unless
  // config.permissions.skipApproval is explicitly false, which re-arms the
  // preserved BO-3 prompt-tool gate. The skip default is an owner-locked
  // DEV-velocity choice; a PUBLIC release must NOT ship it (trust thesis: "no
  // runaway you can't stop") — a release-blocker ticket tracks revisiting this.
  sessionService.setSkipApproval(resolveSkipApproval(config))

  // BO-10 — give TerminalService a user-visible notification seam (the permission
  // guard timeout raises a toast when a prompt goes unanswered). Wired here, after
  // both singletons exist, mirroring setMainWindow.
  sessionService.setNotifier((message, level, title) =>
    notificationService.notify(message, level, title),
  )

  appService.setMainWindow(win)
  appService.setProjectRoot(join(__dirname, "../.."))

  companionService.setMainWindow(win)
  panelService.setCompanion(companionService)
  notificationService.setMainWindow(win)
  uiService.setMainWindow(win)

  workspaceService.discover(config.workspaceScanPaths)
  workSessionService.attachTerminals(sessionService)
  workSessionService.setMainWindow(win)
  workSessionService.load()

  // Start MCP server and configure sessions to auto-connect. The MCP connection
  // is the app's entire value channel, so a startup failure must be loud — but
  // it must NOT take the app down: terminals minus MCP are degraded yet usable.
  // On failure we surface an error dialog and skip setMcpConfigPath/setMcpServerUrl
  // entirely, so TerminalService never pushes a --mcp-config arg pointing at a
  // stale/invalid config file.
  try {
    const { configPath, port } = await startMcpServer(
      sessionService,
      workspaceService,
      appService,
      panelService,
      notificationService,
      gitService,
      templateService,
      testRunnerService,
      layoutService,
      broadcastService,
      clipboardService,
      shellService,
      notesService,
      fileService,
      uiService,
      missionService,
      workSessionService,
      attentionService,
    )
    sessionService.setMcpConfigPath(configPath)
    sessionService.setMcpServerUrl(`http://127.0.0.1:${port}/sse`)
  } catch (err) {
    console.error("Failed to start MCP server:", err)
    dialog.showErrorBox(
      "ClaudeTUI — MCP server failed to start",
      `Sessions will run without app control (panels, orchestration, and other MCP tools are unavailable).\n\n${String(err)}`,
    )
  }

  missionService.start()

  // Register IPC handlers by domain (MOVE, not rewrite — see ipc/*-handlers.ts)
  registerTerminalHandlers({ sessionService, win })
  registerWorkSessionHandlers({ workSessionService })
  registerPanelHandlers({
    panelService,
    notificationService,
    companionService,
    missionService,
    sessionService,
  })
  registerMissionHandlers({ missionService })
  registerAttentionHandlers({ getAttention: () => attentionService })
  registerAppHandlers({
    config,
    sessionService,
    workspaceService,
    appService,
    testRunnerService,
    layoutService,
    broadcastService,
    notesService,
  })

  // Cleanup
  app.on("before-quit", () => sessionService.killAll())
}
