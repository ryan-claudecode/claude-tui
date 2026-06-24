import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { TerminalService } from "../../services/terminals"
import type { PanelService } from "../../services/panels"
import type { NotesService } from "../../services/notes"
import type { FileService } from "../../services/files"
import { resolveCwd, type TerminalIdentity } from "./shared"

export function registerPanelTools(
  server: McpServer,
  panels: PanelService,
  notes: NotesService,
  files: FileService,
  sessions: TerminalService,
  identity: TerminalIdentity = {},
) {
  // Rich panel tools

  server.tool(
    "show_panel",
    "Show a rich UI panel in ClaudeTUI (diff, image, markdown, table, test, chart, heatmap, tree, timeline, git, kanban, notes, stat, log, progress, or code). For interactive forms that return user input, use show_form instead. For chart: props = { kind: 'bar'|'line'|'pie', title?, unit?, data: [{ label, value, color? }] }. For tree: props = { data: <any JSON value>, title?, defaultExpandDepth? } — a collapsible JSON/data tree viewer. For timeline: props = { title?, steps: [{ label, status?: 'done'|'active'|'pending'|'error', detail?, meta? }] } — multi-step task progress. For git: props = the git_status result ({ branch, ahead, behind, clean, changes: [{ path, status, staged, label }] }) plus optional commits: [{ hash, author, date, subject }] from git_log — a staged/unstaged file overview. For kanban: props = { title?, columns: [{ title, color?, cards: [{ title, tag?, detail?, color? }] }] } — a board of grouped cards for status buckets or parallel workstreams. For notes: props = { title?, notes: [{ id, title, body, scope?, tags?, updatedAt? }] } — the cross-session scratchpad (prefer the show_notes tool, which loads saved notes for you). For stat: props = { title?, stats: [{ label, value, unit?, delta?, trend?: 'up'|'down'|'flat', color?, hint? }] } — a dashboard of big-number KPI cards (test counts, coverage %, build time, bundle size); distinct from chart, which is for series viz. For log: props = { title?, lines: [string | { text, level?: 'info'|'warn'|'error'|'debug'|'success', time? }], showLevel? } — a scrollable monospace log viewer with per-line severity coloring (command output, test streams, server logs). For progress: props = { title?, steps: [{ label, status?: 'pending'|'active'|'done'|'error'|'skipped', detail? }], percent? } — a vertical stepper with a progress bar for sequential task pipelines (distinct from timeline, which is chronological events). For code: props = { code: string, language?, filename?, startLine?, highlightLines?: number[], wrap? } — a read-only code excerpt with gutter line numbers and per-line highlighting (distinct from diff, which compares two versions). For heatmap: props = { title?, rows: number[][], xLabels?: string[], yLabels?: string[], unit?, min?, max? } — a color-coded 2D numeric matrix on a blue→green→amber→red ramp (correlation matrices, coverage grids, latency-by-hour); distinct from chart (series viz) and table (text grid). For mission: props = a Mission object (goal, status, autonomy, tasks[], workers[], eventLog[]) — renders a live orchestration dashboard. For worktree-review: props = { missionId, taskId, title, diff, reviewReason?, status? } — an isolated mission worker's captured diff with Approve & merge / Reject buttons (usually opened from the attention queue, not directly).",
    {
      type: z.enum(["diff", "image", "markdown", "table", "test", "chart", "tree", "timeline", "git", "kanban", "notes", "stat", "log", "progress", "code", "heatmap", "mission", "worktree-review", "recall", "workspace-memory", "context-inspector"]).describe("Panel type"),
      props: z.record(z.string(), z.any()).describe("Panel-specific data"),
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
        .record(z.string(), z.any())
        .describe(
          "Form definition: { title, fields: [{ name, type, label, options?, items? }], submitLabel? }",
        ),
      position: z.enum(["right", "bottom"]).optional().describe("Drawer position"),
    },
    async ({ props, position }) => {
      // Attribute the form to the caller's bound identity so the attention queue
      // can show which session/terminal is blocked waiting on this form.
      const data = await panels.showForm(props, position, {
        sessionId: identity.sessionId,
        terminalId: identity.terminalId,
      })
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] }
    },
  )

  server.tool(
    "update_panel",
    "Update an existing panel's content",
    {
      id: z.string().describe("Panel ID"),
      props: z.record(z.string(), z.any()).describe("Updated properties (merged into existing)"),
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
        const cwd = resolveCwd(sessions, session_id)

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
}
