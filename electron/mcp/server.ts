import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { createServer, type Server } from "http"
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
import { registerTools, type TerminalIdentity } from "./tools"

// Injected into every connecting session's context via the MCP initialize
// result (the "MCP Server Instructions" block Claude Code surfaces). Gives a
// session spawned inside the app a map of what it can drive without having to
// load each deferred tool schema first to find out.
const SERVER_INSTRUCTIONS = `You are running inside ClaudeTUI — a workbench where agent work is durable and agents are first-class UI citizens — connected to its MCP server ("claudetui"). These tools are NOT a second copy of your native toolset (you already have files, shell, git, search). They exist for the three things no terminal can offer, organized around the app's pillars. Reach for native tools for ordinary file/shell/git work; reach for these to make work durable, render UI, and orchestrate.

Tool groups (all prefixed mcp__claudetui__):

PILLAR 1 — CONTINUITY (work outlives any single context window):
- Work sessions (the context engine) — create_work_session / list_work_sessions / work_session_status build a durable *container* that groups many terminals and accumulates knowledge across restarts and context exhaustion. set_terminal_activity reports what a terminal is doing now; session_note records authoritative findings (pass 'corrects' to supersede a wrong one); set_session_summary sets the running summary; get_session_context pulls the primer (summary + findings + ruled-out) a fresh terminal reads to inherit what the session knows. recall searches every finding + summary ACROSS sessions ("have we learned this before?") — call it BEFORE re-exploring; scope defaults to your workspace, ruled-out hits surface what was disproven (with the fix) so you don't re-walk dead ends. session_timeline renders the session's durable life-history (spawns/retires/notes/corrections/summaries/handoffs) as a timeline panel — the "what did my agents do while I was away?" view. list_folder_conversations + restore_conversation discover and reopen ANY past Claude Code conversation for a folder (including ones started outside this app) — claude --resume in that folder as a new work session.
- Session history — get_session_output / search_session_output (review what a background session did while you were away), get_session_activity (which sessions are active vs idle), wait_for_session_idle (delegate a task to another session and block until it finishes).
- Durable notes & setups — save_note / list_notes / get_note / delete_note / show_notes (a cross-session scratchpad on disk for the next session); list_session_templates / create_session_from_template (seed a purpose-built session); list_layouts / save_layout / restore_layout / delete_layout (snapshot and recreate a working set of sessions).

PILLAR 2 — AGENT-RENDERED UI (you drive the app back, routing the user's attention):
- Panels — show_panel renders a rich panel in the companion window: diff, image, markdown, table, test, chart, heatmap, tree, timeline, git, kanban, notes, stat, log, progress, code, mission. show_form shows an interactive form and waits for the user's submission. Plus update_panel / hide_panel / hide_all_panels / list_panels. diff_files opens an interactive, review-enabled diff of two files (or a proposed rewrite).
- Attention & handoff — notify (a toast that surfaces even when this terminal isn't focused — announce completion, request input, report errors), request_attention (put yourself on the user's attention queue when you need them) / get_attention_queue (see if the human is already backed up before raising another checkpoint), write_clipboard / read_clipboard (hand the user a finished artifact / read what they copied), open_external (open a URL in their browser), reveal_path (show a file in their OS file manager).
- App UI control — drive the same view actions the user can: set_focus_mode, toggle_panel_drawer, open_command_palette, show_keyboard_shortcuts, open_history_search, export_session_log, get_config.

PILLAR 3 — ORCHESTRATION (durable goals, dispatched workers, code-level supervision):
- Missions — mission_create/status/list/plan/dispatch/await/resolve/log/pause/resume/stop/finish: run a durable, on-disk mission where you (or another Conductor session) decompose a goal, dispatch worker sessions, review results, and commit — surviving context and usage limits. If spawned as a Conductor, call mission_status FIRST to load state and continue. Opt-in worktree isolation (isolate_workers on mission_create/plan, requires a git cwd) runs each worker in a private git worktree and review-gates its diff: a resolved-done task enters review — mission_review_queue lists pending diffs; mission_approve_task merges (clean → done, conflict → preserved for manual handling, never auto-resolved); mission_reject_task discards back to pending.
- Sessions & panes — create_session, kill_session, focus_session, rename_session, list_sessions, trigger_handoff, split_panes / close_split, broadcast_input (send the same input to many sessions at once).

SUPPORTING (observability & self-verification):
- Read-only git — git_status / git_log / git_diff / git_show / git_blame / git_branches return structured JSON for inspecting repo state without scraping the terminal. (Write-side git — commit/push/branch/stash — is deliberately NOT here; use your own shell.)
- Workspaces — the durable registry of user-named single-folder workspaces (the spatial frame sessions/missions scope to; each workspace is ONE optional directory): list_workspaces / get_active_workspace (read), rescan_workspaces (re-scan the configured paths for new workspace.json manifests and seed them — idempotent, never duplicates or reverts user edits), create_workspace (name + optional single dir) / rename_workspace / set_workspace_dir (set or clear the workspace's one folder; null clears) / delete_workspace (CRUD by registry id), set_active_workspace (SELECTION-ONLY — mark the active workspace; null clears to the 'All' bucket; does NOT spawn), launch_workspace (the explicit BOOT verb — open editors + spawn one session per repo, or one in the workspace's folder).
- Self-verification — take_screenshot, get_app_state, run_build, run_tests.

IF YOU WERE SPAWNED AS A TERMINAL IN A WORK SESSION: your identity is bound to this MCP connection — the work-session tools (get_session_context, set_terminal_activity, session_note, set_session_summary, work_session_status) all default to YOUR session and terminal, so call them with NO ids (e.g. set_terminal_activity({ activity: "running the test suite" })). On entry, call get_session_context to inherit what prior terminals discovered (root causes, gotchas, ruled-out approaches). As you work, call set_terminal_activity whenever your focus changes. Whenever you learn something a fresh terminal would otherwise re-discover, pin it with session_note (and session_note with 'corrects' if an earlier note was wrong). When you finish a chunk of work and go quiet, you may receive a short prompt asking you to refresh the session summary via set_session_summary — do it concisely; it's how a fresh terminal inherits your progress. On Ctrl+Shift+H you'll be asked to flush and retire. Then proceed with the user's instructions.

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
  templateService: TemplateService,
  testRunnerService: TestRunnerService,
  layoutService: LayoutService,
  broadcastService: BroadcastService,
  clipboardService: ClipboardService,
  shellService: ShellService,
  notesService: NotesService,
  fileService: FileService,
  uiService: UiService,
  missionService: MissionService,
  workSessionService: SessionService,
  recallService: RecallService,
  attentionService: AttentionService,
): Promise<{ port: number; configPath: string }> {
  // A single McpServer can only be bound to one transport at a time, so we
  // build a fresh server (with all tools registered) PER SSE connection. The
  // services are shared singletons — they own the real state — only the MCP
  // protocol wrapper is per-connection. This lets many Claude sessions (a
  // mission's Conductor + its workers) connect concurrently without colliding.
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
      templateService,
      testRunnerService,
      layoutService,
      broadcastService,
      clipboardService,
      shellService,
      notesService,
      fileService,
      uiService,
      missionService,
      workSessionService,
      recallService,
      attentionService,
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
