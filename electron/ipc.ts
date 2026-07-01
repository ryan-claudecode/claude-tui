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
import { RecallService, primerHitEligible } from "./services/recall"
import { WorkspaceMemoryService } from "./services/workspaceMemory"
import { ContextInspectorService } from "./services/contextInspector"
import {
  buildSessionInjectWithStamp,
  assembleInjectInput,
  type SessionInjectDeps,
  type InjectWorkspaceFinding,
} from "./services/contextInject"
import { resolveInjectMaxBytes } from "./config"
import { LocalHistoryService } from "./services/localHistory"
import { ExportService } from "./services/export"
import { detectAdoption } from "./services/adoption"
import { registerExportHandlers } from "./ipc/export-handlers"
import { registerAdoptionHandlers } from "./ipc/adoption-handlers"
import { logWarn } from "./log"
import { CompanionService } from "./services/companion"
import { AttentionService } from "./services/attention"
import { Notification } from "electron"
import { loadConfig, resolveRenderingEngine, resolveRenderingModel, claudeDefaultModel, resolveRenderingEffort, claudeDefaultEffort, resolveSkipApproval, resolvePrimerRecall, resolveModelsDefault, resolveXhighModels } from "./config"
import { startMcpServer } from "./mcp/server"
import { registerTerminalHandlers } from "./ipc/terminal-handlers"
import { registerWorkSessionHandlers } from "./ipc/worksession-handlers"
import { registerPanelHandlers } from "./ipc/panel-handlers"
import { registerMissionHandlers } from "./ipc/mission-handlers"
import { registerAppHandlers } from "./ipc/app-handlers"
import { registerAttentionHandlers } from "./ipc/attention-handlers"
import { registerWorkspaceHandlers } from "./ipc/workspace-handlers"
import { registerLocalHistoryHandlers } from "./ipc/local-history-handlers"

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
// CAPP-87 / U3 — the durable, workspace-level knowledge tier. BrowserWindow-free,
// so it's safe to construct at module scope, and it's placed BEFORE the
// recallService block below (a later unit injects listWorkspaceMemory() into
// RecallService; this unit just needs the change seam to call recallService.invalidate()).
export const workspaceMemoryService = new WorkspaceMemoryService()
// CAPP-95 / D1 — the local-git data-loss net for the durable brain. A SEPARATE git
// repo at ~/.claude-tui/.local-history/ snapshots the curated subset (workspace-
// memory/ + sessions/ ONLY) so a bad edit/delete is recoverable. STRICT path
// separation: git over a snapshot COPY, never the live dir, never the sync repo,
// NEVER pushed (no remote ever added). init()/wiring happen in setupIpc below.
export const localHistoryService = new LocalHistoryService()
export const missionService = new MissionService(sessionService, {
  notify: (text, level) => notificationService.notify(text, level as any),
  // WS-C — stamp the active workspace onto each freshly-minted mission. A getter
  // (not the WorkspaceService itself) keeps MissionService decoupled + testable.
  // workspaceService is constructed above, so this closure is safe.
  getActiveWorkspaceId: () => workspaceService.getActiveId(),
})
// CAPP-86 — "The Lexicon": read-only cross-session recall over the per-session
// knowledge ledger. Declared with a forward `let` so the SessionService primer-
// enrichment closure below can reference it (the two are mutually referential:
// recall reads workSessionService.list(); the gated primer reads recall). Assigned
// immediately after workSessionService is constructed.
export let recallService: RecallService

// WS-C — scope work sessions to the active workspace: the durable container is
// stamped at create() time via this getter (undefined in "All" mode). Same
// callback-injection posture as missionService above.
// WS-G (G1) — and resolve the active workspace's primary dir as the spawn cwd for
// a NEW session's first terminal (null in "All" mode / no dir → default cwd).
// CAPP-86 — the OPTIONAL gated primer-enrichment seam: getContext appends a capped
// "## Related from other sessions" recall block ONLY when config.context.primerRecall
// is true (default OFF → byte-identical primer). The flag is re-read FRESH per call
// (loadConfig()) so a flip is honored without a restart. recallRelated scopes to the
// session's own workspace and excludes the session's own entries (handled below).
export const workSessionService = new SessionService({
  getActiveWorkspaceId: () => workspaceService.getActiveId(),
  getActiveWorkspaceDir: () => workspaceService.getActiveWorkspaceDir(),
  primerRecallEnabled: () => resolvePrimerRecall(loadConfig()),
  // CAPP-113 — the ADDITIVE config models.xhigh list, read FRESH so a config edit is
  // honored without a restart (mirrors primerRecallEnabled). Threads into the
  // model-switch keepUltra classification (modelSupportsXhigh).
  xhighModels: () => resolveXhighModels(loadConfig()),
  recallRelated: ({ sessionId, workspaceId, query, limit }) =>
    recallService
      .recall(query, "workspace", { sessionId, workspaceId }, limit + 5)
      // Exclude the session's OWN entries — they're already in the primer above. This
      // covers BOTH a live note from this session (h.sessionId === sessionId) AND a
      // workspace-memory finding PROMOTED FROM this session (h.originSessionId ===
      // sessionId), which carries the synthetic memory sessionId (CAPP-87 / U4). A
      // user/agent-authored memory hit (no originSessionId) IS eligible — legitimate
      // cross-context knowledge — so the "Related from other sessions" block can carry it.
      .filter((h) => primerHitEligible(h, sessionId))
      .slice(0, limit)
      .map((h) => ({ text: h.text, sessionName: h.sessionName, status: h.status, correction: h.correction })),
})
// CAPP-87 / U4 — RecallService is now a UNION of live session findings ∪ the durable
// workspace-memory tier, de-duped on the (originSessionId, originNoteId) pair. The
// second injected source is the in-memory workspace-memory snapshot; memory writes
// already invalidate the index via onMemoryChanged (wired in setupIpc above/below).
recallService = new RecallService(
  () => workSessionService.list(),
  () => workspaceMemoryService.listWorkspaceMemory(),
)

// CAPP-98 / I1 — the Context Inspector (READ-ONLY): enumerates the complete launch-time
// native context (managed policy, user/project memory, rules, parent-chain, auto-memory)
// + our injected primer, by precedence, for a workspace. Inspect-only — existsSync/
// readFileSync ONLY, no write path into any native file. Reads the same workspaceMemory +
// recall services the spawn inject reads, so tier #10 shows EXACTLY the capped brain a
// fresh session eats. Constructed after recallService is assigned (it's a dep).
export const contextInspectorService = new ContextInspectorService(
  workspaceService,
  workspaceMemoryService,
  recallService,
  undefined,
  // CAPP-100 / E2 — the Mode-C self-wired hint + the advertised @import line, read lazily
  // (exportService is declared just below; the closures resolve them at call time).
  (id) => exportService.isSelfWired(id),
  (id) => exportService.getExportState(id).importLine,
)

// CAPP-99 / E1 — the EXPORT pillar: materialize the WORKSPACE tier (instructions + durable
// findings) into a user-owned markdown file a raw `claude` can @import. STRICTLY one-directional
// (app JSON → file, never read back). Mode A (in-folder, gitignore-first) + Mode C (custom path,
// the only mode for untagged/folderless). It reads the SAME workspaceMemory + recall sources the
// spawn inject reads — via the shared buildWorkspacePrimerBody — so the exported file and the
// inject can never show a different workspace brain. The deps are injected so the service stays
// decoupled + hermetically testable; `workspaceFindings` maps the recall workspace-tier union to
// the inject finding shape (the EXACT mapping assembleInjectInput / the inspector use, so all
// three feed off one ordered finding set). init()/wiring happen in setupIpc below.
const exportWorkspaceFindings = (workspaceId: string | null): InjectWorkspaceFinding[] =>
  recallService.workspaceTierEntries(workspaceId ?? undefined).map((e) => ({
    text: e.text,
    status: e.status === "ruled-out" ? ("ruled-out" as const) : ("active" as const),
    ...(e.correction ? { correction: e.correction } : {}),
    createdAt: e.createdAt,
    ...(e.pinned ? { pinned: true } : {}),
  }))
export const exportService = new ExportService({
  resolveFolder: (id) => workspaceService.resolveWorkspaceDir(id),
  getInstructions: (id) => workspaceMemoryService.getMemory(id).instructions,
  workspaceFindings: exportWorkspaceFindings,
})

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

  // Push mission mutations to the main renderer (MS-2's useMissions consumes
  // these instead of polling). The full Mission rides along — the sidebar +
  // dashboard panel need tasks/workers/eventLog. A `removed` event (from
  // deleteMission, the durable sidebar ✕) is forwarded as `mission:removed`.
  missionService.onEvent((e) => {
    if (win.isDestroyed()) return
    if (e.type === "updated") {
      win.webContents.send("mission:updated", e.mission)
      // CAPP-110 / S3 (M4) — keep a POPPED-OUT mission dashboard live. usePanels'
      // mission live-refresh is main-side-only (local setPanels) and stops driving the
      // panel once it leaves the main mirror on pop-out; the companion has no
      // mission:updated listener of its own. So re-emit the fresh mission to any
      // surface:"window" mission panel via panelService.update, which routes
      // panel:update to the companion. Matched on props.id (the mission id) — panels
      // carry auto-generated panel-N ids, so the mission object's id is the key.
      // Guarded by isOpen() so a background tick NEVER spawns a closed companion via
      // update→route→sendToCompanion→getOrCreate (the ipc.ts:293 precedent). After a
      // companion close, dismissWindowPanels has already dropped these — belt + braces.
      if (companionService.isOpen()) {
        for (const p of panelService.list()) {
          if (p.surface === "window" && p.type === "mission" && p.props?.id === e.mission.id) {
            panelService.update(p.id, e.mission)
          }
        }
      }
    } else {
      win.webContents.send("mission:removed", e.id)
    }
  })

  // WS-B — push active-workspace changes to the main renderer (selection is now
  // separate from launch; the renderer reacts to the active selection instead of
  // polling). Mirrors the missionService.onEvent push above EXACTLY: the service
  // stays decoupled from BrowserWindow (no setMainWindow), and this callback
  // forwards each event over the `workspace:active-changed` channel. Payload is
  // the new active workspace's PUBLIC projection, or null when cleared.
  workspaceService.onActiveChanged((e) => {
    if (win.isDestroyed()) return
    win.webContents.send("workspace:active-changed", e.active)
  })

  // CAPP-87 / U3 — the workspace-memory change seam. Every memory mutation (direct
  // edit, finding add/edit/delete, or promote-on-kill) invalidates the recall index
  // (so the derived cross-session view stays fresh) and pushes the changed
  // workspaceId to the renderer (U5/U6's editor panel live-refreshes on it). The
  // RecallService union itself is U4 — here we only call the EXISTING invalidate().
  workspaceMemoryService.onMemoryChanged((workspaceId) => {
    recallService.invalidate()
    // CAPP-95 / D1 — every memory mutation schedules a debounced local-history
    // snapshot (coalesces an edit burst into one commit). No-op until init() ran.
    localHistoryService.scheduleSnapshot("workspace memory changed")
    // CAPP-99 / E1 — live regen: re-materialize this workspace's export off the every-mutation
    // seam (§B.4). The recall index was just invalidated above, so the exporter reads the FRESH
    // workspace tier. A `null`/sentinel-stem id addresses the untagged bucket. CATCH ITS OWN
    // ERRORS — a bad export (e.g. a read-only path) must NEVER crash the memory-mutation path.
    try {
      const wsId = workspaceId === "__untagged__" ? null : workspaceId
      exportService.regenerate(wsId)
    } catch (err) {
      logWarn("export", `live regen on memory change failed: ${String(err)}`)
    }
    // CAPP-101 (P1) — the propagation nudge: a NEW session spawned after this change gets the
    // updated brain automatically, but an ALREADY-RUNNING terminal froze its inject at spawn.
    // Mark every running terminal whose OWNING session's workspaceId === this workspace (SCOPED
    // by workspaceId, NEVER getActiveId) so the renderer can surface a quiet Agent Rail KNOWS
    // "re-prime to pull" affordance. The mark rides each affected session's worksession:updated
    // emit (inside markWorkspaceMemoryChanged). Caught — a mark failure must never crash the
    // mutation path.
    try {
      workSessionService.markWorkspaceMemoryChanged(workspaceId)
    } catch (err) {
      logWarn("worksession", `markWorkspaceMemoryChanged(${workspaceId}) failed: ${String(err)}`)
    }
    if (!win.isDestroyed()) win.webContents.send("workspace:memory-changed", workspaceId)
    // The editor panel (U6) lives in the COMPANION window, NOT the main window — so the
    // change must also reach there or an open editor goes stale when another surface
    // (Keep-modal promote, SessionOverview push, an agent's MCP write) mutates the same
    // workspace. Guarded by isOpen() so a memory change never SPAWNS a closed companion.
    if (companionService.isOpen()) {
      companionService.sendToCompanion("workspace:memory-changed", workspaceId)
    }
  })

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

  // CAPP-96 — auto-load the durable "brain" into every freshly-spawned session via a
  // file-backed --append-system-prompt-file (a seam our stream-json reducer provably
  // never surfaces). The assembly lives in `buildSessionInjectWithStamp` (contextInject.ts) so
  // the SAME logic is unit-tested rather than re-implemented here; this closure only injects
  // the live services. It is SCOPED off the SPAWNING session's own workspaceId (NEVER
  // getActiveId — a session spawned while a different workspace is active injects ITS OWN
  // brain), reads the WARMED RecallService index + the WorkspaceMemoryService cache (the
  // only sync fs is the byte-cap config read), and returns the full payload on a fresh
  // spawn / a short pointer on a --resume. Left UNSET in tests + e2e, so the spawn is
  // byte-unchanged there; here it opts in.
  // The live-service deps both the inject payload AND the CAPP-97 delta resolver read,
  // so the launch snapshot and the later get_session_context diff against the SAME source.
  const injectDeps: SessionInjectDeps = {
    workspaceIdOf: (id) => workSessionService.workspaceIdOf(id),
    getInstructions: (wsId) => workspaceMemoryService.getMemory(wsId).instructions,
    workspaceTierEntries: (wsId) => recallService.workspaceTierEntries(wsId),
    getSessionSections: (id) => workSessionService.getSessionContextSections(id),
    // CAPP-100 / E2 — the FRESH per-spawn adoption scan (never cached). Default-SAFE: a throw
    // here is caught in assembleInjectInput → NOT adopted → the workspace tier is injected. An
    // adopted workspace's inject drops the workspace tier (it rides the user's @import); the
    // session tier (incl. promoted-twin suppression) is always present.
    isAdopted: (wsId) =>
      detectAdoption(wsId ?? null, {
        resolveFolder: (id) => workspaceService.resolveWorkspaceDir(id),
        selfWiredHint: (id) => exportService.isSelfWired(id),
        importLine: (id) => exportService.getExportState(id).importLine,
      }),
  }
  sessionService.setContextBuilder((sessionId, { resume, terminalId }) => {
    // CAPP-97 — one assembly yields BOTH the payload and the launch stamp to record (keyed by
    // THIS terminalId), so the later get_session_context delta diffs against EXACTLY what was
    // injected. The helper owns the rules: resume / empty brain → no stamp (the pull degrades
    // to the FULL primer); a finding evicted under the cap stays "new" in the delta.
    const maxBytes = resolveInjectMaxBytes(loadConfig())
    const { payload, stamp } = buildSessionInjectWithStamp(sessionId, { resume, maxBytes }, injectDeps)
    if (stamp) workSessionService.recordLaunchStamp(terminalId, stamp)
    return payload
  })
  // CAPP-97 — the delta resolver: re-assemble the CURRENT auto-load input for a session
  // (same deps) so getContext can diff it against the recorded launch stamp.
  workSessionService.setInjectInputResolver((sessionId) => assembleInjectInput(sessionId, injectDeps))

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
  // CAPP-86 — keep the recall index fresh: every worksession mutation pushes
  // `worksession:updated` / `worksession:removed` to the renderer through this
  // window proxy, so invalidating the derived index on those channels means a
  // new/changed/removed note or summary joins (or leaves) the searchable set on its
  // next query. Wrapping the window (rather than a separate emit) reuses the single
  // mutation seam SessionService already routes every persist through.
  workSessionService.setMainWindow({
    isDestroyed: () => win.isDestroyed(),
    webContents: {
      send: (channel: string, ...args: unknown[]) => {
        if (channel === "worksession:updated" || channel === "worksession:removed") {
          recallService.invalidate()
          // CAPP-95 / D1 — a durable session-store mutation also schedules a
          // debounced local-history snapshot (sessions/ is half the curated subset).
          localHistoryService.scheduleSnapshot("session store changed")
          // CAPP-110 / S3 (M4) — keep a POPPED-OUT Session Overview live. usePanels'
          // overview live-refresh is main-side-only and stops driving the panel once it
          // leaves the main mirror on pop-out; the companion has no overview-refresh of
          // its own. So recompute getOverview for any surface:"window" overview panel and
          // push it via panelService.update (routes panel:update to the companion).
          // Matched on props.id (the session id). The reopen-terminal action is main-only
          // (a renderer fn can't cross IPC), so the popped-out overview omits it — exactly
          // as a companion-shown overview already does today.
          // Guarded by isOpen() so a session tick NEVER spawns a closed companion via
          // update→route→sendToCompanion→getOrCreate (the ipc.ts:293 precedent).
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

  // CAPP-95 / D1 — wire the local-history net. Reload hooks let a restore refresh
  // the affected service's cache + re-fire its change event so the renderer/recall
  // refresh; init() takes the startup baseline snapshot (after load() so the
  // current durable state is captured). All git work is best-effort + isolated to
  // the .local-history repo, so a failure here never blocks boot.
  localHistoryService.setReloadHooks({
    onWorkspaceMemoryRestored: () => workspaceMemoryService.reload(),
    onSessionsRestored: () => workSessionService.reloadFromDisk(),
  })
  localHistoryService.init()

  // CAPP-99 / E1 — regen-on-launch: re-materialize every enabled export now (self-heals
  // exports stale from while the app was closed; §B.0). After workSessionService.load() +
  // discover() so the recall union + workspace folders are warm. Best-effort + isolated —
  // regenerateAll catches per-export errors and never throws into boot.
  exportService.regenerateAll()

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
      recallService,
      attentionService,
      workspaceMemoryService,
      contextInspectorService,
      exportService,
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
  registerWorkSessionHandlers({
    workSessionService,
    recallService,
    workspaceMemoryService,
    // CAPP-106 / S1 (F1) — lets `worksession:open-overview` SHOW the fetched overview as a
    // panel (the main-window parity for the companion's openSessionOverview).
    panelService,
    // CAPP-101 (P1) — the "export settled" SPAWN BARRIER (§C). ONLY await when the workspace is
    // ADOPTED (its workspace tier rides the user's @import file, so a fresh spawn READS that
    // export — gate it on any in-flight regen). For a NON-adopted / non-exported workspace the
    // inject reads the in-memory store directly, so there's nothing to settle → resolve
    // immediately (no slow-down on the common path). The adoption scan is the SAME fresh,
    // default-safe `injectDeps.isAdopted` the inject uses (a throw → NOT adopted → no wait).
    awaitExportSettled: async (workspaceId: string | undefined) => {
      let adopted = false
      try {
        adopted = injectDeps.isAdopted?.(workspaceId) === true
      } catch {
        adopted = false
      }
      if (!adopted) return
      await exportService.whenSettled(workspaceId ?? null)
    },
  })
  registerPanelHandlers({
    panelService,
    notificationService,
    companionService,
    missionService,
    sessionService,
  })
  registerMissionHandlers({ missionService })
  registerAttentionHandlers({ getAttention: () => attentionService })
  // WS-B — id-based workspace ops (get/create/rename/add-dir/remove-dir/delete/
  // set-active/get-active/launch). Legacy index-based workspace:list/activate
  // stay in registerAppHandlers below for the current renderer wiring.
  // WS-F — `getScanPaths` resolves the SAME scan paths the boot discover() above
  // uses, but re-read FRESH from disk each call (mirroring osNotificationsEnabled's
  // loadConfig() re-read) so a config edit since launch is honored on a re-scan.
  registerWorkspaceHandlers({
    workspaceService,
    workspaceMemoryService,
    contextInspectorService,
    getScanPaths: () => loadConfig().workspaceScanPaths,
  })
  // CAPP-95 / D1 — local-history list/restore/snapshot/reveal.
  registerLocalHistoryHandlers({ localHistoryService, shellService })
  // CAPP-99 / E1 — export enable/disable/regen/state (export:* channels).
  registerExportHandlers({ exportService, workspaceService })
  // CAPP-100 / E2 — the reversible CLAUDE.local.md insert + adoption probe. MAIN-WINDOW only,
  // NON-MCP (no agent can trigger the native-file write).
  registerAdoptionHandlers({ exportService, workspaceService })
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
