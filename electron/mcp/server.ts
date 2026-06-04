import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { createServer } from "http"
import type { TerminalService } from "../services/terminals"
import type { WorkspaceService } from "../services/workspaces"
import type { AppService } from "../services/app"
import type { PanelService } from "../services/panels"
import type { NotificationService } from "../services/notifications"
import type { GitService } from "../services/git"
import type { TemplateService } from "../services/templates"
import type { TestRunnerService } from "../services/tests"
import type { LayoutService } from "../services/layouts"
import type { SnippetService } from "../services/snippets"
import type { BroadcastService } from "../services/broadcast"
import type { CommandService } from "../services/commands"
import type { ClipboardService } from "../services/clipboard"
import type { ShellService } from "../services/shell"
import type { NotesService } from "../services/notes"
import type { TaskQueueService } from "../services/taskqueue"
import type { SystemService } from "../services/system"
import type { FileSearchService } from "../services/filesearch"
import type { FileService } from "../services/files"
import type { HttpService } from "../services/http"
import type { PortService } from "../services/ports"
import type { EditService } from "../services/edit"
import type { ProcessService } from "../services/process"
import type { EncodeService } from "../services/encode"
import type { JsonService } from "../services/json"
import type { TimeService } from "../services/time"
import type { CsvService } from "../services/csv"
import type { RegexService } from "../services/regex"
import type { TextService } from "../services/text"
import type { ColorService } from "../services/color"
import type { MathService } from "../services/math"
import type { UrlService } from "../services/url"
import type { UiService } from "../services/ui"
import type { MissionService } from "../services/mission"
import type { SessionService } from "../services/sessions"
import { registerTools } from "./tools"

// Injected into every connecting session's context via the MCP initialize
// result (the "MCP Server Instructions" block Claude Code surfaces). Gives a
// session spawned inside the app a map of what it can drive without having to
// load each deferred tool schema first to find out.
const SERVER_INSTRUCTIONS = `You are running inside ClaudeTUI — a desktop app for managing Claude Code sessions — and you are connected to its MCP server ("claudetui"). These tools let you drive the app itself (render rich UI, orchestrate other sessions, inspect the repo) alongside your normal work.

Tool groups (all prefixed mcp__claudetui__):
- Panels — show_panel renders a rich UI panel in the side drawer: diff, image, markdown, table, test, chart, heatmap, tree, timeline, git, kanban, notes, stat, log, progress, code. show_form shows an interactive form and waits for the user's submission. Plus update_panel / hide_panel / hide_all_panels / list_panels.
- Sessions & orchestration — create_session, kill_session, focus_session, rename_session, list_sessions, get_session_activity, wait_for_session_idle (delegate a task to another session and block until it finishes), broadcast_input (send input to all sessions at once).
- Git — git_status / git_log / git_diff / git_show / git_blame / git_branches / git_stage / git_commit / git_push / git_pull / git_stash and more, all returning structured JSON.
- Files — read_file / write_file / replace_in_file / insert_in_file, find_files (glob) / grep_code (regex), diff_files.
- System & network — run_command / run_build / run_tests, http_request / download_file / check_port / wait_for_port, find_process_on_port / kill_process_on_port / list_processes / kill_process, open_external / reveal_path, read_clipboard / write_clipboard.
- Utilities — JSON, CSV, regex, text, encode/hash, math, color, URL, and time helpers.
- Self-verification — take_screenshot (capture the app window), get_app_state (assert on window/session state), notify (toast that surfaces even when the terminal isn't focused).
- App UI control — drive the same view actions the user can: set_focus_mode (distraction-free), toggle_panel_drawer, open_command_palette, show_keyboard_shortcuts, open_history_search, export_session_log, get_config.
- Mission orchestration — mission_create/status/list/plan/dispatch/await/resolve/log/pause/resume/stop/finish: run a durable, on-disk mission where you (or another Conductor session) decompose a goal, dispatch worker sessions, review results, and commit — surviving context/usage limits. If spawned as a Conductor, call mission_status first to load state and continue.
- Work sessions (context engine) — create_work_session / list_work_sessions / work_session_status (omit session_id for the most-recent active one) build a durable *container* that groups many terminals and accumulates knowledge. register_terminal adds a terminal to it; set_terminal_activity reports what a terminal is doing now; session_note records authoritative findings (pass 'corrects' to supersede a wrong one); set_session_summary sets the running summary; get_session_context pulls the primer (summary + findings + ruled-out) a terminal reads to inherit what the session knows. Distinct from create_session et al., which manage individual terminals.

Notes: tool schemas may be deferred — if a tool isn't loaded yet, search for it by exact name to load its schema before calling. Prefer these structured tools over shelling out (e.g. git_status over running \`git status\`). See CLAUDE.md for full per-tool detail and the panel prop schemas.`



export async function startMcpServer(
  sessionService: TerminalService,
  workspaceService: WorkspaceService,
  appService: AppService,
  panelService: PanelService,
  notificationService: NotificationService,
  gitService: GitService,
  templateService: TemplateService,
  testRunnerService: TestRunnerService,
  layoutService: LayoutService,
  snippetService: SnippetService,
  broadcastService: BroadcastService,
  commandService: CommandService,
  clipboardService: ClipboardService,
  shellService: ShellService,
  notesService: NotesService,
  taskQueueService: TaskQueueService,
  systemService: SystemService,
  fileSearchService: FileSearchService,
  fileService: FileService,
  httpService: HttpService,
  portService: PortService,
  editService: EditService,
  processService: ProcessService,
  encodeService: EncodeService,
  jsonService: JsonService,
  timeService: TimeService,
  csvService: CsvService,
  regexService: RegexService,
  textService: TextService,
  colorService: ColorService,
  mathService: MathService,
  urlService: UrlService,
  uiService: UiService,
  missionService: MissionService,
  workSessionService: SessionService,
): Promise<{ port: number; configPath: string }> {
  // A single McpServer can only be bound to one transport at a time, so we
  // build a fresh server (with all tools registered) PER SSE connection. The
  // services are shared singletons — they own the real state — only the MCP
  // protocol wrapper is per-connection. This lets many Claude sessions (a
  // mission's Conductor + its workers) connect concurrently without colliding.
  const makeServer = () => {
    const server = new McpServer(
      {
        name: "claudetui",
        version: "0.1.0",
      },
      { instructions: SERVER_INSTRUCTIONS },
    )
    registerTools(
      server,
      sessionService,
      workspaceService,
      appService,
      panelService,
      notificationService,
      gitService,
      templateService,
      testRunnerService,
      layoutService,
      snippetService,
      broadcastService,
      commandService,
      clipboardService,
      shellService,
      notesService,
      taskQueueService,
      systemService,
      fileSearchService,
      fileService,
      httpService,
      portService,
      editService,
      processService,
      encodeService,
      jsonService,
      timeService,
      csvService,
      regexService,
      textService,
      colorService,
      mathService,
      urlService,
      uiService,
      missionService,
      workSessionService,
    )
    return server
  }

  // Create HTTP server with SSE transport
  const httpServer = createServer()
  const transports = new Map<string, SSEServerTransport>()

  httpServer.on("request", async (req, res) => {
    const url = req.url ?? ""

    if (url === "/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/messages", res)
      transports.set(transport.sessionId, transport)
      // Drop the transport when the client disconnects so the map doesn't leak.
      res.on("close", () => transports.delete(transport.sessionId))
      const server = makeServer()
      await server.connect(transport)
    } else if (url.startsWith("/messages") && req.method === "POST") {
      const parsed = new URL(url, "http://localhost")
      const sessionId = parsed.searchParams.get("sessionId")
      const transport = transports.get(sessionId ?? "")
      if (transport) {
        await transport.handlePostMessage(req, res)
      } else {
        res.writeHead(404)
        res.end("Transport not found")
      }
    } else {
      res.writeHead(404)
      res.end("Not found")
    }
  })

  // Listen on random available port bound to localhost only
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve)
  })

  const addr = httpServer.address()
  const port = typeof addr === "object" && addr ? addr.port : 0

  // Write MCP config file for spawned Claude sessions to auto-connect
  const { writeFileSync, mkdirSync } = await import("fs")
  const { join } = await import("path")
  const { tmpdir } = await import("os")

  const configDir = join(tmpdir(), "claudetui")
  mkdirSync(configDir, { recursive: true })
  const configPath = join(configDir, "mcp-config.json")

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          claudetui: {
            type: "sse",
            url: `http://127.0.0.1:${port}/sse`,
          },
        },
      },
      null,
      2,
    ),
  )

  console.log(`MCP server running on port ${port}`)
  return { port, configPath }
}
