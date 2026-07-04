import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { TerminalService } from "../../services/terminals"
import type { PanelService } from "../../services/panels"
import type { FileService } from "../../services/files"
import { resolveCwd, type TerminalIdentity } from "./shared"
// CAPP-107 (review MINOR 1) — the QuestionForm↔ask_user payload contract lives in ONE
// shared pure module (renderer-safe, no node imports) so the submit keys can never
// drift between the renderer's builder and this parser. See src/lib/questionSubmit.ts.
import { normalizeQuestionOptions, parseQuestionAnswer } from "../../../src/lib/questionSubmit"

export function registerPanelTools(
  server: McpServer,
  panels: PanelService,
  files: FileService,
  sessions: TerminalService,
  identity: TerminalIdentity = {},
) {
  // Rich panel tools

  server.tool(
    "show_panel",
    "Show a rich UI panel in ClaudeTUI (diff, image, markdown, table, git, or code). For interactive forms that return user input, use show_form instead. For git: props = the git_status result ({ branch, ahead, behind, clean, changes: [{ path, status, staged, label }] }) plus optional commits: [{ hash, author, date, subject }] from git_log — a staged/unstaged file overview. For code: props = { code: string, language?, filename?, startLine?, highlightLines?: number[], wrap? } — a read-only code excerpt with gutter line numbers and per-line highlighting (distinct from diff, which compares two versions). For table: props = { title?, columns: [...], rows: [...] } — a text grid. For markdown: props = { content }. For image: props = { src } (data URI or path).",
    {
      type: z.enum(["diff", "image", "markdown", "table", "git", "code", "context-inspector"]).describe("Panel type"),
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

  // CAPP-107 — ask_user: a first-class interactive question for in-app agents.
  // The native AskUserQuestion tool DOESN'T EXIST on the app's headless `claude -p`
  // stream-json transport, so an agent's interactive question would silently degrade
  // to prose. This tool rides the SAME pending-promise show_form machinery (BLOCKS
  // until answered → ModalHost → tier-1 attention) but composes a dedicated
  // `kind:"question"` form the FormPanel renders as a clean question card.
  server.tool(
    "ask_user",
    "Ask the user a question and BLOCK until they answer, then return their choice(s). Use this whenever you need a decision or clarification from the user mid-task — the native AskUserQuestion tool is NOT available in this environment. Renders a first-class question card in the app and raises the user's attention. Provide 2-8 `options` for click-to-select answers, set `multi_select` to allow several, and/or `allow_free_text` for an 'Other…' field (omit `options` entirely for a free-text-only question). Returns { answer, selected, free_text } — the selected option label(s) and any free text, verbatim — or { cancelled: true } if the user dismisses it.",
    {
      question: z.string().describe("The question to put to the user"),
      options: z
        .array(z.string())
        .min(2)
        .max(8)
        .optional()
        .describe(
          "2-8 predefined answer choices shown as click-to-select cards; omit for a free-text-only question",
        ),
      multi_select: z
        .boolean()
        .optional()
        .describe("Allow the user to pick more than one option (checkboxes)"),
      allow_free_text: z
        .boolean()
        .optional()
        .describe("Also offer an 'Other…' free-text field alongside the options"),
      context: z
        .string()
        .optional()
        .describe("One line on WHY you're asking, shown as a muted subline under the question"),
    },
    async ({ question, options, multi_select, allow_free_text, context }) => {
      // NIT 2 — de-duplicate the options (order-preserving). Fewer than 2 unique
      // choices is not a real choice: fall back to the no-options shape (free
      // text implied on), same as omitting `options` entirely.
      const uniqueOptions = normalizeQuestionOptions(options)
      const hasOptions = uniqueOptions !== undefined
      const props = {
        kind: "question",
        question,
        context,
        options: uniqueOptions,
        multiSelect: !!multi_select,
        allowFreeText: !!allow_free_text || !hasOptions,
      }
      // Same blocking pending-promise contract as show_form; attributed to the
      // caller's bound identity so the tier-1 attention entry names who's blocked.
      const data = await panels.showForm(props, undefined, {
        sessionId: identity.sessionId,
        terminalId: identity.terminalId,
      })
      // MINOR 1 — parse through the SHARED contract module (the same one whose
      // buildQuestionSubmit the QuestionForm submits with): returns the selected
      // label(s) + free text verbatim, or { cancelled: true }.
      return {
        content: [{ type: "text" as const, text: JSON.stringify(parseQuestionAnswer(data)) }],
      }
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
