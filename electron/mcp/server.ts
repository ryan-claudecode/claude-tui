import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { createServer } from "http"
import type { SessionService } from "../services/sessions"
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
import { registerTools } from "./tools"

export async function startMcpServer(
  sessionService: SessionService,
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
): Promise<{ port: number; configPath: string }> {
  const server = new McpServer({
    name: "claudetui",
    version: "0.1.0",
  })

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
  )

  // Create HTTP server with SSE transport
  const httpServer = createServer()
  const transports = new Map<string, SSEServerTransport>()

  httpServer.on("request", async (req, res) => {
    const url = req.url ?? ""

    if (url === "/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/messages", res)
      transports.set(transport.sessionId, transport)
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
