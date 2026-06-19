import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { TerminalService } from "../../services/terminals"
import type { BroadcastService } from "../../services/broadcast"
import type { AttentionService } from "../../services/attention"
import type { SessionService } from "../../services/sessions"
import type { WorkspaceService } from "../../services/workspaces"
import type { TerminalIdentity } from "./shared"

export function registerSessionTools(
  server: McpServer,
  sessions: TerminalService,
  broadcast: BroadcastService,
  attention: AttentionService,
  workSessions: SessionService,
  workspaces: WorkspaceService,
  identity: TerminalIdentity = {},
) {
  server.tool(
    "create_session",
    "Create a new Claude Code session in ClaudeTUI",
    {
      name: z.string().optional().describe("Session name"),
      cwd: z.string().optional().describe("Working directory"),
    },
    async ({ name, cwd }) => {
      // WS-G — parity with the renderer path (SessionService.openSession): when NO
      // explicit cwd is given, default to the active workspace's primary dir so
      // agent/MCP-created sessions also land in the active workspace ("ALL chats
      // should spawn in that directory"). null → TerminalService falls back to its
      // own default cwd (process.cwd()).
      const resolvedCwd =
        cwd && cwd.trim() ? cwd : workspaces.getActiveWorkspaceDir() ?? undefined
      const info = sessions.create(name, resolvedCwd)
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
    "Trigger context handoff on a ClaudeTUI session (the terminal id). For an xterm terminal this fires Claude Code's /handoff. For a structured (headless) terminal it runs the durable retire-&-continue: flush the summary, spawn a fresh terminal in the same work session, and retire the old one.",
    {
      id: z.string().describe("Terminal ID to hand off"),
    },
    async ({ id }) => {
      // BO-4a (punch-list c): a structured terminal has no interactive PTY and no
      // `/handoff` slash command — sessions.handoff() would be a silent no-op that
      // returned a false success. Route it to the durable retire-&-continue, which
      // handles structured terminals (clean flush + a fresh headless replacement).
      if (sessions.isHeadless(id)) {
        const sessionId = workSessions.sessionIdOf(id)
        if (!sessionId) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Cannot hand off: this structured terminal isn't registered in a work session.",
              },
            ],
          }
        }
        const res = workSessions.handoffTerminal(sessionId, id)
        return {
          content: [
            {
              type: "text" as const,
              text: res ? `Handoff complete — continued in terminal ${res.terminalId}` : "Handoff failed",
            },
          ],
        }
      }
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

  // Broadcast — fan one input out to many sessions at once (synchronize panes)

  server.tool(
    "broadcast_input",
    "Send the same input to multiple sessions at once (the 'synchronize panes' move). By default it goes to every open session; pass session_ids to scope it to a subset. Set submit=true to press Enter and actually run/send the text, or leave it false to just stage the text in each prompt. Returns which sessions received it.",
    {
      content: z.string().describe("Text to send to each session"),
      session_ids: z
        .array(z.string())
        .optional()
        .describe("Sessions to target (defaults to all open sessions)"),
      submit: z
        .boolean()
        .optional()
        .describe("Append Enter to submit the input instead of just staging it (default: false)"),
    },
    async ({ content, session_ids, submit }) => {
      const result = broadcast.broadcast(content, session_ids, submit)
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  // Session history — review/search captured terminal output ("what happened while away")

  server.tool(
    "get_session_output",
    "Get the recent captured terminal output (scrollback) of a session as plain text. Use this to review what happened in a session — e.g. a background session you weren't watching — without scraping the live terminal.",
    {
      session_id: z.string().describe("Session whose output to read"),
      max_chars: z
        .number()
        .optional()
        .describe("Maximum characters of trailing output to return (default: 8000)"),
    },
    async ({ session_id, max_chars }) => {
      const output = sessions.getOutput(session_id, max_chars)
      if (output == null) {
        return { content: [{ type: "text" as const, text: `Session not found: ${session_id}` }] }
      }
      return { content: [{ type: "text" as const, text: output || "(no output captured yet)" }] }
    },
  )

  server.tool(
    "search_session_output",
    "Search captured session output for a string (case-insensitive) and return matching lines with their session and line number. Searches all sessions by default, or pass session_id to scope it. Useful for finding an error, a command, or a result across sessions you weren't watching.",
    {
      query: z.string().describe("Text to search for (case-insensitive)"),
      session_id: z
        .string()
        .optional()
        .describe("Limit the search to one session (defaults to all sessions)"),
      limit: z.number().optional().describe("Maximum matches to return (default: 50)"),
    },
    async ({ query, session_id, limit }) => {
      const matches = sessions.searchOutput(query, session_id, limit)
      return {
        content: [
          {
            type: "text" as const,
            text:
              matches.length > 0
                ? JSON.stringify(matches, null, 2)
                : `No matches for "${query}"`,
          },
        ],
      }
    },
  )

  server.tool(
    "get_session_activity",
    "Report per-session activity: which sessions are actively working (producing output) vs. idle (gone quiet, likely waiting for input), and how many milliseconds each has been idle. Use this to tell which background session needs attention without watching every terminal.",
    {},
    async () => {
      const activity = sessions.getActivity()
      return {
        content: [{ type: "text" as const, text: JSON.stringify(activity, null, 2) }],
      }
    },
  )

  server.tool(
    "wait_for_session_idle",
    "Block until a session finishes working (its output goes quiet) or a timeout elapses, then return its recent output. The orchestration primitive: optionally inject `input` to delegate a task, then wait for the session to complete it — instead of polling get_session_activity. Returns { idle, timedOut } plus a tail of the session's output produced during the wait.",
    {
      session_id: z.string().describe("Session to wait on"),
      input: z
        .string()
        .optional()
        .describe("Text to send to the session before waiting (delegate a task)"),
      submit: z
        .boolean()
        .optional()
        .describe("When sending input, append Enter to actually run it (default: false)"),
      quiet_ms: z
        .number()
        .optional()
        .describe("Milliseconds of no output that counts as 'done' (default: 1500)"),
      timeout_ms: z
        .number()
        .optional()
        .describe("Give up after this many ms and report timedOut (default: 120000)"),
    },
    async ({ session_id, input, submit, quiet_ms, timeout_ms }) => {
      const result = await sessions.waitForIdle(session_id, {
        input,
        submit,
        quietMs: quiet_ms,
        timeoutMs: timeout_ms,
      })
      const output = sessions.getOutput(session_id, 4000)
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ...result, output }, null, 2),
          },
        ],
      }
    },
  )

  // Attention queue — the "who needs me?" surface. Read it to see whether the
  // human is already backed up before raising another checkpoint; request it to
  // put yourself on the queue when you need the user.

  server.tool(
    "get_attention_queue",
    "Read the attention queue — the ordered list of things waiting on the user (forms you're blocked on, sessions that asked or finished, attributed errors). Tier 1 = blocked, tier 2 = asked/error, tier 3 = finished; ordered tier-ascending then oldest-first. Use it to check whether the human is already backed up before adding another checkpoint or notification.",
    {},
    async () => {
      return { content: [{ type: "text" as const, text: JSON.stringify(attention.list(), null, 2) }] }
    },
  )

  server.tool(
    "request_attention",
    "Put yourself on the attention queue (a tier-2 'asked' entry) when you need the user — e.g. you're blocked on a decision but didn't raise a form. Ids default to your own terminal/session; just pass a reason. The reason is shown to the user prefixed as agent-requested.",
    {
      reason: z.string().describe("Why you need the user, in one line"),
      session_id: z.string().optional(),
      terminal_id: z.string().optional(),
    },
    async ({ reason, session_id, terminal_id }) => {
      const sid = session_id ?? identity.sessionId
      const tid = terminal_id ?? identity.terminalId
      if (!sid) {
        return { content: [{ type: "text" as const, text: "No work session bound to this connection — pass session_id." }] }
      }
      const entry = attention.request(sid, tid, reason)
      return { content: [{ type: "text" as const, text: JSON.stringify(entry, null, 2) }] }
    },
  )
}
