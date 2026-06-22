import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { TerminalService } from "../services/terminals"
import type { WorkspaceService } from "../services/workspaces"
import type { AppService } from "../services/app"
import type { PanelService } from "../services/panels"
import type { NotificationService } from "../services/notifications"
import type { GitService } from "../services/git"
import type { TemplateService } from "../services/templates"
import type { TestRunnerService } from "../services/tests"
import type { LayoutService } from "../services/layouts"
import type { BroadcastService } from "../services/broadcast"
import type { ClipboardService } from "../services/clipboard"
import type { ShellService } from "../services/shell"
import type { NotesService } from "../services/notes"
import type { FileService } from "../services/files"
import type { UiService } from "../services/ui"
import type { MissionService } from "../services/mission"
import type { SessionService } from "../services/sessions"
import type { RecallService } from "../services/recall"
import type { AttentionService } from "../services/attention"
import { registerSessionTools } from "./tools/sessions"
import { registerWorkSessionTools } from "./tools/worksessions"
import { registerMissionTools } from "./tools/missions"
import { registerPanelTools } from "./tools/panels"
import { registerPermissionTools } from "./tools/permissions"
import { registerGitTools } from "./tools/git"
import { registerAppTools } from "./tools/app"
import { registerWorkspaceTools } from "./tools/workspaces"
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
  templates: TemplateService,
  tests: TestRunnerService,
  layouts: LayoutService,
  broadcast: BroadcastService,
  clipboard: ClipboardService,
  shellService: ShellService,
  notes: NotesService,
  files: FileService,
  ui: UiService,
  mission: MissionService,
  workSessions: SessionService,
  recall: RecallService,
  attention: AttentionService,
  identity: TerminalIdentity = {},
) {
  registerSessionTools(server, sessions, broadcast, attention, workSessions, workspaces, identity)
  registerWorkSessionTools(server, workSessions, panels, recall, identity)
  registerMissionTools(server, mission)
  registerPanelTools(server, panels, notes, files, sessions, identity)
  registerPermissionTools(server, sessions, identity, (m, l, t) => notifications.notify(m, l, t))
  registerGitTools(server, git, sessions)
  registerWorkspaceTools(server, workspaces, workSessions, identity)
  registerAppTools(
    server,
    sessions,
    workspaces,
    appService,
    panels,
    notifications,
    templates,
    tests,
    layouts,
    clipboard,
    shellService,
    identity,
  )
  registerUiTools(server, ui)
}
