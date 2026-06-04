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
import type { TaskQueueService } from "../services/taskqueue"
import type { SystemService } from "../services/system"
import type { FileSearchService } from "../services/filesearch"
import type { FileService } from "../services/files"
import type { HttpService } from "../services/http"
import type { PortService } from "../services/ports"
import type { EditService } from "../services/edit"
import type { ProcessService } from "../services/process"

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
  taskQueue: TaskQueueService,
  system: SystemService,
  fileSearch: FileSearchService,
  files: FileService,
  http: HttpService,
  ports: PortService,
  edit: EditService,
  processes: ProcessService,
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
    "Show a rich UI panel in ClaudeTUI (diff, image, markdown, table, test, chart, tree, timeline, git, or kanban). For interactive forms that return user input, use show_form instead. For chart: props = { kind: 'bar'|'line'|'pie', title?, unit?, data: [{ label, value, color? }] }. For tree: props = { data: <any JSON value>, title?, defaultExpandDepth? } — a collapsible JSON/data tree viewer. For timeline: props = { title?, steps: [{ label, status?: 'done'|'active'|'pending'|'error', detail?, meta? }] } — multi-step task progress. For git: props = the git_status result ({ branch, ahead, behind, clean, changes: [{ path, status, staged, label }] }) plus optional commits: [{ hash, author, date, subject }] from git_log — a staged/unstaged file overview. For kanban: props = { title?, columns: [{ title, color?, cards: [{ title, tag?, detail?, color? }] }] } — a board of grouped cards for status buckets or parallel workstreams. For notes: props = { title?, notes: [{ id, title, body, scope?, tags?, updatedAt? }] } — the cross-session scratchpad (prefer the show_notes tool, which loads saved notes for you). For stat: props = { title?, stats: [{ label, value, unit?, delta?, trend?: 'up'|'down'|'flat', color?, hint? }] } — a dashboard of big-number KPI cards (test counts, coverage %, build time, bundle size); distinct from chart, which is for series viz.",
    {
      type: z.enum(["diff", "image", "markdown", "table", "test", "chart", "tree", "timeline", "git", "kanban", "notes", "stat"]).describe("Panel type"),
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

  server.tool(
    "git_show",
    "Show a single commit (or any ref): full metadata (hash, author, email, date, subject, body), the changed-files summary (--stat), and the patch. git_log lists commits; this drills into one of them so you can review exactly what changed. Defaults to HEAD.",
    {
      session_id: z.string().optional().describe("Session whose cwd to inspect"),
      ref: z.string().optional().describe("Commit hash or ref to show (default: HEAD)"),
    },
    async ({ session_id, ref }) => {
      try {
        const detail = git.show(resolveCwd(session_id), ref)
        return { content: [{ type: "text" as const, text: JSON.stringify(detail, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `git show failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "git_stage",
    "Stage changes in a session's working directory. Pass specific file paths, or omit `files` to stage everything (git add -A). Returns the refreshed git status.",
    {
      session_id: z.string().optional().describe("Session whose cwd to operate in"),
      files: z.array(z.string()).optional().describe("File paths to stage (omit to stage all)"),
    },
    async ({ session_id, files }) => {
      try {
        const status = git.stage(resolveCwd(session_id), files)
        return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `git stage failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "git_unstage",
    "Unstage changes in a session's working directory (keeps working-tree edits). Pass specific file paths, or omit `files` to unstage everything. Returns the refreshed git status.",
    {
      session_id: z.string().optional().describe("Session whose cwd to operate in"),
      files: z.array(z.string()).optional().describe("File paths to unstage (omit to unstage all)"),
    },
    async ({ session_id, files }) => {
      try {
        const status = git.unstage(resolveCwd(session_id), files)
        return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `git unstage failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "git_commit",
    "Create a commit from staged changes in a session's working directory. Set `all` to also stage tracked modifications first (git commit -a). Returns the new commit and refreshed status.",
    {
      session_id: z.string().optional().describe("Session whose cwd to operate in"),
      message: z.string().describe("Commit message"),
      all: z.boolean().optional().describe("Stage all tracked modifications before committing (-a)"),
    },
    async ({ session_id, message, all }) => {
      try {
        const result = git.commit(resolveCwd(session_id), message, all)
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `git commit failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "git_branch",
    "Create a new branch in a session's working directory (checks it out by default). Returns the refreshed git status.",
    {
      session_id: z.string().optional().describe("Session whose cwd to operate in"),
      name: z.string().describe("New branch name"),
      checkout: z.boolean().optional().describe("Check out the new branch (default: true)"),
    },
    async ({ session_id, name, checkout }) => {
      try {
        const status = git.createBranch(resolveCwd(session_id), name, checkout ?? true)
        return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `git branch failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "git_checkout",
    "Switch to an existing branch or ref in a session's working directory. Returns the refreshed git status.",
    {
      session_id: z.string().optional().describe("Session whose cwd to operate in"),
      ref: z.string().describe("Branch name or ref to check out"),
    },
    async ({ session_id, ref }) => {
      try {
        const status = git.checkout(resolveCwd(session_id), ref)
        return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `git checkout failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "git_push",
    "Push commits to the remote for a session's working directory. Returns push output plus the refreshed git status (ahead count drops to 0 on success).",
    {
      session_id: z.string().optional().describe("Session whose cwd to operate in"),
    },
    async ({ session_id }) => {
      try {
        const result = git.push(resolveCwd(session_id))
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `git push failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "git_pull",
    "Pull from the remote (fast-forward only) for a session's working directory. Returns pull output plus the refreshed git status.",
    {
      session_id: z.string().optional().describe("Session whose cwd to operate in"),
    },
    async ({ session_id }) => {
      try {
        const result = git.pull(resolveCwd(session_id))
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `git pull failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "git_stash",
    "Stash the working-tree changes in a session's working directory (optionally with a message). Returns stash output plus the refreshed git status.",
    {
      session_id: z.string().optional().describe("Session whose cwd to operate in"),
      message: z.string().optional().describe("Optional stash message"),
    },
    async ({ session_id, message }) => {
      try {
        const result = git.stash(resolveCwd(session_id), message)
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `git stash failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "git_stash_pop",
    "Re-apply and drop a stash entry (the latest, or a given ref like 'stash@{1}') in a session's working directory. Returns output plus the refreshed git status.",
    {
      session_id: z.string().optional().describe("Session whose cwd to operate in"),
      ref: z.string().optional().describe("Stash ref to pop (default: most recent)"),
    },
    async ({ session_id, ref }) => {
      try {
        const result = git.stashPop(resolveCwd(session_id), ref)
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `git stash pop failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "git_stash_list",
    "List stash entries for a session's working directory.",
    {
      session_id: z.string().optional().describe("Session whose cwd to operate in"),
    },
    async ({ session_id }) => {
      try {
        const list = git.stashList(resolveCwd(session_id))
        return { content: [{ type: "text" as const, text: JSON.stringify(list, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `git stash list failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "git_blame",
    "Line-by-line authorship for a file: which commit (hash, author, date, summary) last touched each line, plus the line content. Answers 'why is this line here / who changed it'. Optionally scope to a 1-based inclusive start_line/end_line range.",
    {
      file: z.string().describe("File path (relative to the session's cwd) to blame"),
      session_id: z.string().optional().describe("Session whose cwd to operate in"),
      start_line: z.number().optional().describe("First line of the range (1-based, inclusive)"),
      end_line: z.number().optional().describe("Last line of the range (1-based, inclusive)"),
    },
    async ({ file, session_id, start_line, end_line }) => {
      try {
        const blame = git.blame(resolveCwd(session_id), file, start_line, end_line)
        return { content: [{ type: "text" as const, text: JSON.stringify(blame, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `git blame failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "git_file_history",
    "Commit history for a single file (follows renames). git_log covers the whole repo; this answers 'how did this one file evolve?' — returns commits (hash, author, date, subject) that touched it.",
    {
      file: z.string().describe("File path (relative to the session's cwd) to get history for"),
      session_id: z.string().optional().describe("Session whose cwd to operate in"),
      limit: z.number().optional().describe("Number of commits to return (default: 20)"),
    },
    async ({ file, session_id, limit }) => {
      try {
        const commits = git.fileHistory(resolveCwd(session_id), file, limit)
        return { content: [{ type: "text" as const, text: JSON.stringify(commits, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `git file history failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "git_branches",
    "List local and remote-tracking branches (name, whether it's the current branch, whether it's remote). Fills the gap between git_branch (create) and git_checkout (switch): answers 'what can I switch to?'.",
    {
      session_id: z.string().optional().describe("Session whose cwd to inspect"),
    },
    async ({ session_id }) => {
      try {
        const branches = git.branches(resolveCwd(session_id))
        return { content: [{ type: "text" as const, text: JSON.stringify(branches, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `git branches failed: ${e.message}` }] }
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

  server.tool(
    "show_notes",
    "Show the saved scratchpad notes in a UI panel so the USER can see the durable cross-session context Claude has accumulated (the notes are otherwise invisible to them). Loads notes via the same filters as list_notes (`scope` substring / `tag`) and renders each note's title, scope, tags, and markdown body. Returns how many notes were shown.",
    {
      scope: z.string().optional().describe("Filter to notes whose scope contains this substring"),
      tag: z.string().optional().describe("Filter to notes carrying this tag"),
      title: z.string().optional().describe("Optional heading for the panel (defaults to \"Notes\")"),
      position: z.enum(["right", "bottom"]).optional().describe("Drawer position"),
    },
    async ({ scope, tag, title, position }) => {
      const list = notes.list(scope, tag)
      const panel = panels.show("notes", { title, notes: list }, position)
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ panelId: panel.id, count: list.length }),
          },
        ],
      }
    },
  )

  // Task queue — a shared job board across the open sessions. ClaudeTUI runs
  // several sessions at once; use this to coordinate: enqueue work, then let any
  // session claim and complete items. Persists to disk, so a backlog survives
  // restarts.

  server.tool(
    "enqueue_task",
    "Add a work item to the shared task queue for other sessions (or a later one) to pick up. Use this to hand off or stash work you can't do now.",
    {
      title: z.string().describe("Short summary of the task"),
      detail: z.string().optional().describe("Optional longer description / acceptance notes"),
    },
    async ({ title, detail }) => {
      const task = taskQueue.enqueue(title, detail)
      return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] }
    },
  )

  server.tool(
    "list_tasks",
    "List tasks on the shared queue (pending first). Optionally filter by status. Check this to find work waiting to be done.",
    {
      status: z
        .enum(["pending", "claimed", "done"])
        .optional()
        .describe("Filter to a single status"),
    },
    async ({ status }) => {
      const list = taskQueue.list(status)
      return { content: [{ type: "text" as const, text: JSON.stringify(list, null, 2) }] }
    },
  )

  server.tool(
    "claim_task",
    "Claim a pending task so other sessions know you're working on it. Fails if the task is already claimed or done.",
    {
      id: z.string().describe("Task id"),
      by: z.string().optional().describe("Who's claiming it — a session id or label"),
    },
    async ({ id, by }) => {
      const task = taskQueue.claim(id, by)
      const text =
        task === undefined
          ? "Task not found"
          : task === null
            ? "Task already claimed or done"
            : JSON.stringify(task, null, 2)
      return { content: [{ type: "text" as const, text }] }
    },
  )

  server.tool(
    "complete_task",
    "Mark a task done.",
    {
      id: z.string().describe("Task id"),
    },
    async ({ id }) => {
      const task = taskQueue.complete(id)
      return {
        content: [
          { type: "text" as const, text: task ? JSON.stringify(task, null, 2) : "Task not found" },
        ],
      }
    },
  )

  server.tool(
    "delete_task",
    "Remove a task from the queue entirely.",
    {
      id: z.string().describe("Task id"),
    },
    async ({ id }) => {
      const ok = taskQueue.delete(id)
      return { content: [{ type: "text" as const, text: ok ? "Task deleted" : "Task not found" }] }
    },
  )

  server.tool(
    "clear_done_tasks",
    "Remove all completed tasks from the queue. Returns how many were cleared.",
    {},
    async () => {
      const n = taskQueue.clearDone()
      return { content: [{ type: "text" as const, text: `Cleared ${n} completed task(s)` }] }
    },
  )

  // System — read-only environment awareness so you can tailor commands to the
  // host instead of guessing or spawning throwaway shell calls.

  server.tool(
    "get_system_info",
    "Get info about the machine ClaudeTUI is running on: OS platform/arch, hostname, CPU, total/free memory, uptime, home dir, and Node/Electron/Chrome versions. Use this to tailor commands to the host.",
    {},
    async () => {
      const info = system.getInfo()
      return { content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }] }
    },
  )

  server.tool(
    "which_command",
    "Check whether an executable is available on PATH and where it resolves to (cross-platform). Use this before running a tool to confirm it's installed instead of relying on a command failing.",
    {
      command: z.string().describe("Executable name to locate, e.g. 'node', 'pnpm', 'git'"),
    },
    async ({ command }) => {
      const result = system.which(command)
      const text = result.found
        ? `${command} found:\n${result.paths.join("\n")}`
        : `${command} not found on PATH`
      return { content: [{ type: "text" as const, text }] }
    },
  )

  // File search — structured file discovery + content grep scoped to a
  // session's working dir (no shell, cross-platform, bounded results).
  server.tool(
    "find_files",
    "Find files by glob pattern within a session's working directory. Supports *, ** and ?. Returns relative paths and sizes. Skips node_modules/.git/build output. Use this to locate files without scraping a terminal `find`/`dir`.",
    {
      session_id: z.string().optional().describe("Session whose working dir to search (defaults to the first open session)"),
      pattern: z.string().describe("Glob pattern matched against forward-slash relative paths, e.g. '**/*.ts' or 'src/**/index.*'"),
      limit: z.number().optional().describe("Max files to return (default 200)"),
    },
    async ({ session_id, pattern, limit }) => {
      const cwd = resolveCwd(session_id)
      const files = fileSearch.findFiles(cwd, pattern, limit)
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ cwd, count: files.length, files }, null, 2),
          },
        ],
      }
    },
  )

  server.tool(
    "grep_code",
    "Search file contents under a session's working directory for a regex pattern. Returns matching lines with file path and line number. Skips node_modules/.git/build output and files over 1MB. Optionally restrict to files matching a glob. Use this instead of a terminal grep/Select-String for portable, structured results.",
    {
      session_id: z.string().optional().describe("Session whose working dir to search (defaults to the first open session)"),
      pattern: z.string().describe("Regex to search for in file contents (falls back to literal match if not a valid regex)"),
      glob: z.string().optional().describe("Only search files whose relative path matches this glob, e.g. '**/*.ts'"),
      case_insensitive: z.boolean().optional().describe("Ignore case when matching (default false)"),
      max_matches: z.number().optional().describe("Max matches to return (default 200)"),
    },
    async ({ session_id, pattern, glob, case_insensitive, max_matches }) => {
      const cwd = resolveCwd(session_id)
      const result = fileSearch.grep(cwd, pattern, {
        glob,
        caseInsensitive: case_insensitive,
        maxMatches: max_matches,
      })
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ cwd, ...result }, null, 2),
          },
        ],
      }
    },
  )

  // File read/write — structured access scoped to a session's working dir,
  // resolving relative paths against it. Pairs with find_files/grep_code.
  server.tool(
    "read_file",
    "Read a file (relative to a session's working dir, or absolute) and return its contents. Optionally pass start_line/end_line (1-based, inclusive) to read just a slice. Returns total line count so you can page through large files. Refuses files over 2MB.",
    {
      session_id: z.string().optional().describe("Session whose working dir to resolve relative paths against (defaults to the first open session)"),
      path: z.string().describe("File path, relative to the working dir or absolute"),
      start_line: z.number().optional().describe("First line to return, 1-based inclusive"),
      end_line: z.number().optional().describe("Last line to return, 1-based inclusive"),
    },
    async ({ session_id, path: filePath, start_line, end_line }) => {
      try {
        const result = files.read(resolveCwd(session_id), filePath, start_line, end_line)
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `read_file failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "write_file",
    "Write content to a file (relative to a session's working dir, or absolute), creating parent directories as needed. Overwrites the file if it exists. Returns the resolved path, bytes written, and whether the file was newly created. Use for quick scaffolding or edits without scraping a terminal redirect.",
    {
      session_id: z.string().optional().describe("Session whose working dir to resolve relative paths against (defaults to the first open session)"),
      path: z.string().describe("File path, relative to the working dir or absolute"),
      content: z.string().describe("Full content to write to the file"),
    },
    async ({ session_id, path: filePath, content }) => {
      try {
        const result = files.write(resolveCwd(session_id), filePath, content)
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `write_file failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "tail_file",
    "Read the last N lines of a file (relative to a session's working dir, or absolute) — the log-tailing counterpart of read_file. Only the final 512KB are read, so it works on large logs that read_file refuses; `partial` is true when earlier content was skipped.",
    {
      session_id: z.string().optional().describe("Session whose working dir to resolve relative paths against (defaults to the first open session)"),
      path: z.string().describe("File path, relative to the working dir or absolute"),
      lines: z.number().optional().describe("Number of trailing lines to return (default: 50)"),
    },
    async ({ session_id, path: filePath, lines }) => {
      try {
        const result = files.tail(resolveCwd(session_id), filePath, lines)
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `tail_file failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "stat_path",
    "Get metadata for a file or directory (relative to a session's working dir, or absolute): existence, kind, size, and modified/created timestamps — without scraping `ls -l`/`stat`. Returns `exists: false` instead of erroring for a missing path.",
    {
      session_id: z.string().optional().describe("Session whose working dir to resolve relative paths against (defaults to the first open session)"),
      path: z.string().describe("File or directory path, relative to the working dir or absolute"),
    },
    async ({ session_id, path: filePath }) => {
      try {
        const result = files.stat(resolveCwd(session_id), filePath)
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `stat_path failed: ${e.message}` }] }
      }
    },
  )

  // Filesystem operations — move/copy/delete/mkdir without shelling out to
  // mv/cp/rm/mkdir. Paths resolve against a session's working dir (same as
  // read_file/write_file). Directories are handled recursively.
  server.tool(
    "move_path",
    "Move or rename a file or directory (paths relative to a session's working dir, or absolute). Creates the destination's parent directories as needed. Returns the resolved from/to paths and whether it was a file or directory.",
    {
      session_id: z.string().optional().describe("Session whose working dir to resolve relative paths against (defaults to the first open session)"),
      from: z.string().describe("Source path, relative to the working dir or absolute"),
      to: z.string().describe("Destination path, relative to the working dir or absolute"),
    },
    async ({ session_id, from, to }) => {
      try {
        const result = files.move(resolveCwd(session_id), from, to)
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `move_path failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "copy_path",
    "Copy a file or directory (paths relative to a session's working dir, or absolute). Directories are copied recursively. Creates the destination's parent directories as needed. Returns the resolved from/to paths and whether it was a file or directory.",
    {
      session_id: z.string().optional().describe("Session whose working dir to resolve relative paths against (defaults to the first open session)"),
      from: z.string().describe("Source path, relative to the working dir or absolute"),
      to: z.string().describe("Destination path, relative to the working dir or absolute"),
    },
    async ({ session_id, from, to }) => {
      try {
        const result = files.copy(resolveCwd(session_id), from, to)
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `copy_path failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "delete_path",
    "Delete a file or directory (path relative to a session's working dir, or absolute). Directories are removed recursively. Throws if the path does not exist. Returns the resolved path and whether it was a file or directory.",
    {
      session_id: z.string().optional().describe("Session whose working dir to resolve relative paths against (defaults to the first open session)"),
      path: z.string().describe("Path to delete, relative to the working dir or absolute"),
    },
    async ({ session_id, path: filePath }) => {
      try {
        const result = files.remove(resolveCwd(session_id), filePath)
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `delete_path failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "make_dir",
    "Create a directory (path relative to a session's working dir, or absolute), including any missing parent directories. No error if it already exists. Returns the resolved path.",
    {
      session_id: z.string().optional().describe("Session whose working dir to resolve relative paths against (defaults to the first open session)"),
      path: z.string().describe("Directory path to create, relative to the working dir or absolute"),
    },
    async ({ session_id, path: dirPath }) => {
      try {
        const result = files.makeDir(resolveCwd(session_id), dirPath)
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `make_dir failed: ${e.message}` }] }
      }
    },
  )

  // Show a diff of two files (or a file vs proposed content) in the interactive
  // review-enabled diff panel. Reads via FileService and hands the contents to
  // the existing DiffPanel — distinct from git_diff (which only diffs tracked
  // working-tree changes): this compares arbitrary files (two config versions,
  // a backup vs current, generated output vs expected, or a preview of a write).
  server.tool(
    "diff_files",
    "Open an interactive diff panel comparing two files (or a file vs inline content). Provide old_path + new_path to diff two files on disk, old_path + new_content to preview a proposed rewrite, or just new_path/new_content to show its lines as all additions. Paths resolve against a session's working dir (or absolute). Unlike git_diff (tracked changes only) this compares any files. Renders the same review-enabled panel as show_panel, so the user can select hunks and send you a review request. Returns the created panel.",
    {
      session_id: z.string().optional().describe("Session whose working dir to resolve relative paths against (defaults to the first open session)"),
      old_path: z.string().optional().describe("Path to the 'before' file, relative to the working dir or absolute"),
      new_path: z.string().optional().describe("Path to the 'after' file, relative to the working dir or absolute"),
      new_content: z.string().optional().describe("Inline 'after' content — alternative to new_path"),
      label: z.string().optional().describe("File label shown above the diff (defaults to the new/old path)"),
      position: z.enum(["right", "bottom"]).optional().describe("Drawer position"),
    },
    async ({ session_id, old_path, new_path, new_content, label, position }) => {
      try {
        if (!old_path && !new_path && new_content === undefined) {
          return { content: [{ type: "text" as const, text: "diff_files failed: provide old_path and/or new_path (or new_content)" }] }
        }
        if (new_path && new_content !== undefined) {
          return { content: [{ type: "text" as const, text: "diff_files failed: provide either new_path or new_content, not both" }] }
        }
        const cwd = resolveCwd(session_id)

        let oldContent = ""
        let oldResolved: string | undefined
        if (old_path) {
          const r = files.read(cwd, old_path)
          oldContent = r.content
          oldResolved = r.path
        }

        let newContent = ""
        let newResolved: string | undefined
        if (new_content !== undefined) {
          newContent = new_content
        } else if (new_path) {
          const r = files.read(cwd, new_path)
          newContent = r.content
          newResolved = r.path
        }

        const filePath = label ?? newResolved ?? oldResolved ?? "diff"
        const panel = panels.show("diff", { files: [{ path: filePath, oldContent, newContent }] }, position)
        return { content: [{ type: "text" as const, text: JSON.stringify(panel, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `diff_files failed: ${e.message}` }] }
      }
    },
  )

  // Surgical edits — the middle ground between read_file and write_file. Change
  // a precise string or insert at a line without rewriting (and risking
  // clobbering) the whole file.
  server.tool(
    "replace_in_file",
    "Replace an exact string in a file (relative to a session's working dir, or absolute). By default old_string must occur exactly once so the edit is unambiguous; set replace_all to change every occurrence. Fails if old_string is missing, not unique (without replace_all), or equal to new_string. Returns the resolved path, number of replacements, and bytes written. Prefer this over rewriting the whole file with write_file for small edits.",
    {
      session_id: z.string().optional().describe("Session whose working dir to resolve relative paths against (defaults to the first open session)"),
      path: z.string().describe("File path, relative to the working dir or absolute"),
      old_string: z.string().describe("The exact text to replace (include surrounding context to make it unique)"),
      new_string: z.string().describe("The text to replace it with"),
      replace_all: z.boolean().optional().describe("Replace every occurrence instead of requiring a unique match (default false)"),
    },
    async ({ session_id, path: filePath, old_string, new_string, replace_all }) => {
      try {
        const result = edit.replaceInFile(resolveCwd(session_id), filePath, old_string, new_string, replace_all ?? false)
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `replace_in_file failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "insert_in_file",
    "Insert content before a 1-based line number in a file (relative to a session's working dir, or absolute). A line <= 0 or beyond the end of the file appends at the end. The inserted content occupies its own line(s). Returns the resolved path, the line it was inserted at, and bytes written. Use to add a block (import, function, config entry) without rewriting the whole file.",
    {
      session_id: z.string().optional().describe("Session whose working dir to resolve relative paths against (defaults to the first open session)"),
      path: z.string().describe("File path, relative to the working dir or absolute"),
      line: z.number().describe("1-based line number to insert before; <= 0 or past the end appends at the end"),
      content: z.string().describe("Content to insert (may contain newlines for multiple lines)"),
    },
    async ({ session_id, path: filePath, line, content }) => {
      try {
        const result = edit.insertInFile(resolveCwd(session_id), filePath, line, content)
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `insert_in_file failed: ${e.message}` }] }
      }
    },
  )

  // HTTP client — make a request and get a structured response (status, headers,
  // body) without spawning curl/Invoke-WebRequest in a terminal. Pairs with
  // open_external (browser) and run_command. Great for poking a localhost dev
  // server you just started or hitting a JSON API.
  server.tool(
    "http_request",
    "Make an HTTP(S) request and return a structured response: status, statusText, headers, content-type, body (capped at 1MB), bodyBytes, truncated flag, and durationMs. Only http/https URLs are allowed. Use this instead of curl/Invoke-WebRequest for portable, structured results — e.g. to check a localhost dev server you just started or hit a JSON API.",
    {
      url: z.string().describe("The full http:// or https:// URL to request"),
      method: z.string().optional().describe("HTTP method (default GET)"),
      headers: z.record(z.string()).optional().describe("Request headers as a key/value map"),
      body: z.string().optional().describe("Request body (for POST/PUT/PATCH)"),
      timeout_ms: z.number().optional().describe("Abort the request after this many ms (default 15000)"),
    },
    async ({ url, method, headers, body, timeout_ms }) => {
      try {
        const result = await http.request(url, {
          method,
          headers: headers as Record<string, string> | undefined,
          body,
          timeoutMs: timeout_ms,
        })
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `http_request failed: ${e.message}` }] }
      }
    },
  )

  server.tool(
    "download_file",
    "Download an http(s) URL straight to disk. The path resolves against a session's working dir (or absolute) and parent directories are created as needed. Only writes on a 2xx response, follows redirects, and enforces a 100MB cap (override with max_bytes). Returns the resolved path, bytesWritten, content-type, final URL, and durationMs. Use this for binary assets/release artifacts where http_request (inline body, 1MB cap) won't do.",
    {
      session_id: z.string().optional().describe("Session whose working dir to resolve a relative path against (defaults to the first open session)"),
      url: z.string().describe("The full http:// or https:// URL to download"),
      path: z.string().describe("Destination file path, relative to the working dir or absolute"),
      headers: z.record(z.string()).optional().describe("Request headers as a key/value map"),
      timeout_ms: z.number().optional().describe("Abort the download after this many ms (default 15000)"),
      max_bytes: z.number().optional().describe("Refuse (write nothing) if the body exceeds this many bytes (default 100MB)"),
    },
    async ({ session_id, url, path: destPath, headers, timeout_ms, max_bytes }) => {
      try {
        const result = await http.download(resolveCwd(session_id), url, destPath, {
          headers: headers as Record<string, string> | undefined,
          timeoutMs: timeout_ms,
          maxBytes: max_bytes,
        })
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `download_file failed: ${e.message}` }] }
      }
    },
  )

  // Port checks — answer "is something listening on this TCP port?" without
  // shelling out to lsof/netstat/Test-NetConnection. Companion to http_request:
  // start a dev server, wait_for_port until it comes up, then hit it.
  server.tool(
    "check_port",
    "Check whether a TCP port is open (something is listening) by attempting a single connection. Returns { host, port, open, durationMs }. Defaults to host 127.0.0.1. Use this instead of lsof/netstat to see if a dev server/database is up.",
    {
      port: z.number().describe("TCP port number to check"),
      host: z.string().optional().describe("Host to connect to (default 127.0.0.1)"),
      timeout_ms: z.number().optional().describe("Give up on the connection after this many ms (default 2000)"),
    },
    async ({ port, host, timeout_ms }) => {
      const result = await ports.check(port, host ?? "127.0.0.1", timeout_ms)
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.tool(
    "wait_for_port",
    "Poll a TCP port until something starts listening (port opens) or an overall timeout elapses. Returns { host, port, open, waitedMs, attempts }. Use after launching a dev server in a session to block until it's ready before calling http_request.",
    {
      port: z.number().describe("TCP port number to wait for"),
      host: z.string().optional().describe("Host to connect to (default 127.0.0.1)"),
      timeout_ms: z.number().optional().describe("Stop waiting after this many ms total (default 30000)"),
      interval_ms: z.number().optional().describe("Delay between connection attempts in ms (default 500)"),
    },
    async ({ port, host, timeout_ms, interval_ms }) => {
      const result = await ports.waitForOpen(port, host ?? "127.0.0.1", timeout_ms, interval_ms)
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  // Process-on-port — the follow-up to check_port/wait_for_port: when a port is
  // taken, find out *who* holds it and reclaim it (the classic "EADDRINUSE on
  // 3000, kill the zombie dev server" loop). Cross-platform, structured JSON.
  server.tool(
    "find_process_on_port",
    "Find the process(es) listening on a TCP port. Returns { port, platform, processes: [{ pid, name }] }. Use this to identify what's holding a port (e.g. after check_port reports it's taken) without parsing netstat/lsof yourself.",
    {
      port: z.number().describe("TCP port number to inspect"),
    },
    async ({ port }) => {
      const result = processes.findOnPort(port)
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.tool(
    "kill_process_on_port",
    "Kill whatever process is listening on a TCP port (the 'reclaim a stuck port' move). Returns { port, platform, found, killed: [{ pid, name }], failed: [{ pid, name, error }] }. Destructive — it force-kills the process; use find_process_on_port first if you want to see what would be killed.",
    {
      port: z.number().describe("TCP port number to free up"),
    },
    async ({ port }) => {
      const result = processes.killOnPort(port)
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.tool(
    "list_processes",
    "List running processes, optionally filtered by a case-insensitive name substring. Returns { platform, filter, processes: [{ pid, name }], truncated } (capped at 200). Use this to find a stray process (e.g. a leftover 'node' or 'esbuild') without parsing tasklist/ps output.",
    {
      name_filter: z.string().optional().describe("Only return processes whose name contains this substring (case-insensitive)"),
    },
    async ({ name_filter }) => {
      const result = processes.list(name_filter)
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.tool(
    "kill_process",
    "Force-kill a process by PID. Returns { pid, killed, error? }. Destructive — use list_processes or find_process_on_port first to confirm the PID.",
    {
      pid: z.number().describe("Process ID to kill"),
    },
    async ({ pid }) => {
      const result = processes.kill(pid)
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
    },
  )
}
