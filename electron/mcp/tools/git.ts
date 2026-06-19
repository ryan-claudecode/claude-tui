import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { TerminalService } from "../../services/terminals"
import type { GitService } from "../../services/git"
import { resolveCwd } from "./shared"

export function registerGitTools(
  server: McpServer,
  git: GitService,
  sessions: TerminalService,
) {
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
        const status = git.status(resolveCwd(sessions, session_id))
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
        const commits = git.log(resolveCwd(sessions, session_id), limit)
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
        const diff = git.diff(resolveCwd(sessions, session_id), file, staged)
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
        const detail = git.show(resolveCwd(sessions, session_id), ref)
        return { content: [{ type: "text" as const, text: JSON.stringify(detail, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `git show failed: ${e.message}` }] }
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
        const blame = git.blame(resolveCwd(sessions, session_id), file, start_line, end_line)
        return { content: [{ type: "text" as const, text: JSON.stringify(blame, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `git blame failed: ${e.message}` }] }
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
        const branches = git.branches(resolveCwd(sessions, session_id))
        return { content: [{ type: "text" as const, text: JSON.stringify(branches, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `git branches failed: ${e.message}` }] }
      }
    },
  )
}
