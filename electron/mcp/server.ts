import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { createServer, type Server } from "http"
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
import type { AttentionService } from "../services/attention"
import type { ContextInspectorService } from "../services/contextInspector"
import { registerTools, type TerminalIdentity } from "./tools"

// Injected into every connecting session's context via the MCP initialize
// result (the "MCP Server Instructions" block Claude Code surfaces). Gives a
// session spawned inside the app a map of what it can drive without having to
// load each deferred tool schema first to find out.
const SERVER_INSTRUCTIONS = `You are running inside ClaudeTUI — a workbench where agent work is durable and agents are first-class UI citizens — connected to its MCP server ("claudetui"). These tools are NOT a second copy of your native toolset (you already have files, shell, git, search). They exist for the three things no terminal can offer, organized around the app's pillars. Reach for native tools for ordinary file/shell/git work; reach for these to make work durable, render UI, and orchestrate.

Tool groups (all prefixed mcp__claudetui__):

PILLAR 1 — CONTINUITY (work outlives any single context window):
- Work sessions — create_work_session / list_work_sessions / work_session_status build a durable *container* that groups many terminals and survives restarts. set_terminal_activity reports what a terminal is doing now. list_folder_conversations + restore_conversation discover and reopen ANY past Claude Code conversation for a folder (including ones started outside this app) — claude --resume in that folder as a new work session. Durable KNOWLEDGE lives in Claude's own native memory (CLAUDE.md / CLAUDE.local.md / auto-memory), not in this app.
- Session history — get_session_output / search_session_output (review what a background session did while you were away), get_session_activity (which sessions are active vs idle), wait_for_session_idle (delegate a task to another session and block until it finishes).
- Durable notes — save_note / list_notes / get_note / delete_note / show_notes (a cross-session scratchpad on disk for the next session).
- Native context (READ-ONLY) — inspect_workspace_context enumerates the complete launch-time context a fresh Claude eats in a workspace — managed policy, user/project memory + rules, parent-chain, native auto-memory — by precedence; @imports listed not expanded; it NEVER writes a file.

PILLAR 2 — AGENT-RENDERED UI (you drive the app back, routing the user's attention):
- Panels — show_panel renders a rich panel in the companion window: diff, image, markdown, table, test, chart, heatmap, tree, timeline, git, kanban, notes, stat, log, progress, code. show_form shows an interactive form and waits for the user's submission. Plus update_panel / hide_panel / hide_all_panels / list_panels. diff_files opens an interactive, review-enabled diff of two files (or a proposed rewrite).
- Asking the user a question — the native AskUserQuestion tool is NOT available in this environment; use ask_user to ask an interactive question. It BLOCKS until the user answers and raises their attention: pass a question plus optional options (2-8 click-to-select choices), multi_select, and/or allow_free_text; it returns their chosen label(s) and any free text.
- Attention & handoff — notify (a toast that surfaces even when this terminal isn't focused — announce completion, request input, report errors), request_attention (put yourself on the user's attention queue when you need them) / get_attention_queue (see if the human is already backed up before raising another checkpoint), write_clipboard / read_clipboard (hand the user a finished artifact / read what they copied), open_external (open a URL in their browser), reveal_path (show a file in their OS file manager).
- App UI control — drive the same view actions the user can: set_focus_mode, open_command_palette, show_keyboard_shortcuts, open_history_search, export_session_log, get_config.

PILLAR 3 — ORCHESTRATION (durable goals, code-level supervision):
- Sessions & panes — create_session, kill_session, focus_session, rename_session, list_sessions, trigger_handoff, split_panes / close_split.
- Scheduler (on-device recurring/one-shot runs) — schedule_create/list/update/delete/run_now: register a headless Claude run to fire on THIS machine at set times (interval with an optional time-of-day window + weekday filter, daily-at, or once) — the on-device answer to cloud scheduling (local files, git, gh, the user's auth). schedule_update enables/disables; schedule_run_now fires immediately. Every schedule is visible in the sidebar and scoped to your bound session's workspace by default.

SUPPORTING (observability & self-verification):
- Read-only git — git_status / git_log / git_diff / git_show / git_blame / git_branches return structured JSON for inspecting repo state without scraping the terminal. (Write-side git — commit/push/branch/stash — is deliberately NOT here; use your own shell.)
- Workspaces — the durable registry of user-named single-folder workspaces (the spatial frame sessions scope to; each workspace is ONE optional directory): list_workspaces / get_active_workspace (read), rescan_workspaces (re-scan the configured paths for new workspace.json manifests and seed them — idempotent, never duplicates or reverts user edits), create_workspace (name + optional single dir) / rename_workspace / set_workspace_dir (set or clear the workspace's one folder; null clears) / delete_workspace (CRUD by registry id), set_active_workspace (SELECTION-ONLY — mark the active workspace; null clears to the 'All' bucket; does NOT spawn), launch_workspace (the explicit BOOT verb — open editors + spawn one session per repo, or one in the workspace's folder).
- Self-verification — take_screenshot, get_app_state, run_build, run_tests.

IF YOU WERE SPAWNED AS A TERMINAL IN A WORK SESSION: your identity is bound to this MCP connection — the work-session tools (set_terminal_activity, work_session_status) default to YOUR session and terminal, so call them with NO ids (e.g. set_terminal_activity({ activity: "running the test suite" })). As you work, call set_terminal_activity whenever your focus changes. On Ctrl+Shift+H you'll be asked to retire and continue in a fresh terminal. Record durable knowledge in the project's native memory files (CLAUDE.md / CLAUDE.local.md), not in this app. Then proceed with the user's instructions.

Notes: tool schemas may be deferred — if a tool isn't loaded yet, search for it by exact name to load its schema before calling. See CLAUDE.md for full per-tool detail and the panel prop schemas.`



// Bind an http server to a random loopback port. Unlike a bare `listen()` call,
// this rejects (instead of leaving the promise pending or emitting an unhandled
// `error`) if the bind fails, and surfaces an invalid bound port as an error —
// so a failed MCP startup is loud rather than silent. Exported for unit testing
// the failure path in isolation.
export function listenOnLoopback(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (err: Error) => reject(err)
    server.once("error", onError)
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError)
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      if (!port) {
        reject(new Error("MCP server bound to invalid port"))
        return
      }
      resolve(port)
    })
  })
}

export async function startMcpServer(
  sessionService: TerminalService,
  workspaceService: WorkspaceService,
  appService: AppService,
  panelService: PanelService,
  notificationService: NotificationService,
  gitService: GitService,
  testRunnerService: TestRunnerService,
  clipboardService: ClipboardService,
  shellService: ShellService,
  notesService: NotesService,
  fileService: FileService,
  uiService: UiService,
  workSessionService: SessionService,
  attentionService: AttentionService,
  contextInspectorService: ContextInspectorService,
  schedulerService: SchedulerService,
): Promise<{ port: number; configPath: string }> {
  // A single McpServer can only be bound to one transport at a time, so we
  // build a fresh server (with all tools registered) PER SSE connection. The
  // services are shared singletons — they own the real state — only the MCP
  // protocol wrapper is per-connection. This lets many Claude sessions connect
  // concurrently without colliding.
  const makeServer = (identity: TerminalIdentity = {}) => {
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
      testRunnerService,
      clipboardService,
      shellService,
      notesService,
      fileService,
      uiService,
      workSessionService,
      attentionService,
      contextInspectorService,
      schedulerService,
      identity,
    )
    return server
  }

  // Create HTTP server with SSE transport
  const httpServer = createServer()
  const transports = new Map<string, SSEServerTransport>()

  httpServer.on("request", async (req, res) => {
    const url = req.url ?? ""

    const parsedReq = new URL(url, "http://localhost")

    if (parsedReq.pathname === "/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/messages", res)
      transports.set(transport.sessionId, transport)
      // Drop the transport when the client disconnects so the map doesn't leak.
      res.on("close", () => transports.delete(transport.sessionId))
      // Bind this connection to the spawning terminal's identity. The only
      // trusted carrier is the random token minted in mcpConfigFor; raw sid/tid
      // on the URL are debug breadcrumbs, never trusted. A valid token resolves
      // to the *real* sid/tid (ignoring the URL's claims); a missing/invalid
      // token yields empty identity (legitimate anonymous use) — we never reject
      // the connection.
      const token = parsedReq.searchParams.get("token")
      const resolved = token ? sessionService.resolveIdentityToken(token) : undefined
      const identity: TerminalIdentity = resolved
        ? { sessionId: resolved.sessionId, terminalId: resolved.terminalId }
        : {}
      const server = makeServer(identity)
      await server.connect(transport)
    } else if (parsedReq.pathname === "/messages" && req.method === "POST") {
      const sessionId = parsedReq.searchParams.get("sessionId")
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

  // Listen on random available port bound to localhost only. Rejects on a bind
  // failure or an invalid bound port so the caller can surface it to the user.
  const port = await listenOnLoopback(httpServer)

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
