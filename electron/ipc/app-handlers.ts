import { ipcMain, BrowserWindow } from "electron"
import type { TerminalService } from "../services/terminals"
import type { WorkspaceService } from "../services/workspaces"
import type { AppService } from "../services/app"
import type { TestRunnerService } from "../services/tests"
import type { NotesService } from "../services/notes"
import {
  getThemeMode,
  setThemeMode,
  setRenderingEngine,
  setAgentRailOpen,
  addModelExtra,
  type TuiConfig,
  type ThemeMode,
  type RenderingEngine,
} from "../config"

export function registerAppHandlers(deps: {
  config: TuiConfig
  sessionService: TerminalService
  workspaceService: WorkspaceService
  appService: AppService
  testRunnerService: TestRunnerService
  notesService: NotesService
}) {
  const {
    config,
    sessionService,
    workspaceService,
    appService,
    testRunnerService,
    notesService,
  } = deps

  // Workspace IPC. Now backed by the durable registry (WS-A): the renderer
  // reads `id` + `name`; WS-H — the workspace's single `dir` (+ `color`) rides
  // along for the switcher UX. Reuses `listPublic()` so this stays in lockstep
  // with the no-leak projection (no `seed*` fields, no stale `dirs`). The
  // index-based `activate` is retained for the legacy `onSelectWorkspace(index)`
  // wiring — WS-B replaces it with id-based make-active-vs-launch.
  ipcMain.handle("workspace:list", () => workspaceService.listPublic())
  ipcMain.handle("workspace:activate", (_e, index: number) =>
    workspaceService.activate(index),
  )

  // Config
  ipcMain.handle("config:get", () => config)
  ipcMain.handle("config:get-theme", () => getThemeMode())
  ipcMain.handle("config:set-theme", (_e, mode: ThemeMode) => {
    setThemeMode(mode)
    // Broadcast to all windows so companion windows (future) stay in sync
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("theme:changed", mode)
    }
  })
  // CAPP-39 gate ④ — the rollback write-path: set the DEFAULT engine new terminals
  // spawn with. Persists to config AND calls the live TerminalService.setEngine so
  // the change applies to the NEXT-spawned terminal without a restart (mirrors how
  // ipc.ts startup wires setEngine(resolveRenderingEngine(config))). Currently-open
  // terminals are unaffected; the per-terminal raw-view escape hatch handles those.
  ipcMain.handle("config:set-rendering-engine", (_e, engine: RenderingEngine) => {
    setRenderingEngine(engine)
    sessionService.setEngine(engine)
  })
  // Agent Rail (v1) — persist the rail's open/collapsed preference. A renderer-only
  // UI pref (no service owns it), so unlike set-rendering-engine there is NO live
  // service call: the renderer holds the rail state and re-reads this on the next
  // mount. Mirrors the setThemeMode write-path otherwise.
  ipcMain.handle("config:set-agent-rail-open", (_e, open: boolean) => {
    setAgentRailOpen(open)
  })
  // CAPP-113 — persist a user-entered CUSTOM model into config models.extra so it
  // appears in the picker from then on. Called only after a SUCCESSFUL switch to the
  // custom value (the picker's free-text entry). addModelExtra persists (idempotent +
  // de-duping) and returns whether it actually wrote; only then do we (a) mirror onto
  // the in-memory config snapshot (returned by config:get) and (b) PUSH the fresh
  // models block to every window on `config:models-changed` (the
  // theme:changed broadcast pattern) so already-mounted pickers refresh WITHOUT an
  // app restart — the renderer fetches config exactly once on mount.
  ipcMain.handle("config:add-model-extra", (_e, value: string) => {
    if (!addModelExtra(value)) return
    const v = value.trim()
    if (!config.models) config.models = {}
    const extra = Array.isArray(config.models.extra) ? config.models.extra : []
    if (!extra.includes(v)) {
      extra.push(v)
      config.models.extra = extra
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("config:models-changed", config.models)
    }
  })

  // App testing tools
  ipcMain.handle("app:screenshot", async () => appService.captureScreenshot())
  // Use listPublic() — get_app_state is an MCP surface, so it must not leak the
  // internal seed* boot/import fields (same no-leak posture as workspace:list).
  ipcMain.handle("app:state", () =>
    appService.getAppState(sessionService.list(), workspaceService.listPublic()),
  )
  ipcMain.handle("app:save-image", (_e, base64: string, filename: string) =>
    appService.saveDroppedImage(base64, filename),
  )

  // Test runner IPC
  ipcMain.handle("test:run", (_e, cwd: string, command?: string) =>
    testRunnerService.run(cwd, command),
  )

  // Notes IPC -- persistent cross-session scratchpad
  ipcMain.handle("notes:list", (_e, scope?: string, tag?: string) =>
    notesService.list(scope, tag),
  )
  ipcMain.handle("notes:get", (_e, id: string) => notesService.get(id))
  ipcMain.handle(
    "notes:save",
    (_e, title: string, body: string, opts?: { id?: string; scope?: string; tags?: string[] }) =>
      notesService.save(title, body, opts),
  )
  ipcMain.handle("notes:delete", (_e, id: string) => notesService.delete(id))
}
