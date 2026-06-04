import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { SessionService } from "../services/sessions"
import type { WorkspaceService } from "../services/workspaces"
import type { AppService } from "../services/app"
import type { PanelService } from "../services/panels"
import type { NotificationService } from "../services/notifications"

export function registerTools(
  server: McpServer,
  sessions: SessionService,
  workspaces: WorkspaceService,
  appService: AppService,
  panels: PanelService,
  notifications: NotificationService,
) {
  server.tool(
    "create_session",
    "Create a new Claude Code session in ClaudeTUI",
    {
      name: z.string().optional().describe("Session name"),
      cwd: z.string().optional().describe("Working directory"),
    },
    async ({ name, cwd }) => {
      const info = sessions.create(name, cwd)
      return { content: [{ type: "text" as const, text: JSON.stringify(info) }] }
    },
  )

  server.tool(
    "kill_session",
    "Kill a ClaudeTUI session",
    {
      id: z.string().describe("Session ID"),
    },
    async ({ id }) => {
      const ok = sessions.kill(id)
      return {
        content: [{ type: "text" as const, text: ok ? "Session killed" : "Session not found" }],
      }
    },
  )

  server.tool("list_sessions", "List all active ClaudeTUI sessions", {}, async () => {
    const list = sessions.list()
    return { content: [{ type: "text" as const, text: JSON.stringify(list, null, 2) }] }
  })

  server.tool(
    "focus_session",
    "Switch focus to a ClaudeTUI session",
    {
      id: z.string().describe("Session ID"),
    },
    async ({ id }) => {
      const ok = sessions.focus(id)
      return {
        content: [
          { type: "text" as const, text: ok ? `Focused session ${id}` : "Session not found" },
        ],
      }
    },
  )

  server.tool(
    "rename_session",
    "Rename a ClaudeTUI session",
    {
      id: z.string().describe("Session ID"),
      name: z.string().describe("New name"),
    },
    async ({ id, name }) => {
      const ok = sessions.rename(id, name)
      return {
        content: [
          { type: "text" as const, text: ok ? `Renamed to ${name}` : "Session not found" },
        ],
      }
    },
  )

  server.tool(
    "trigger_handoff",
    "Trigger context handoff on a ClaudeTUI session",
    {
      id: z.string().describe("Session ID"),
    },
    async ({ id }) => {
      sessions.handoff(id)
      return { content: [{ type: "text" as const, text: "Handoff triggered" }] }
    },
  )

  server.tool(
    "split_panes",
    "Split ClaudeTUI view showing two sessions side by side",
    {
      left_id: z.string().describe("Left pane session ID"),
      right_id: z.string().describe("Right pane session ID"),
    },
    async ({ left_id, right_id }) => {
      const ok = sessions.splitPanes(left_id, right_id)
      return {
        content: [
          {
            type: "text" as const,
            text: ok ? "Split view activated" : "One or both sessions not found",
          },
        ],
      }
    },
  )

  server.tool("close_split", "Close ClaudeTUI split view", {}, async () => {
    sessions.closeSplit()
    return { content: [{ type: "text" as const, text: "Split view closed" }] }
  })

  server.tool("list_workspaces", "List discovered ClaudeTUI workspaces", {}, async () => {
    const list = workspaces.list()
    return { content: [{ type: "text" as const, text: JSON.stringify(list, null, 2) }] }
  })

  server.tool(
    "activate_workspace",
    "Boot a workspace (open editors + create sessions)",
    {
      index: z.number().describe("Workspace index from list_workspaces"),
    },
    async ({ index }) => {
      const result = workspaces.activate(index)
      return {
        content: [
          {
            type: "text" as const,
            text: result ? JSON.stringify(result) : "Workspace not found",
          },
        ],
      }
    },
  )

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
      const state = appService.getAppState(sessions.list(), workspaces.list())
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

  // Rich panel tools

  server.tool(
    "show_panel",
    "Show a rich UI panel in ClaudeTUI (diff, image, markdown, or table). For interactive forms that return user input, use show_form instead.",
    {
      type: z.enum(["diff", "image", "markdown", "table"]).describe("Panel type"),
      props: z.record(z.any()).describe("Panel-specific data"),
      position: z.enum(["right", "bottom"]).optional().describe("Drawer position"),
    },
    async ({ type, props, position }) => {
      const panel = panels.show(type, props, position)
      return { content: [{ type: "text" as const, text: JSON.stringify(panel) }] }
    },
  )

  server.tool(
    "show_form",
    "Show an interactive form panel and wait for the user to submit. Returns the submitted field values (or { cancelled: true } if closed). Fields support types: text, textarea, select, checklist, toggle, number.",
    {
      props: z
        .record(z.any())
        .describe(
          "Form definition: { title, fields: [{ name, type, label, options?, items? }], submitLabel? }",
        ),
      position: z.enum(["right", "bottom"]).optional().describe("Drawer position"),
    },
    async ({ props, position }) => {
      const data = await panels.showForm(props, position)
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] }
    },
  )

  server.tool(
    "update_panel",
    "Update an existing panel's content",
    {
      id: z.string().describe("Panel ID"),
      props: z.record(z.any()).describe("Updated properties (merged into existing)"),
    },
    async ({ id, props }) => {
      const ok = panels.update(id, props)
      return { content: [{ type: "text" as const, text: ok ? "Panel updated" : "Panel not found" }] }
    },
  )

  server.tool(
    "hide_panel",
    "Hide a panel by ID",
    {
      id: z.string().describe("Panel ID"),
    },
    async ({ id }) => {
      const ok = panels.hide(id)
      return { content: [{ type: "text" as const, text: ok ? "Panel hidden" : "Panel not found" }] }
    },
  )

  server.tool("hide_all_panels", "Hide all open panels", {}, async () => {
    panels.hideAll()
    return { content: [{ type: "text" as const, text: "All panels hidden" }] }
  })

  server.tool("list_panels", "List all open ClaudeTUI panels", {}, async () => {
    return { content: [{ type: "text" as const, text: JSON.stringify(panels.list(), null, 2) }] }
  })

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
      const notification = notifications.notify(message, level, title, timeout)
      return { content: [{ type: "text" as const, text: JSON.stringify(notification) }] }
    },
  )
}
