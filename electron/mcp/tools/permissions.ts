import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { TerminalService } from "../../services/terminals"
import {
  PERMISSION_TOOL_NAME,
  buildPermissionResult,
  type PermissionDecision,
} from "../../services/streamProtocol"
import type { TerminalIdentity } from "./shared"
import type { NotificationLevel } from "../../services/notifications"

/**
 * BO-3 — the headless permission gate. `claude -p` is spawned with
 * `--permission-prompt-tool mcp__claudetui__approve_tool` (see
 * TerminalService.createHeadless); when a tool isn't pre-approved Claude calls
 * THIS tool synchronously and blocks on its return. We attribute the call to the
 * caller's terminal (the identity bound to this MCP connection, exactly like
 * show_form), surface a PermissionRequest to the renderer, block on the user's
 * Allow/Deny, and return the wire JSON Claude expects.
 *
 * Wire shape (captured live, see docs/spikes/bo3-permission-prompt.md):
 *   in  : { tool_name, input, tool_use_id }
 *   out : {"behavior":"allow","updatedInput":{…}} | {"behavior":"deny","message":"…"}
 * ALLOW MUST echo updatedInput or the gated tool is blocked — buildPermissionResult
 * enforces that (falling back to the original input when unedited).
 */
export function registerPermissionTools(
  server: McpServer,
  sessions: TerminalService,
  identity: TerminalIdentity = {},
  // BO-10 — a user-visible notification seam (wired to NotificationService.notify
  // in tools.ts). Optional so the existing unit tests can omit it; in production
  // it surfaces an attribution failure that would otherwise be a silent hang.
  notify?: (message: string, level: NotificationLevel, title?: string) => void,
) {
  server.tool(
    PERMISSION_TOOL_NAME,
    "INTERNAL — ClaudeTUI's permission gate. Claude Code invokes this automatically (via --permission-prompt-tool) when a tool needs the user's approval in headless mode; do NOT call it directly. It surfaces an Allow/Deny prompt to the user and returns their decision.",
    {
      tool_name: z.string().describe("The tool requesting permission"),
      input: z.any().optional().describe("The tool's argument object"),
      tool_use_id: z.string().optional().describe("Correlates to the assistant tool_use block"),
    },
    async ({ tool_name, input, tool_use_id }) => {
      const terminalId = identity.terminalId
      // Without a bound terminal we can't surface a prompt to anyone — fail safe
      // by denying (never silently auto-allow, which would defeat the gate).
      // BO-10 — but the deny goes only to Claude; a SILENT auto-deny looks to the
      // user like the agent hung (the dogfooding bug). Raise a visible toast so a
      // failed identity attribution is observable, not a mystery stall.
      if (!terminalId) {
        notify?.(
          `A tool (${tool_name}) requested permission but couldn't be attributed to a session, so it was auto-denied.`,
          "warning",
          "Permission auto-denied",
        )
        const result = { behavior: "deny" as const, message: "ClaudeTUI: no terminal bound to this MCP connection; cannot prompt for permission." }
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
      }
      const decision: PermissionDecision = await sessions.requestPermission({
        terminalId,
        toolName: tool_name,
        toolInput: input,
        toolUseId: tool_use_id,
      })
      const result = buildPermissionResult(decision, input)
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
    },
  )
}
