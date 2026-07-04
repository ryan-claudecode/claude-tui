import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { WorkspaceService, PublicWorkspace } from "../../services/workspaces"
import type { TerminalIdentity } from "./shared"
import type { SessionService } from "../../services/sessions"
import type { ContextInspectorService } from "../../services/contextInspector"
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
 * active selection, so neither needs a caller id. `inspect_workspace_context` DOES
 * use the caller's identity: it resolves the workspace from the caller's bound
 * work-session's `workspaceId` (`workSessions.get(identity.sessionId)?.workspaceId`)
 * and NEVER falls back to the global active selection (a cross-workspace read leak).
 * This is why `workSessions` + `identity` are threaded in.
 */
export function registerWorkspaceTools(
  server: McpServer,
  workspaces: WorkspaceService,
  // The caller's bound work session resolves the workspace for inspect_workspace_context.
  workSessions: SessionService,
  // CAPP-98 / I1 — the READ-ONLY Context Inspector backing `inspect_workspace_context`.
  contextInspector: ContextInspectorService,
  // The caller's identity (bound work-session id) — inspect_workspace_context defaults
  // its workspace to the caller's session's workspace.
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
    "Get the currently active ClaudeTUI workspace (the one sessions are scoped to by default), or null when no workspace is active (the 'All' bucket). Returns the public workspace projection.",
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
    "Set the active ClaudeTUI workspace by its registry id, or clear the selection (pass null to fall back to the 'All' bucket). SELECTION-ONLY: this marks the active workspace so sessions scope to it — it does NOT open editors or spawn sessions (use launch_workspace for that). Returns whether the selection was applied (false for an unknown id).",
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

  /** True iff `id` names a real registry workspace. */
  const isKnownWorkspace = (id: string): boolean => workspaces.list().some((w) => w.id === id)

  // ── Context Inspector (CAPP-98 / I1) ───────────────────────────────────────────
  // READ-ONLY introspection: enumerate the COMPLETE launch-time native context a fresh
  // `claude` eats for a workspace (managed policy, user/project memory, unconditioned
  // rules, parent-chain, native auto-memory), by precedence. INSPECT-ONLY — it only reads
  // files (existsSync/readFileSync); it NEVER edits a CLAUDE.md or inserts an @import.
  // @imports are listed LITERALLY, not expanded.
  server.tool(
    "inspect_workspace_context",
    "Inspect (READ-ONLY) the complete launch-time context a fresh Claude session eats in a workspace: every native source by precedence — managed policy, user-global memory + rules, parent-chain memory, project memory + rules, project-local override, Claude's native auto-memory. Absent tiers are shown as 'none' (the completeness claim depends on it); @imports are listed literally, not expanded; excluded ancestors are marked. Use this to see EXACTLY what context an agent reads at spawn before debugging surprising behavior. Omit workspace_id to inspect your own session's workspace (the untagged 'All' bucket — folderless — if your session isn't workspace-scoped). This NEVER writes any file.",
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
      // NEVER fall back to the global active selection (a cross-workspace read leak): the
      // inspector is identity-bound to the caller's own workspace.
      const wsId = workspace_id ?? workSessions.get(identity.sessionId ?? "")?.workspaceId ?? null
      return json(contextInspector.inspectWorkspaceContext(wsId))
    },
  )
}
