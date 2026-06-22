import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { WorkspaceService, PublicWorkspace } from "../../services/workspaces"
import type { TerminalIdentity } from "./shared"
import type { SessionService } from "../../services/sessions"
import type { WorkspaceMemoryService } from "../../services/workspaceMemory"
import { loadConfig } from "../../config"

/**
 * WS-E — the MCP surface for the durable workspace registry (WS-A/B).
 *
 * A workspace (WS-H single-folder model) is a user-named, persisted spatial frame
 * backed by a SINGLE optional folder, identified by a stable registry uuid. The
 * registry is the SOURCE OF TRUTH; these tools are thin 1:1 wrappers over
 * {@link WorkspaceService} — they add NO registry logic of their own.
 *
 * NO-LEAK POSTURE (matches `workspace-handlers.ts`): every workspace-returning
 * tool returns the PUBLIC projection (`listPublic`/`getActivePublic`/`toPublic`
 * shape) — never the internal `Workspace` with its `seed*` boot/import fields.
 * Mutators re-project the affected id through `listPublic()` (keyed by id) via the
 * shared `publicById` helper, so a single source of truth owns the projection and
 * no `seed*` field ever crosses the MCP boundary.
 *
 * SELECTION vs LAUNCH (the WS-B split, surfaced here):
 *   • `set_active_workspace` — SELECTION-ONLY. Marks the active workspace; does
 *     NOT spawn editors or sessions.
 *   • `launch_workspace` — the explicit BOOT verb (spawns editors + sessions).
 *
 * WS-F — `rescan_workspaces` re-runs on-disk discovery against the configured scan
 * paths (discovery is no longer boot-only) and returns the updated PUBLIC list.
 * `getScanPaths` is injected (defaulting to `loadConfig().workspaceScanPaths`,
 * read FRESH so a config edit is honored) so a test can drive it against a temp
 * scan dir without touching the user's real config.
 *
 * CALLER IDENTITY: the registry CRUD tools take an explicit `id` arg (the
 * registry is uuid-addressed) and `get_active_workspace` reads the single global
 * active selection, so neither needs a caller id. The CAPP-87 / U3 workspace-memory
 * tools DO use the caller's identity: they resolve the destination workspace from
 * the caller's bound work-session's `workspaceId` (`workSessions.get(identity.
 * sessionId)?.workspaceId`) and NEVER fall back to the global active selection (that
 * would be a cross-workspace write leak). This is why `workSessions` + `identity`
 * are threaded in (no longer `_`-prefixed).
 */
export function registerWorkspaceTools(
  server: McpServer,
  workspaces: WorkspaceService,
  // The caller's bound work session resolves the destination workspace for the
  // CAPP-87 / U3 memory tools (a finding belongs to its OWNING session's workspace).
  workSessions: SessionService,
  // CAPP-87 / U3 — the durable, workspace-level knowledge tier the memory tools write.
  workspaceMemory: WorkspaceMemoryService,
  // The caller's identity (bound work-session id) — the memory tools default their
  // destination workspace to the caller's session's workspace.
  identity: TerminalIdentity = {},
  // WS-F — resolve the scan paths for `rescan_workspaces`. Defaults to the same
  // config field the boot discover() uses, re-read fresh each call. Injectable so
  // the tool test stays hermetic (it points discovery at a temp dir).
  getScanPaths: () => string[] = () => loadConfig().workspaceScanPaths,
) {
  // Re-project a single id through the public projection so a handler never has
  // to hand-build (and risk drifting from) the no-leak shape. Mirrors the same
  // helper in workspace-handlers.ts.
  const publicById = (id: string): PublicWorkspace | null =>
    workspaces.listPublic().find((w) => w.id === id) ?? null

  const json = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  })
  const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] })

  // ── Read ─────────────────────────────────────────────────────────────────────

  server.tool(
    "list_workspaces",
    "List ClaudeTUI workspaces from the durable registry. A workspace is a user-named, persisted spatial frame backed by a single optional folder (registry-owned, not just whatever was discovered on disk) — entries created by the user or seeded once from a workspace.json manifest.",
    {},
    async () => {
      // Public projection only — never leak the internal seed* boot fields.
      return json(workspaces.listPublic())
    },
  )

  server.tool(
    "get_active_workspace",
    "Get the currently active ClaudeTUI workspace (the one sessions/missions are scoped to by default), or null when no workspace is active (the 'All' bucket). Returns the public workspace projection.",
    {},
    async () => {
      return json(workspaces.getActivePublic())
    },
  )

  server.tool(
    "rescan_workspaces",
    "Re-scan the configured scan paths for workspace.json manifests and seed any newly-added ones into the durable registry, then return the updated list (public projection). Idempotent and non-destructive: it SEEDS new manifests, never duplicates an already-seeded workspace, and never reverts the user's renames/dir edits (the registry is the source of truth). Use this after creating a new workspace.json on disk so it shows up without restarting the app.",
    {},
    async () => {
      return json(workspaces.rescan(getScanPaths()))
    },
  )

  // ── Mutators (all return the PUBLIC projection of the affected workspace) ───────

  server.tool(
    "create_workspace",
    "Create a new ClaudeTUI workspace — a user-named, persisted spatial frame backed by a single optional folder. Returns the created workspace (public projection). This only adds a registry entry; it does NOT make it active or spawn anything (see set_active_workspace / launch_workspace).",
    {
      name: z.string().describe("Display name for the workspace, e.g. 'Frontend' or 'Billing service'"),
      dir: z
        .string()
        .optional()
        .describe("Absolute path to the workspace's single folder (default: none — set it later with set_workspace_dir)"),
    },
    async ({ name, dir }) => {
      const ws = workspaces.create(name, dir)
      return json(publicById(ws.id))
    },
  )

  server.tool(
    "rename_workspace",
    "Rename a workspace by its registry id. Returns the updated workspace (public projection), or an error if the id is unknown.",
    {
      id: z.string().describe("Workspace id from list_workspaces"),
      name: z.string().describe("New display name"),
    },
    async ({ id, name }) => {
      const ws = workspaces.rename(id, name)
      return ws ? json(publicById(ws.id)) : text(`Workspace not found: ${id}`)
    },
  )

  server.tool(
    "set_workspace_dir",
    "Set (or clear) a workspace's single folder by its registry id. A workspace is ONE directory: pass an absolute `dir` to set it (scaffolds a workspace.json there), or null to clear it. Returns the updated workspace (public projection), or an error if the id is unknown.",
    {
      id: z.string().describe("Workspace id from list_workspaces"),
      dir: z
        .string()
        .nullable()
        .describe("Absolute directory path to set as the workspace's folder, or null to clear it"),
    },
    async ({ id, dir }) => {
      const ws = workspaces.setDir(id, dir)
      return ws ? json(publicById(ws.id)) : text(`Workspace not found: ${id}`)
    },
  )

  server.tool(
    "delete_workspace",
    "Delete a workspace from the registry by its id. If it was the active workspace, the active selection is cleared. Returns whether a workspace was deleted.",
    {
      id: z.string().describe("Workspace id from list_workspaces"),
    },
    async ({ id }) => {
      const ok = workspaces.delete(id)
      return text(ok ? "Workspace deleted" : `Workspace not found: ${id}`)
    },
  )

  // ── Selection (SELECTION-ONLY — does NOT spawn; emits workspace:active-changed) ─

  server.tool(
    "set_active_workspace",
    "Set the active ClaudeTUI workspace by its registry id, or clear the selection (pass null to fall back to the 'All' bucket). SELECTION-ONLY: this marks the active workspace so sessions/missions scope to it — it does NOT open editors or spawn sessions (use launch_workspace for that). Returns whether the selection was applied (false for an unknown id).",
    {
      id: z
        .string()
        .nullable()
        .describe("Workspace id to make active, or null to clear (the 'All' bucket)"),
    },
    async ({ id }) => {
      const ok = workspaces.setActive(id)
      return text(ok ? (id ? `Active workspace set to ${id}` : "Active workspace cleared") : `Workspace not found: ${id}`)
    },
  )

  // ── Launch (the explicit BOOT verb — spawns editors + sessions, id-addressed) ───

  server.tool(
    "launch_workspace",
    "Boot a workspace by its registry id: open editors for its open_on_boot repos (imported workspaces) and spawn one Claude session per repo (or one in the workspace's folder for hand-created workspaces). This is the SPAWN verb and is distinct from set_active_workspace, which only marks the workspace active without opening anything. Returns the created sessions, or an error if the id is unknown.",
    {
      id: z.string().describe("Workspace id from list_workspaces"),
    },
    async ({ id }) => {
      const result = workspaces.launch(id)
      return result ? json(result) : text(`Workspace not found: ${id}`)
    },
  )

  // ── Workspace memory (CAPP-87 / U3) ────────────────────────────────────────────
  //
  // The durable, workspace-level knowledge tier. WORKSPACE RESOLUTION RULES (the
  // security blockers — NO `getActiveId()` fallback EVER):
  //   • add/set-context: destination = the caller's bound session's workspace ONLY
  //     (`workSessions.get(identity.sessionId)?.workspaceId`). `undefined` → the
  //     untagged bucket (null). An explicit `workspace_id` is validated against the
  //     registry and an UNKNOWN id is rejected.
  //   • promote_finding: destination = the OWNING session's workspace
  //     (`owner = session_id ?? identity.sessionId; workSessions.get(owner)?.
  //     workspaceId`). The note is resolved via `getPromotableFinding(owner, note_id)`
  //     and a not-found note is rejected. An explicit `workspace_id` that DIFFERS from
  //     the owner's workspace is rejected (no silent cross-workspace re-homing).
  //
  // `identity.sessionId` is the work-session container id (see server.ts identity
  // binding), so `workSessions.get()` resolves the caller's session directly.

  /** True iff `id` names a real registry workspace. */
  const isKnownWorkspace = (id: string): boolean => workspaces.list().some((w) => w.id === id)

  server.tool(
    "get_workspace_memory",
    "Read a workspace's durable memory — its standing instructions/context plus promoted + authored findings. This is the workspace-level knowledge tier that survives ALL session deletion (distinct from per-session findings, which live and die with a session). Omit workspace_id to read your own session's workspace (the untagged 'All' bucket if your session isn't workspace-scoped).",
    {
      workspace_id: z
        .string()
        .optional()
        .describe("Workspace id from list_workspaces (default: your bound session's workspace, or the untagged bucket)"),
    },
    async ({ workspace_id }) => {
      if (workspace_id !== undefined && !isKnownWorkspace(workspace_id)) {
        return text(`Workspace not found: ${workspace_id}`)
      }
      const wsId = workspace_id ?? workSessions.get(identity.sessionId ?? "")?.workspaceId ?? null
      return json(workspaceMemory.getMemory(wsId))
    },
  )

  server.tool(
    "add_workspace_memory",
    "Add a durable finding to a workspace's memory (the workspace-level knowledge tier that outlives any session). Use this to record something that should persist for the whole workspace — a project-wide convention, a gotcha, a decision. By default it lands in YOUR bound session's workspace (the untagged 'All' bucket if your session isn't workspace-scoped); pass workspace_id to target a specific workspace. The finding is recorded with source 'agent'.",
    {
      text: z.string().describe("The finding text to record"),
      workspace_id: z
        .string()
        .optional()
        .describe("Workspace id to write to (default: your bound session's workspace). Rejected if unknown."),
    },
    async ({ text: findingText, workspace_id }) => {
      if (workspace_id !== undefined && !isKnownWorkspace(workspace_id)) {
        return text(`Workspace not found: ${workspace_id}`)
      }
      // NEVER fall back to the global active selection — that would leak this write
      // into whatever workspace the user happens to have selected in the UI.
      const wsId = workspace_id ?? workSessions.get(identity.sessionId ?? "")?.workspaceId ?? null
      const finding = workspaceMemory.addFinding(wsId, findingText, "agent")
      return json(finding)
    },
  )

  server.tool(
    "set_workspace_memory_context",
    "Set a workspace's durable standing context/instructions — the workspace-tier analogue of a session summary, persisted with the workspace so every future session inherits it. REPLACES the existing context (it's a single text field, not a list). By default it targets YOUR bound session's workspace (the untagged 'All' bucket if your session isn't workspace-scoped); pass workspace_id to target a specific workspace.",
    {
      context: z.string().describe("The standing context/instructions text (replaces the current value)"),
      workspace_id: z
        .string()
        .optional()
        .describe("Workspace id to write to (default: your bound session's workspace). Rejected if unknown."),
    },
    async ({ context, workspace_id }) => {
      if (workspace_id !== undefined && !isKnownWorkspace(workspace_id)) {
        return text(`Workspace not found: ${workspace_id}`)
      }
      const wsId = workspace_id ?? workSessions.get(identity.sessionId ?? "")?.workspaceId ?? null
      const record = workspaceMemory.setInstructions(wsId, context)
      return json(record)
    },
  )

  server.tool(
    "promote_finding",
    "Promote a session finding (a session_note) UP to its OWNING session's workspace memory, so the knowledge outlives the session. The note is resolved by note_id within the owning session (your own session by default, or session_id if given), and lands in THAT session's workspace — NOT the global active selection and NOT your own workspace if you're a different session's caller. Returns the promoted workspace finding(s). Errors if the note isn't found, or if an explicit workspace_id differs from the owning session's workspace (cross-workspace re-homing is rejected).",
    {
      note_id: z.string().describe("The session note id to promote (from session findings / get_session_context)"),
      session_id: z
        .string()
        .optional()
        .describe("The OWNING session id (default: your bound session)"),
      workspace_id: z
        .string()
        .optional()
        .describe("Optional assertion of the destination workspace; rejected if it differs from the owning session's workspace"),
    },
    async ({ note_id, session_id, workspace_id }) => {
      const owner = session_id ?? identity.sessionId
      if (!owner) return text("No owning session: pass session_id (no bound caller identity).")

      const entry = workSessions.getPromotableFinding(owner, note_id)
      if (!entry) return text(`Finding not found: note ${note_id} in session ${owner}`)

      const ownerWorkspaceId = workSessions.get(owner)?.workspaceId ?? null
      // Reject a silent cross-workspace re-home: an explicit workspace_id MUST match
      // the owning session's workspace (an untagged owner has workspaceId === null/
      // undefined, which only an OMITTED workspace_id satisfies).
      if (workspace_id !== undefined && workspace_id !== (ownerWorkspaceId ?? undefined)) {
        return text(
          `Refusing cross-workspace promote: note ${note_id} belongs to workspace ${ownerWorkspaceId ?? "(untagged)"}, not ${workspace_id}`,
        )
      }
      const promoted = workspaceMemory.promoteFindings(ownerWorkspaceId, [entry])
      return json(promoted)
    },
  )
}
