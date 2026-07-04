import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { TerminalService } from "../services/terminals"
import type { WorkspaceService } from "../services/workspaces"
import type { AppService } from "../services/app"
import type { PanelService } from "../services/panels"
import type { NotificationService } from "../services/notifications"
import type { GitService } from "../services/git"
import type { TestRunnerService } from "../services/tests"
import type { ClipboardService } from "../services/clipboard"
import type { ShellService } from "../services/shell"
import type { NotesService } from "../services/notes"
import type { FileService } from "../services/files"
import type { UiService } from "../services/ui"
import type { SchedulerService } from "../services/scheduler"
import type { SessionService } from "../services/sessions"
import type { RecallService } from "../services/recall"
import type { AttentionService } from "../services/attention"
import type { WorkspaceMemoryService } from "../services/workspaceMemory"
import type { ContextInspectorService } from "../services/contextInspector"
import type { ExportService } from "../services/export"
import { registerSessionTools } from "./tools/sessions"
import { registerWorkSessionTools } from "./tools/worksessions"
import { registerPanelTools } from "./tools/panels"
import { registerPermissionTools } from "./tools/permissions"
import { registerGitTools } from "./tools/git"
import { registerAppTools } from "./tools/app"
import { registerWorkspaceTools } from "./tools/workspaces"
import { registerScheduleTools } from "./tools/schedules"
import { registerUiTools } from "./tools/ui"

export type { TerminalIdentity } from "./tools/shared"
import type { TerminalIdentity } from "./tools/shared"

/**
 * Composition root for the MCP tool surface. Each domain module exports a
 * `registerXxxTools(server, ...deps)` that registers its own tool definitions
 * verbatim; this function just wires the services through. Signature is
 * unchanged from when all tools lived in this file (server.ts depends on it).
 */
export function registerTools(
  server: McpServer,
  sessions: TerminalService,
  workspaces: WorkspaceService,
  appService: AppService,
  panels: PanelService,
  notifications: NotificationService,
  git: GitService,
  tests: TestRunnerService,
  clipboard: ClipboardService,
  shellService: ShellService,
  notes: NotesService,
  files: FileService,
  ui: UiService,
  workSessions: SessionService,
  recall: RecallService,
  attention: AttentionService,
  workspaceMemory: WorkspaceMemoryService,
  contextInspector: ContextInspectorService,
  exportService: ExportService,
  scheduler: SchedulerService,
  identity: TerminalIdentity = {},
) {
  registerSessionTools(server, sessions, attention, workSessions, workspaces, identity)
  registerWorkSessionTools(server, workSessions, panels, recall, identity)
  registerPanelTools(server, panels, notes, files, sessions, identity)
  registerPermissionTools(server, sessions, identity, (m, l, t) => notifications.notify(m, l, t))
  registerGitTools(server, git, sessions)
  registerWorkspaceTools(server, workspaces, workSessions, workspaceMemory, contextInspector, exportService, identity)
  registerScheduleTools(server, scheduler, workspaces, workSessions, identity)
  registerAppTools(
    server,
    sessions,
    workspaces,
    appService,
    panels,
    notifications,
    tests,
    clipboard,
    shellService,
    identity,
  )
  registerUiTools(server, ui)
}
