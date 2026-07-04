import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { SessionService } from "../../services/sessions"
import type { PanelService } from "../../services/panels"
import type { TerminalIdentity } from "./shared"

export function registerWorkSessionTools(
  server: McpServer,
  workSessions: SessionService,
  panels: PanelService,
  identity: TerminalIdentity = {},
) {
  // Work sessions — the durable *container* that groups many terminals (conversation
  // resume, handoff, activity). Distinct from create_session et al., which operate on
  // individual terminals.
  server.tool(
    "create_work_session",
    "Create a new durable work-session container (a goal-scoped grouping of terminals that accumulates findings). Returns the WorkSession.",
    {},
    async () => {
      const s = workSessions.create()
      return { content: [{ type: "text" as const, text: JSON.stringify(s, null, 2) }] }
    },
  )

  server.tool(
    "list_work_sessions",
    "List all work-session containers.",
    {},
    async () => {
      return { content: [{ type: "text" as const, text: JSON.stringify(workSessions.list(), null, 2) }] }
    },
  )

  server.tool(
    "work_session_status",
    "Load a work-session container's full state — the resume entry point. Defaults to your own work session; omit session_id for the most-recently-updated active session.",
    { session_id: z.string().optional() },
    async ({ session_id }) => {
      const s = workSessions.status(session_id ?? identity.sessionId)
      return { content: [{ type: "text" as const, text: s ? JSON.stringify(s, null, 2) : "No active work session" }] }
    },
  )

  // CAPP-75 — discover + restore ANY Claude Code conversation for a folder,
  // INCLUDING ones started outside the app (plain `claude` in a terminal). Claude
  // Code writes every conversation's transcript to
  // ~/.claude/projects/<encoded-cwd>/<id>.jsonl, so listing that dir enumerates
  // them all and `claude --resume <id>` reopens any.
  server.tool(
    "list_folder_conversations",
    "List every resumable Claude Code conversation for a folder (INCLUDING conversations started outside this app — plain `claude` in a terminal), newest first. Returns [{ id, updatedAt (epoch ms, the transcript's last-write time), preview (first user message, ~80 chars) }]. Pass the folder's absolute path; an empty list means no Claude history for that folder. Use the returned id with restore_conversation.",
    { folder: z.string().describe("Absolute path of the folder whose conversations to list") },
    async ({ folder }) => {
      const convos = workSessions.listFolderConversations(folder)
      return { content: [{ type: "text" as const, text: JSON.stringify(convos, null, 2) }] }
    },
  )

  server.tool(
    "restore_conversation",
    "Reopen a Claude Code conversation by id (from list_folder_conversations) — spawns a fresh terminal running `claude --resume <id>` in the folder, as a new work session bound to it. Works for conversations started outside this app too. Returns the new { session, terminalId }, or an error if the folder/id is invalid.",
    {
      folder: z.string().describe("Absolute path of the folder the conversation belongs to"),
      conversation_id: z.string().describe("The conversation id from list_folder_conversations"),
    },
    async ({ folder, conversation_id }) => {
      const result = workSessions.openConversationInFolder(folder, conversation_id)
      return {
        content: [
          {
            type: "text" as const,
            text: result
              ? JSON.stringify({ session: result.session, terminalId: result.terminalId }, null, 2)
              : "Could not restore the conversation (invalid folder/id, or terminals not ready).",
          },
        ],
      }
    },
  )

  server.tool(
    "register_terminal",
    "Register a terminal into a work-session container (so its findings and activity roll up to the session). The first terminal's name seeds the session name while it's still 'Untitled session'.",
    {
      session_id: z.string(),
      terminal_id: z.string().describe("The terminal/session id from create_session"),
      name: z.string(),
      cwd: z.string(),
    },
    async ({ session_id, terminal_id, name, cwd }) => {
      workSessions.addTerminal(session_id, { id: terminal_id, name, cwd, lastState: "active" })
      // Seed the session name from the first terminal while it's still a placeholder.
      workSessions.nameTerminal(session_id, terminal_id, name)
      const s = workSessions.get(session_id)
      return { content: [{ type: "text" as const, text: s ? JSON.stringify(s, null, 2) : "Work session not found" }] }
    },
  )

  server.tool(
    "set_terminal_activity",
    "Report what your terminal is doing right now (rich-presence line shown under the session). Ids default to your own terminal — just pass an activity. Optionally update state (active/idle/dead).",
    {
      activity: z.string().describe("Short present-tense line, e.g. 'running the test suite'"),
      state: z.enum(["active", "idle", "dead"]).optional(),
      session_id: z.string().optional(),
      terminal_id: z.string().optional(),
    },
    async ({ session_id, terminal_id, activity, state }) => {
      const sid = session_id ?? identity.sessionId
      const tid = terminal_id ?? identity.terminalId
      if (!sid || !tid) {
        return { content: [{ type: "text" as const, text: "No terminal identity bound to this connection — pass session_id and terminal_id." }] }
      }
      workSessions.setTerminalActivity(sid, tid, activity)
      if (state) workSessions.setTerminalState(sid, tid, state)
      return { content: [{ type: "text" as const, text: workSessions.deriveStatus(sid) }] }
    },
  )

}
