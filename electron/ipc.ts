import { app, BrowserWindow, dialog } from "electron"
import { join } from "path"
import { homedir } from "os"
import { TerminalService } from "./services/terminals"
import { WorkspaceService } from "./services/workspaces"
import { AppService } from "./services/app"
import { PanelService } from "./services/panels"
import { NotificationService } from "./services/notifications"
import { GitService } from "./services/git"
import { ClipboardService } from "./services/clipboard"
import { ShellService } from "./services/shell"
import { FileService } from "./services/files"
import { UiService } from "./services/ui"
import { SchedulerService } from "./services/scheduler"
import { userMessage, MODEL_ALIASES, EFFORT_LEVELS, HEADLESS_FLAGS } from "./services/streamProtocol"
import { SessionService } from "./services/sessions"
import { ContextInspectorService } from "./services/contextInspector"
import { logWarn } from "./log"
import { CompanionService } from "./services/companion"
import { AttentionService } from "./services/attention"
import { Notification } from "electron"
import { loadConfig, resolveRenderingEngine, resolveRenderingModel, claudeDefaultModel, resolveRenderingEffort, claudeDefaultEffort, resolveSkipApproval, resolveModelsDefault, resolveXhighModels } from "./config"
import { startMcpServer } from "./mcp/server"
import { registerTerminalHandlers } from "./ipc/terminal-handlers"
import { registerWorkSessionHandlers } from "./ipc/worksession-handlers"
import { registerPanelHandlers } from "./ipc/panel-handlers"
import { registerScheduleHandlers } from "./ipc/schedule-handlers"
import { registerAppHandlers } from "./ipc/app-handlers"
import { registerAttentionHandlers } from "./ipc/attention-handlers"
import { registerWorkspaceHandlers } from "./ipc/workspace-handlers"
import { registerSttHandlers } from "./ipc/stt-handlers"
import { SttService } from "./services/stt"
import { createSttRuntimeDeps } from "./stt/runtime"
import { MODEL_DIRNAME } from "./stt/protocol"
import { resolveSttEnabled, resolveSttHotwords, resolveSchedulerMaxConcurrent } from "./config"
import { syncWindowSchedulePanels } from "./services/schedulePanelSync"
import { deriveHotwords } from "./stt/hotwords"
import { collectWorkspaceNames } from "./stt/runtime"

export const sessionService = new TerminalService()
export const workspaceService = new WorkspaceService(sessionService)
export const appService = new AppService()
export const panelService = new PanelService()
export const notificationService = new NotificationService()
export const gitService = new GitService()
export const clipboardService = new ClipboardService()
export const shellService = new ShellService()
export const fileService = new FileService()
export const uiService = new UiService()
export const companionService = new CompanionService()

// WS-C — scope work sessions to the active workspace: the durable container is
// stamped at create() time via this getter (undefined in "All" mode). Same
// callback-injection posture as the other services.
// WS-G (G1) — and resolve the active workspace's primary dir as the spawn cwd for
// a NEW session's first terminal (null in "All" mode / no dir → default cwd).
export const workSessionService = new SessionService({
  getActiveWorkspaceId: () => workspaceService.getActiveId(),
  getActiveWorkspaceDir: () => workspaceService.getActiveWorkspaceDir(),
  // CAPP-113 — the ADDITIVE config models.xhigh list, read FRESH so a config edit is
  // honored without a restart. Threads into the model-switch keepUltra classification.
  xhighModels: () => resolveXhighModels(loadConfig()),
})

// CAPP-98 / I1 — the Context Inspector (READ-ONLY): enumerates the complete launch-time
// NATIVE context (managed policy, user/project memory, rules, parent-chain, auto-memory)
// by precedence, for a workspace. Inspect-only — existsSync/readFileSync ONLY, no write
// path into any native file.
export const contextInspectorService = new ContextInspectorService(workspaceService)

/**
 * The attention queue (AQ-1). Constructed in setupIpc once the main window
 * exists (it needs window-focus + a renderer to push snapshots to). Exported as
 * a mutable binding so the MCP layer and tests can reach it after wiring.
 */
export let attentionService: AttentionService

// CAPP-114 (SCHED-1) — the on-device scheduler. Every external effect is wired
// here over the existing services: a scheduled run lazily gets a durable work
// session (one per schedule, workspace-scoped to the SCHEDULE, not the active
// selection), spawns a STRUCTURED (headless) terminal into it, delivers the prompt
// over the stdin sink (never a PTY write+delay), and records a run when it ends (a
// stream `result` or the terminal exiting). `raiseAttention` reads the mutable
// `attentionService` binding lazily (assigned in setupIpc, long before any fire).
export const schedulerService = new SchedulerService({
  ensureSession: ({ name, workspaceId, sessionId }) => {
    // Reuse the schedule's own session across restarts when it still exists.
    if (sessionId && workSessionService.get(sessionId)) return sessionId
    const session = workSessionService.create({ workspaceId, name: `⏰ ${name}` })
    return session.id
  },
  spawnRun: ({ sessionId, name, cwd, workspaceId, model, effort, ultracode }) => {
    // Spawn-cwd fallback chain (design: "defaults: workspace folder → home"):
    // explicit schedule cwd → the SCHEDULE's workspace folder (resolved off the
    // schedule's OWN workspaceId, never the active selection; resolveWorkspaceDir
    // validates absolute + exists, null otherwise) → the user's home dir. Without
    // this, an unset cwd fell through to process.cwd() (the app's install dir).
    const workspaceDir = workspaceId ? workspaceService.resolveWorkspaceDir(workspaceId) : null
    const resolvedCwd = cwd ?? workspaceDir ?? homedir()
    // Structured spawn regardless of the global engine (a scheduled run is a
    // headless agent), identity-bound to the session so it inherits the primer.
    const info = sessionService.createHeadless(name, resolvedCwd, sessionId, undefined, undefined, model, effort, ultracode)
    workSessionService.addTerminal(sessionId, {
      id: info.id,
      name: info.name,
      cwd: info.cwd,
      lastState: info.state as "active" | "idle" | "dead",
      engine: info.engine,
      model: info.model,
      effort: info.effort,
      ultracode: info.ultracode,
    })
    workSessionService.setStatus(sessionId, "active")
    return info.id
  },
  sendPrompt: (terminalId, prompt) => sessionService.sendAgentMessage(terminalId, userMessage(prompt)),
  killTerminal: (terminalId) => {
    sessionService.kill(terminalId)
  },
  retireTerminal: (sessionId, terminalId) => workSessionService.closeTerminal(sessionId, terminalId),
  isTerminalAlive: (terminalId) =>
    sessionService.getActivity().some((a) => a.id === terminalId && a.state !== "dead"),
  onRunEnd: (cb) =>
    sessionService.onEvent((e) => {
      if (e.type === "exit" && e.id) cb({ terminalId: e.id, kind: "exit" })
      else if (e.type === "stream" && e.id && e.event?.kind === "result") {
        cb({ terminalId: e.id, kind: "result", isError: e.event.isError === true, note: e.event.result })
      }
    }),
  raiseAttention: ({ sessionId, terminalId, reason }) => attentionService?.request(sessionId, terminalId, reason),
})

// CAPP-120 (STT-1) — the push-to-talk dictation engine (Parakeet TDT via sherpa-onnx,
// hosted in an Electron UTILITY PROCESS so ORT never blocks the main thread). The service
// is PURE; every effect (utilityProcess.fork, the streaming download, the .tar.bz2 extract,
// fs) is injected via `createSttRuntimeDeps`. The 680 MB model is NOT bundled — it's
// acquired on first enable into `~/.claude-tui/stt/parakeet-tdt-0.6b-v2-int8/`. The worker
// bundle lands beside this one at `out/main/sttWorker.js` (a second electron-vite entry).
export const sttService = new SttService(
  createSttRuntimeDeps({
    modelDir: join(homedir(), ".claude-tui", "stt", MODEL_DIRNAME),
    sttRoot: join(homedir(), ".claude-tui", "stt"),
    workerPath: join(__dirname, "sttWorker.js"),
    logWarn: (m) => logWarn("stt", m),
  }),
)

export async function setupIpc(win: BrowserWindow) {
  const config = loadConfig()

  // Attention queue: single source of truth for "who needs me?". Subscribes to
  // panel/terminal/notification seams in its constructor; deps are injected so
  // window-focus and the OS notification stay testable.
  attentionService = new AttentionService(
    panelService,
    sessionService,
    notificationService,
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
          // CAPP-109 / S2 — a tier-1 form now renders in the main-window ModalHost
          // (modal-by-default), which is already raised+focused above and is
          // form-exclusive, so it's immediately actionable. We still raise the
          // companion IF it happens to be open (a popped-out panel, S3) so a form
          // that was moved there isn't left behind a stale companion window.
          companionService.focusIfOpen()
          onClick()
        })
        n.show()
      },
      logWarn: (message) => console.warn(message),
    },
  )

  // CAPP-114 (SCHED-1) — push schedule mutations to the main renderer (useSchedules
  // consumes these instead of polling). The full Schedule rides along (runHistory +
  // nextRunAt). A `removed` event (delete) → schedule:removed.
  schedulerService.onEvent((e) => {
    if (win.isDestroyed()) return
    if (e.type === "updated") win.webContents.send("schedule:updated", e.schedule)
    else win.webContents.send("schedule:removed", e.id)
    // CAPP-115 review (MINOR 4 / MAJOR 2) — keep POPPED-OUT (`surface:"window"`)
    // schedule detail panels live: updated → panelService.update (routes panel:update
    // to the companion, the CAPP-110 M4 pattern); removed → panelService.hide
    // (a deleted schedule must never leave a zombie panel there — the renderer-side
    // stale-close only reaches the MAIN mirror). Guarded by isOpen() so a background
    // tick can never resurrect a closed companion (dismissWindowPanels already dropped
    // these on close — belt + braces).
    if (companionService.isOpen()) {
      syncWindowSchedulePanels(e, panelService.list(), panelService)
    }
  })

  // WS-B — push active-workspace changes to the main renderer (selection is now
  // separate from launch; the renderer reacts to the active selection instead of
  // polling). The service stays decoupled from BrowserWindow (no setMainWindow),
  // and this callback forwards each event over the `workspace:active-changed`
  // channel. Payload is the new active workspace's PUBLIC projection, or null when cleared.
  workspaceService.onActiveChanged((e) => {
    // CAPP-121 (STT-2) — re-derive the dictation hotword vocabulary for the newly-active
    // workspace (immediate: a switch is a deliberate, low-frequency user action).
    regenerateHotwords()
    if (win.isDestroyed()) return
    win.webContents.send("workspace:active-changed", e.active)
  })

  // CAPP-121 (STT-2) — workspace-vocabulary hotword biasing for dictation. Re-derive the
  // hotword vocabulary from the ACTIVE workspace (dictation is a user-facing input affordance —
  // active selection is correct here, unlike agent identity binding). Three sources:
  //   (a) file/dir NAMES from a bounded walk of the workspace folder,
  //   (b) app constants (model aliases, effort levels, common CLI flags from streamProtocol),
  //   (c) user config `stt.hotwords`.
  // The pure `deriveHotwords` splits/dedups/caps; `SttService.setHotwords` materializes the file
  // and rebuilds the recognizer LAZILY on the next transcribe. THROW-SAFE — a bad walk / read
  // must NEVER crash the workspace mutation path this hangs off.
  const HOTWORD_CLI_FLAGS = [
    ...HEADLESS_FLAGS,
    "--dangerously-skip-permissions",
    "--resume",
    "--model",
    "--effort",
    "--mcp-config",
    "--append-system-prompt-file",
    "--permission-prompt-tool",
    "--settings",
  ]
  function regenerateHotwords(): void {
    try {
      // Review fix 3 — the CHEAP gates first: most installs have STT disabled or the model
      // not yet downloaded (the DEFAULT state), and regen hangs off hot seams (memory
      // mutations, workspace switches). Never pay the workspace walk (or a doomed tokens.txt
      // read) there. modelPresent() (4 existsSync) instead of status() because the
      // download-ready hook (fix 2) fires from INSIDE acquire(), where `acquiring` is still
      // true and status() would still read "downloading".
      const cfg = loadConfig()
      if (!resolveSttEnabled(cfg)) return
      if (!sttService.modelPresent()) return
      const dir = workspaceService.getActiveWorkspaceDir()
      const fileNames = dir ? collectWorkspaceNames(dir) : []
      const words = deriveHotwords({
        extras: resolveSttHotwords(cfg),
        terms: [...MODEL_ALIASES, ...EFFORT_LEVELS, ...HOTWORD_CLI_FLAGS],
        fileNames,
      })
      sttService.setHotwords(words)
    } catch (err) {
      logWarn("stt", `hotword regen failed: ${String(err)}`)
    }
  }
  let hotwordRegenTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleHotwordRegen(): void {
    if (hotwordRegenTimer) clearTimeout(hotwordRegenTimer)
    hotwordRegenTimer = setTimeout(() => {
      hotwordRegenTimer = null
      regenerateHotwords()
    }, 1500)
  }

  sessionService.setMainWindow(win)
  sessionService.setDefaults(
    config.defaultCommand ?? "claude",
    config.defaultArgs ?? ["--dangerously-skip-permissions"],
  )
  // BO-4a / CAPP-39 gate ④ — wire the rendering engine from config. The default is
  // now "structured" (resolveRenderingEngine returns it unless config explicitly says
  // "xterm"), so the normal new-session / new-terminal / reopen paths (all routed
  // through SessionService → TerminalService.create) spawn the headless stream-json
  // engine by default; only an explicit `rendering.engine: "xterm"` pins the legacy
  // interactive PTY globally. The command-palette rollback write-path
  // (config:set-rendering-engine) lets the user flip this default back at runtime.
  sessionService.setEngine(resolveRenderingEngine(config))
  // BO-6 — the default `--model` new structured terminals spawn with. An unset
  // config.rendering.model seeds (best-effort) from the user's own
  // ~/.claude/settings.json model, then falls back to the `opus` ALIAS. Aliases
  // resolve to the latest model for the user's tier and are immune to a specific
  // version being disabled (the fable-5 failure). A per-terminal override (the
  // in-app picker) persists on the ref and wins over this default on respawn.
  // CAPP-113 — config `models.default` overrides the hard-coded DEFAULT_MODEL for
  // NEW terminals without a code edit; it slots in as the fallback (an explicit
  // rendering.model still wins over it, then it wins over the ambient CC-settings seed).
  sessionService.setModel(resolveRenderingModel(config, resolveModelsDefault(config) ?? claudeDefaultModel()))
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
  // CAPP-109 / S2 (M5 / B.2) — wire the MAIN-window panel bridge HERE, and it MUST stay
  // ordered BEFORE: (a) the MCP server start below (which exposes show_panel/show_form),
  // and (b) registerPanelHandlers (the panel:show IPC). The modal is the default panel
  // surface and — unlike the companion's lazy-create path — has NO mask for a `show`
  // that fires before its sink exists, so a `show_panel` arriving before this line would
  // be silently dropped from the main mirror. If this is ever reordered after a
  // show-capable handler/MCP start, `PanelService.route` logs a loud error.
  panelService.setMainBridge({
    send: (channel, ...args) => {
      if (!win.isDestroyed()) win.webContents.send(channel, ...args)
    },
  })
  // CAPP-110 / S3 — when the companion window closes, reconcile popped-out panels:
  // cancel any pending show_form (never orphan the held-open MCP call) and drop
  // surface:"window" panels so a later M4 live-refresh can't resurrect a ghost window.
  companionService.setOnClosed(() => panelService.dismissWindowPanels())
  notificationService.setMainWindow(win)
  uiService.setMainWindow(win)

  // WS-G (G3) — give WorkspaceService a user-visible notification seam so it can
  // TOAST when it scaffolds a workspace.json into a newly-added directory (at create
  // or via the G2 add-folder affordance). Wired here, after both singletons exist.
  workspaceService.setNotifier((message, level, title) =>
    notificationService.notify(message, level as any, title),
  )

  workspaceService.discover(config.workspaceScanPaths)
  workSessionService.attachTerminals(sessionService)
  // Route every worksession mutation to the renderer through this window proxy.
  workSessionService.setMainWindow({
    isDestroyed: () => win.isDestroyed(),
    webContents: {
      send: (channel: string, ...args: unknown[]) => {
        if (channel === "worksession:updated" || channel === "worksession:removed") {
          // CAPP-110 / S3 (M4) — keep a POPPED-OUT Session Overview live. usePanels'
          // overview live-refresh is main-side-only and stops driving the panel once it
          // leaves the main mirror on pop-out; the companion has no overview-refresh of
          // its own. So recompute getOverview for any surface:"window" overview panel and
          // push it via panelService.update (routes panel:update to the companion).
          // Guarded by isOpen() so a session tick NEVER spawns a closed companion.
          if (companionService.isOpen()) {
            for (const p of panelService.list()) {
              if (p.surface === "window" && p.type === "session-overview" && p.props?.id) {
                const ov = workSessionService.getOverview(p.props.id)
                if (ov) panelService.update(p.id, { ...ov })
              }
            }
          }
        }
        if (!win.isDestroyed()) win.webContents.send(channel, ...args)
      },
    },
  })
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
      clipboardService,
      shellService,
      fileService,
      uiService,
      workSessionService,
      attentionService,
      contextInspectorService,
      schedulerService,
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

  // CAPP-114 (SCHED-1) — start the scheduler's single 30s tick (+ launch catch-up).
  // CAPP-115 (SCHED-2) — apply the config `scheduler.maxConcurrent` override BEFORE the
  // first tick (tolerant-parsed; absent → the service keeps its built-in default of 2).
  schedulerService.setMaxConcurrent(resolveSchedulerMaxConcurrent(config))
  schedulerService.start()

  // Register IPC handlers by domain (MOVE, not rewrite — see ipc/*-handlers.ts)
  registerTerminalHandlers({ sessionService, win })
  registerWorkSessionHandlers({
    workSessionService,
    // CAPP-106 / S1 (F1) — lets `worksession:open-overview` SHOW the fetched overview as a
    // panel (the main-window parity for the companion's openSessionOverview).
    panelService,
  })
  registerPanelHandlers({
    panelService,
    notificationService,
    companionService,
    sessionService,
  })
  registerScheduleHandlers({ schedulerService, win })
  // CAPP-120 (STT-1) — push acquisition progress to the renderer's inline download flow
  // (the composer's mic overlay listens on `stt:progress`). Mirrors schedule:updated.
  sttService.onProgress((p) => {
    // CAPP-121 review fix 2 — the model download just reached its terminal ready phase:
    // derive the FIRST vocabulary now (fix 3's gates skipped every earlier regen while the
    // model was absent, and MAJOR 1's retry-safety alone had no trigger to fire on).
    // regenerateHotwords gates on modelPresent() (true here), not status() ("downloading"
    // until acquire()'s finally runs), and catches its own errors.
    if (p.phase === "ready") regenerateHotwords()
    if (!win.isDestroyed()) win.webContents.send("stt:progress", p)
  })
  // `isEnabled` is read FRESH (loadConfig) so a config edit is honored without a restart.
  registerSttHandlers({ sttService, isEnabled: () => resolveSttEnabled(loadConfig()) })
  // CAPP-121 (STT-2) — prime the dictation hotword vocabulary once at launch (after workspaces
  // are discovered + sessions loaded), so the first dictation is already workspace-biased.
  // Review fix 3: this no-ops cheaply when STT is disabled or the model isn't downloaded
  // (the default state) — the first real regen then happens at download-ready (fix 2).
  regenerateHotwords()
  registerAttentionHandlers({ getAttention: () => attentionService })
  // WS-B — id-based workspace ops (get/create/rename/add-dir/remove-dir/delete/
  // set-active/get-active/launch). Legacy index-based workspace:list/activate
  // stay in registerAppHandlers below for the current renderer wiring.
  // WS-F — `getScanPaths` resolves the SAME scan paths the boot discover() above
  // uses, but re-read FRESH from disk each call (mirroring osNotificationsEnabled's
  // loadConfig() re-read) so a config edit since launch is honored on a re-scan.
  registerWorkspaceHandlers({
    workspaceService,
    contextInspectorService,
    getScanPaths: () => loadConfig().workspaceScanPaths,
  })
  registerAppHandlers({
    config,
    sessionService,
    workspaceService,
    appService,
  })

  // Cleanup
  app.on("before-quit", () => {
    sessionService.killAll()
    // CAPP-120 (STT-1) — kill the dictation utility process + cancel any in-flight
    // download so a quit never leaves an orphaned worker. Best-effort.
    try {
      sttService.dispose()
    } catch {
      /* never block quit on the dictation engine */
    }
  })
}
