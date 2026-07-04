import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { TerminalService } from "../../services/terminals"
import type { WorkspaceService } from "../../services/workspaces"
import type { AppService } from "../../services/app"
import type { PanelService } from "../../services/panels"
import type { NotificationService } from "../../services/notifications"
import type { ClipboardService } from "../../services/clipboard"
import type { ShellService } from "../../services/shell"
import { loadConfig } from "../../config"
import type { TerminalIdentity } from "./shared"

export function registerAppTools(
  server: McpServer,
  sessions: TerminalService,
  workspaces: WorkspaceService,
  appService: AppService,
  panels: PanelService,
  notifications: NotificationService,
  clipboard: ClipboardService,
  shellService: ShellService,
  identity: TerminalIdentity = {},
) {
  // NOTE: the workspace tool group (list_workspaces, get_active_workspace,
  // create/rename/add-dir/remove-dir/delete/set-active/launch) lives in its own
  // module — see ./workspaces.ts (registered from tools.ts). `workspaces` is still
  // injected here only for `get_app_state`'s workspace snapshot below.

  // Testing infrastructure tools

  server.tool("take_screenshot", "Capture a screenshot of the ClaudeTUI window", {}, async () => {
    try {
      const base64 = await appService.captureScreenshot()
      return { content: [{ type: "image" as const, data: base64, mimeType: "image/png" }] }
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Screenshot failed: ${e.message}` }] }
    }
  })

  server.tool(
    "get_app_state",
    "Get current ClaudeTUI application state (sessions, workspaces, window info)",
    {},
    async () => {
      const state = appService.getAppState(sessions.list(), workspaces.listPublic())
      return { content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }] }
    },
  )

  server.tool("run_build", "Build the ClaudeTUI project and check for errors", {}, async () => {
    const result = appService.runBuild()
    return {
      content: [
        {
          type: "text" as const,
          text: `${result.success ? "BUILD SUCCESS" : "BUILD FAILED"}\n${result.output}`,
        },
      ],
    }
  })

  server.tool(
    "get_config",
    "Read ClaudeTUI's current configuration (~/.claude-tui/config.json) — theme, default command/args, and workspace scan paths.",
    {},
    async () => {
      const config = loadConfig()
      return { content: [{ type: "text" as const, text: JSON.stringify(config, null, 2) }] }
    },
  )

  // Notification tools

  server.tool(
    "notify",
    "Show a toast notification in ClaudeTUI. Use this to alert the user when a background task finishes, you need their input, or you hit an error — it surfaces even when this session's terminal isn't focused.",
    {
      message: z.string().describe("Notification body text"),
      level: z
        .enum(["info", "success", "warning", "error"])
        .optional()
        .describe("Severity / color of the toast (default: info)"),
      title: z.string().optional().describe("Optional bold title line"),
      timeout: z
        .number()
        .optional()
        .describe("Milliseconds before auto-dismiss; 0 keeps it until dismissed (default: 5000)"),
    },
    async ({ message, level, title, timeout }) => {
      // Attribute the toast to the caller's work session so an error/warning
      // surfaces in the attention queue as a tier-2 `error` entry.
      const notification = notifications.notify(message, level, title, timeout, identity.sessionId)
      return { content: [{ type: "text" as const, text: JSON.stringify(notification) }] }
    },
  )

  // Clipboard — hand artifacts to the user's clipboard or read what they copied

  server.tool(
    "write_clipboard",
    "Write text to the user's system clipboard. Use this to hand the user a finished artifact (a command, regex, snippet, or path) so they can paste it elsewhere without copying it out of the terminal.",
    {
      text: z.string().describe("Text to place on the clipboard"),
    },
    async ({ text }) => {
      const result = clipboard.write(text)
      return {
        content: [
          { type: "text" as const, text: `Copied ${result.length} chars to clipboard` },
        ],
      }
    },
  )

  server.tool(
    "read_clipboard",
    "Read the current text contents of the user's system clipboard. Use this to pull in something the user just copied (an error message, a URL, a snippet) without asking them to paste it.",
    {},
    async () => {
      const result = clipboard.read()
      return {
        content: [
          {
            type: "text" as const,
            text: result.text ? result.text : "(clipboard is empty)",
          },
        ],
      }
    },
  )

  // Shell — hand a URL or file off to the user's operating system

  server.tool(
    "open_external",
    "Open a URL in the user's default browser (or other default external app for the scheme). Use this to pop open a localhost dev server you just started, documentation, or any link — instead of asking the user to copy/paste it.",
    {
      url: z.string().describe("URL to open, e.g. 'http://localhost:5173' or 'https://...'"),
    },
    async ({ url }) => {
      const result = await shellService.openExternal(url)
      return {
        content: [
          {
            type: "text" as const,
            text: result.ok ? `Opened ${url}` : `Failed to open ${url}: ${result.error}`,
          },
        ],
      }
    },
  )

  server.tool(
    "reveal_path",
    "Reveal a file or folder in the user's OS file manager (Explorer/Finder), selecting it. Use this to show the user where a file you created or modified lives on disk.",
    {
      path: z.string().describe("Absolute path to the file or folder to reveal"),
    },
    async ({ path }) => {
      shellService.revealPath(path)
      return { content: [{ type: "text" as const, text: `Revealed ${path}` }] }
    },
  )
}
