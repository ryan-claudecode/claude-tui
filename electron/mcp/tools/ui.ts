import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { UiService } from "../../services/ui"

export function registerUiTools(server: McpServer, ui: UiService) {
  // App UI control tools — drive the same view actions a user can trigger by
  // keyboard/menu. Each fans a command to the renderer via UiService. Boolean
  // toggles take an optional desired state; omit it to flip the current state.

  server.tool(
    "set_focus_mode",
    "Toggle or set ClaudeTUI's distraction-free focus mode (hides the sidebar and tab bar so only the terminal(s) and panels show). Omit `enabled` to toggle.",
    {
      enabled: z.boolean().optional().describe("true = on, false = off, omit = toggle"),
    },
    async ({ enabled }) => {
      ui.setFocusMode(enabled)
      const label = enabled === undefined ? "toggled" : enabled ? "enabled" : "disabled"
      return { content: [{ type: "text" as const, text: `Focus mode ${label}` }] }
    },
  )

  server.tool(
    "open_command_palette",
    "Open or close the ClaudeTUI command palette (the Ctrl+Shift+P fuzzy action menu). Omit `open` to toggle.",
    {
      open: z.boolean().optional().describe("true = open, false = close, omit = toggle"),
    },
    async ({ open }) => {
      ui.setCommandPalette(open)
      return { content: [{ type: "text" as const, text: `Command palette ${open === false ? "closed" : "opened"}` }] }
    },
  )

  server.tool(
    "show_keyboard_shortcuts",
    "Open or close the ClaudeTUI keyboard-shortcuts help overlay (Ctrl+/). Omit `open` to toggle.",
    {
      open: z.boolean().optional().describe("true = open, false = close, omit = toggle"),
    },
    async ({ open }) => {
      ui.setShortcutsHelp(open)
      return { content: [{ type: "text" as const, text: `Shortcuts help ${open === false ? "closed" : "opened"}` }] }
    },
  )

  server.tool(
    "open_history_search",
    "Open or close the ClaudeTUI session-history search overlay (Ctrl+Shift+F — searches captured session output). Omit `open` to toggle.",
    {
      open: z.boolean().optional().describe("true = open, false = close, omit = toggle"),
    },
    async ({ open }) => {
      ui.setHistorySearch(open)
      return { content: [{ type: "text" as const, text: `History search ${open === false ? "closed" : "opened"}` }] }
    },
  )

  server.tool(
    "export_session_log",
    "Trigger a download of a session's captured output as a .txt file. Defaults to the active session if `session_id` is omitted.",
    {
      session_id: z.string().optional().describe("Session ID (defaults to the active session)"),
    },
    async ({ session_id }) => {
      ui.exportSessionLog(session_id)
      return { content: [{ type: "text" as const, text: "Session log export triggered" }] }
    },
  )
}
