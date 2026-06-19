import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { WorkspaceService, PublicWorkspace } from "../../services/workspaces"
import type { TerminalIdentity } from "./shared"
import type { SessionService } from "../../services/sessions"
import { loadConfig } from "../../config"

/**
 * WS-E — the MCP surface for the durable workspace registry (WS-A/B).
 *
 * A workspace is a user-named, persisted grouping of one-or-more directories,
 * identified by a stable registry uuid. The registry is the SOURCE OF TRUTH;
 * these tools are thin 1:1 wrappers over {@link WorkspaceService} — they add NO
 * registry logic of their own.
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
 * CALLER IDENTITY: the explicit CRUD tools take an explicit `id` arg (the
 * registry is uuid-addressed). `get_active_workspace` reads the single global
 * active selection (one per app, not per-terminal), so it needs no caller id.
 * Where a future scope helper wants "the caller's workspace" it would default to
 * the caller's bound work-session's `workspaceId` — `workSessions` + `identity`
 * are threaded in for exactly that, mirroring how the work-session tools default
 * their ids; the current CRUD tools don't need it.
 */
export function registerWorkspaceTools(
  server: McpServer,
  workspaces: WorkspaceService,
  // Threaded for the caller-identity default (the caller's bound work session →
  // its `workspaceId`). The current CRUD tools take an explicit id, so these are
  // not consumed yet — they keep this module's signature ready for a scope helper
  // without another wiring change. Prefixed `_` to mark intentionally-unused.
  _workSessions: SessionService,
  _identity: TerminalIdentity = {},
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
    "List ClaudeTUI workspaces from the durable registry. A workspace is a user-named grouping of one-or-more directories (registry-owned, not just whatever was discovered on disk) — entries created by the user or seeded once from a workspace.json manifest.",
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
    "Create a new ClaudeTUI workspace — a user-named, persisted grouping of one-or-more directories. Returns the created workspace (public projection). This only adds a registry entry; it does NOT make it active or spawn anything (see set_active_workspace / launch_workspace).",
    {
      name: z.string().describe("Display name for the workspace, e.g. 'Frontend' or 'API + Web'"),
      dirs: z
        .array(z.string())
        .optional()
        .describe("Absolute directory paths to group under this workspace (default: none)"),
    },
    async ({ name, dirs }) => {
      const ws = workspaces.create(name, dirs ?? [])
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
    "add_workspace_dir",
    "Add a directory to a workspace's `dirs[]` by its registry id (no-op if already present). Returns the updated workspace (public projection), or an error if the id is unknown.",
    {
      id: z.string().describe("Workspace id from list_workspaces"),
      dir: z.string().describe("Absolute directory path to add"),
    },
    async ({ id, dir }) => {
      const ws = workspaces.addDir(id, dir)
      return ws ? json(publicById(ws.id)) : text(`Workspace not found: ${id}`)
    },
  )

  server.tool(
    "remove_workspace_dir",
    "Remove a directory from a workspace's `dirs[]` by its registry id (no-op if absent). Returns the updated workspace (public projection), or an error if the id is unknown.",
    {
      id: z.string().describe("Workspace id from list_workspaces"),
      dir: z.string().describe("Absolute directory path to remove"),
    },
    async ({ id, dir }) => {
      const ws = workspaces.removeDir(id, dir)
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
    "Boot a workspace by its registry id: open editors for its open_on_boot repos (imported workspaces) and spawn one Claude session per repo (or per directory for hand-created workspaces). This is the SPAWN verb and is distinct from set_active_workspace, which only marks the workspace active without opening anything. Returns the created sessions, or an error if the id is unknown.",
    {
      id: z.string().describe("Workspace id from list_workspaces"),
    },
    async ({ id }) => {
      const result = workspaces.launch(id)
      return result ? json(result) : text(`Workspace not found: ${id}`)
    },
  )
}
