import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
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

export function registerTools(
  server: McpServer,
  sessions: SessionService,
  workspaces: WorkspaceService,
  appService: AppService,
  panels: PanelService,
  notifications: NotificationService,
  git: GitService,
  templates: TemplateService,
  tests: TestRunnerService,
  layouts: LayoutService,
  snippets: SnippetService,
  broadcast: BroadcastService,
  commands: CommandService,
  clipboard: ClipboardService,
  shellService: ShellService,
  notes: NotesService,
) {
  // Resolve a working directory for git ops: prefer the named session's cwd,
  // fall back to the first open session, then the app's own cwd.
  const resolveCwd = (sessionId?: string): string => {
    const list = sessions.list()
    if (sessionId) {
      const match = list.find((s) => s.id === sessionId)
      if (match) return match.cwd
    }
    return list[0]?.cwd ?? process.cwd()
  }

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
    "Show a rich UI panel in ClaudeTUI (diff, image, markdown, table, or test). For interactive forms that return user input, use show_form instead.",
    {
      type: z.enum(["diff", "image", "markdown", "table", "test"]).describe("Panel type"),
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

  // Git tools — structured, read-only repo state for the session's working dir

  server.tool(
    "git_status",
    "Get structured git status (branch, ahead/behind, staged & unstaged changes) for a session's working directory. Use this to inspect repo state without parsing raw terminal output.",
    {
      session_id: z
        .string()
        .optional()
        .describe("Session whose cwd to inspect (defaults to the first open session)"),
    },
    async ({ session_id }) => {
      try {
        const status = git.status(resolveCwd(session_id))
        return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `git status failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "git_log",
    "Get recent commits (hash, author, date, subject) for a session's working directory.",
    {
      session_id: z.string().optional().describe("Session whose cwd to inspect"),
      limit: z.number().optional().describe("Number of commits to return (default: 15)"),
    },
    async ({ session_id, limit }) => {
      try {
        const commits = git.log(resolveCwd(session_id), limit)
        return { content: [{ type: "text" as const, text: JSON.stringify(commits, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `git log failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "git_diff",
    "Get the git diff for a session's working directory. Optionally scope to one file and/or staged changes.",
    {
      session_id: z.string().optional().describe("Session whose cwd to inspect"),
      file: z.string().optional().describe("Limit the diff to a single file path"),
      staged: z.boolean().optional().describe("Show staged changes (--staged) instead of unstaged"),
    },
    async ({ session_id, file, staged }) => {
      try {
        const diff = git.diff(resolveCwd(session_id), file, staged)
        return {
          content: [{ type: "text" as const, text: diff || "(no changes)" }],
        }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `git diff failed: ${e.message}` }] }
      }
    },
  )

  // Session template tools — spawn purpose-built sessions seeded with a prompt

  server.tool(
    "list_session_templates",
    "List available session templates (pre-configured session types like 'code review' or 'debugging' that seed a starter prompt).",
    {},
    async () => {
      return { content: [{ type: "text" as const, text: JSON.stringify(templates.list(), null, 2) }] }
    },
  )

  server.tool(
    "create_session_from_template",
    "Create a new session from a template (see list_session_templates). Spawns the session and types the template's starter prompt into it once Claude has booted.",
    {
      template_id: z.string().describe("Template id from list_session_templates"),
      cwd: z.string().optional().describe("Working directory (overrides the template's default)"),
    },
    async ({ template_id, cwd }) => {
      const info = templates.instantiate(template_id, cwd)
      return {
        content: [
          {
            type: "text" as const,
            text: info ? JSON.stringify(info) : `Template not found: ${template_id}`,
          },
        ],
      }
    },
  )

  // Test runner — run a project's test suite and surface parsed results in a panel

  server.tool(
    "run_tests",
    "Run a project's test suite in a session's working directory and show the parsed results (pass/fail/skip counts, exit code, duration, output) in a test panel. Use this to verify changes without scraping the terminal.",
    {
      session_id: z
        .string()
        .optional()
        .describe("Session whose cwd to run tests in (defaults to the first open session)"),
      command: z
        .string()
        .optional()
        .describe("Test command to run (default: 'npm test'). e.g. 'npm test', 'vitest run', 'pytest'"),
      show_panel: z
        .boolean()
        .optional()
        .describe("Show the result in a test panel (default: true)"),
    },
    async ({ session_id, command, show_panel }) => {
      try {
        const result = tests.run(resolveCwd(session_id), command)
        if (show_panel !== false) {
          panels.show("test", { result })
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `run_tests failed: ${e.message}` }] }
      }
    },
  )

  // Saved layout tools — snapshot/restore a named set of sessions + working dirs

  server.tool(
    "list_layouts",
    "List saved session layouts. A layout is a named snapshot of open sessions and their working directories that can be restored later (e.g. after an app restart).",
    {},
    async () => {
      return { content: [{ type: "text" as const, text: JSON.stringify(layouts.list(), null, 2) }] }
    },
  )

  server.tool(
    "save_layout",
    "Save the currently open sessions (names + working directories) as a named layout. Re-saving with an existing name overwrites it.",
    {
      name: z.string().describe("Name for the layout, e.g. 'frontend' or 'incident-review'"),
    },
    async ({ name }) => {
      const layout = layouts.save(name)
      return { content: [{ type: "text" as const, text: JSON.stringify(layout) }] }
    },
  )

  server.tool(
    "restore_layout",
    "Restore a saved layout by recreating each of its sessions. Returns the newly created sessions.",
    {
      name: z.string().describe("Name of the layout to restore (see list_layouts)"),
    },
    async ({ name }) => {
      const created = layouts.restore(name)
      return {
        content: [
          {
            type: "text" as const,
            text: created ? JSON.stringify(created) : `Layout not found: ${name}`,
          },
        ],
      }
    },
  )

  server.tool(
    "delete_layout",
    "Delete a saved layout by name.",
    {
      name: z.string().describe("Name of the layout to delete"),
    },
    async ({ name }) => {
      const ok = layouts.delete(name)
      return {
        content: [
          { type: "text" as const, text: ok ? "Layout deleted" : `Layout not found: ${name}` },
        ],
      }
    },
  )

  // Snippet tools — reusable prompt snippets injected into an existing session

  server.tool(
    "list_snippets",
    "List saved prompt snippets. A snippet is a named, reusable piece of text that can be injected into an open session's input with send_snippet.",
    {},
    async () => {
      return { content: [{ type: "text" as const, text: JSON.stringify(snippets.list(), null, 2) }] }
    },
  )

  server.tool(
    "save_snippet",
    "Save a reusable prompt snippet under a name (overwrites an existing one with the same name).",
    {
      name: z.string().describe("Snippet name, e.g. 'run-and-fix' or 'pr-checklist'"),
      content: z.string().describe("The snippet text"),
    },
    async ({ name, content }) => {
      const snippet = snippets.save(name, content)
      return { content: [{ type: "text" as const, text: JSON.stringify(snippet) }] }
    },
  )

  server.tool(
    "send_snippet",
    "Inject a saved snippet's text into a session's input (does not press Enter). Use list_snippets to see available names.",
    {
      name: z.string().describe("Name of the snippet to send"),
      session_id: z.string().describe("Session to inject the snippet into"),
    },
    async ({ name, session_id }) => {
      const ok = snippets.send(name, session_id)
      return {
        content: [
          { type: "text" as const, text: ok ? `Sent snippet '${name}'` : `Snippet not found: ${name}` },
        ],
      }
    },
  )

  server.tool(
    "delete_snippet",
    "Delete a saved snippet by name.",
    {
      name: z.string().describe("Name of the snippet to delete"),
    },
    async ({ name }) => {
      const ok = snippets.delete(name)
      return {
        content: [
          { type: "text" as const, text: ok ? "Snippet deleted" : `Snippet not found: ${name}` },
        ],
      }
    },
  )

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

  // Command runner — run a one-off shell command and capture structured output

  server.tool(
    "run_command",
    "Run a one-off shell command in a session's working directory and get back structured output (exit code, stdout, stderr, duration). Use this for quick checks like lint, typecheck, or a git porcelain command without scraping the terminal. Output is captured, not streamed — for long-running or interactive processes, use a real session instead.",
    {
      command: z.string().describe("Shell command to run, e.g. 'npm run lint' or 'git status --short'"),
      session_id: z
        .string()
        .optional()
        .describe("Session whose cwd to run in (defaults to the first open session)"),
      timeout_ms: z
        .number()
        .optional()
        .describe("Max milliseconds before the command is killed (default: 60000)"),
    },
    async ({ command, session_id, timeout_ms }) => {
      try {
        const result = commands.run(command, resolveCwd(session_id), timeout_ms)
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `run_command failed: ${e.message}` }] }
      }
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

  // Notes — a persistent cross-session scratchpad. Leave durable context for a
  // future session (or yourself after a restart) that snippets/templates can't:
  // gotchas, decisions, "the prod DB host is X", task hand-off notes.

  server.tool(
    "save_note",
    "Save a durable note to the cross-session scratchpad (persisted to disk). Use this to leave context that a FUTURE Claude session should know — decisions made, gotchas discovered, where things live, or a hand-off summary. Pass an existing note's `id` to update it instead of creating a new one. Returns the saved note (with its id).",
    {
      title: z.string().describe("Short title for the note"),
      body: z.string().describe("The note's content (markdown is fine)"),
      scope: z
        .string()
        .optional()
        .describe("Optional project/working-dir path this note pertains to, for later filtering"),
      tags: z.array(z.string()).optional().describe("Optional tags for grouping/filtering"),
      id: z.string().optional().describe("Existing note id to update; omit to create a new note"),
    },
    async ({ title, body, scope, tags, id }) => {
      const note = notes.save(title, body, { id, scope, tags })
      return { content: [{ type: "text" as const, text: JSON.stringify(note, null, 2) }] }
    },
  )

  server.tool(
    "list_notes",
    "List saved scratchpad notes, most-recently-updated first. Optionally filter by `scope` (substring match on the note's project path) and/or `tag`. Call this at the start of work to recover context a prior session left behind.",
    {
      scope: z.string().optional().describe("Filter to notes whose scope contains this substring"),
      tag: z.string().optional().describe("Filter to notes carrying this tag"),
    },
    async ({ scope, tag }) => {
      const list = notes.list(scope, tag)
      return { content: [{ type: "text" as const, text: JSON.stringify(list, null, 2) }] }
    },
  )

  server.tool(
    "get_note",
    "Fetch a single scratchpad note by its id.",
    {
      id: z.string().describe("Note id"),
    },
    async ({ id }) => {
      const note = notes.get(id)
      return {
        content: [
          { type: "text" as const, text: note ? JSON.stringify(note, null, 2) : "Note not found" },
        ],
      }
    },
  )

  server.tool(
    "delete_note",
    "Delete a scratchpad note by its id once it's no longer relevant.",
    {
      id: z.string().describe("Note id"),
    },
    async ({ id }) => {
      const ok = notes.delete(id)
      return { content: [{ type: "text" as const, text: ok ? "Note deleted" : "Note not found" }] }
    },
  )
}
