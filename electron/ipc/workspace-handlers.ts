import { ipcMain, dialog, BrowserWindow } from "electron"
import type { WorkspaceService } from "../services/workspaces"
import type { WorkspaceMemoryService, PromoteEntry } from "../services/workspaceMemory"

/**
 * WS-B — id-based workspace IPC handlers.
 *
 * These complement (do NOT replace) the legacy `workspace:list` /
 * `workspace:activate(index)` handlers in `app-handlers.ts`, which stay wired for
 * the renderer's current `onSelectWorkspace(index)` path (the id-based renderer
 * cutover is WS-D). Everything here is uuid-addressed — the registry's real
 * identity scheme.
 *
 * NO-LEAK POSTURE: every handler that returns a workspace returns the PUBLIC
 * projection (`toPublic` shape via `listPublic`/`getActivePublic`), never the
 * internal `Workspace` with its `seed*` boot/import fields. Mutators (`create`/
 * `rename`/`setDir`/`get`) re-project through `listPublic()` (keyed by id) so a
 * single source of truth owns the projection.
 *
 * WS-H — single-folder model: `workspace:set-dir(id, dir|null)` replaces the old
 * `workspace:add-dir`/`workspace:remove-dir` pair; `workspace:create` takes an
 * optional single `dir` (not a `dirs[]` array).
 *
 * SELECTION vs LAUNCH (the WS-B split):
 *   • `workspace:set-active` — SELECTION-ONLY. Marks the active workspace,
 *     persists, and emits `workspace:active-changed` (wired in ipc.ts). Does NOT
 *     spawn editors/sessions.
 *   • `workspace:launch` — the explicit BOOT verb (spawns editors + sessions).
 *   The old `workspace:activate(index)` remains the legacy index-based launch.
 *
 * WS-F — `workspace:rescan` re-runs discovery against the configured scan paths on
 * demand (the switcher's ⟳ refresh + the `rescan_workspaces` MCP tool), returning
 * the updated PUBLIC list. `getScanPaths` is INJECTED (callback-set, like the
 * `getActiveWorkspaceId` getters in ipc.ts) so the handler resolves the SAME scan
 * paths the boot call uses (`config.workspaceScanPaths`) without this module
 * hard-depending on `loadConfig` — which keeps the handler test hermetic (the test
 * passes its own resolver instead of touching the user's real config).
 */
export function registerWorkspaceHandlers(deps: {
  workspaceService: WorkspaceService
  workspaceMemoryService: WorkspaceMemoryService
  getScanPaths: () => string[]
}) {
  const { workspaceService, workspaceMemoryService, getScanPaths } = deps

  // Re-project a single id through the public projection so a handler never has
  // to hand-build (and risk drifting from) the no-leak shape.
  const publicById = (id: string) => workspaceService.listPublic().find((w) => w.id === id) ?? null

  // ── Reads ───────────────────────────────────────────────────────────────────
  ipcMain.handle("workspace:get", (_e, id: string) => publicById(id))
  ipcMain.handle("workspace:get-active", () => workspaceService.getActivePublic())

  // ── Mutators (all return the PUBLIC projection of the affected workspace) ─────
  ipcMain.handle("workspace:create", (_e, name: string, dir?: string) => {
    const ws = workspaceService.create(name, dir)
    return publicById(ws.id)
  })
  ipcMain.handle("workspace:rename", (_e, id: string, name: string) => {
    const ws = workspaceService.rename(id, name)
    return ws ? publicById(ws.id) : null
  })
  // WS-H — set (or clear, with null) the workspace's single folder. Replaces the
  // old add-dir/remove-dir pair.
  ipcMain.handle("workspace:set-dir", (_e, id: string, dir: string | null) => {
    const ws = workspaceService.setDir(id, dir)
    return ws ? publicById(ws.id) : null
  })
  ipcMain.handle("workspace:delete", (_e, id: string) => workspaceService.delete(id))

  // ── Selection (SELECTION-ONLY — no spawn; emits workspace:active-changed) ─────
  ipcMain.handle("workspace:set-active", (_e, id: string | null) => workspaceService.setActive(id))

  // ── Launch (the explicit BOOT verb — spawns editors + sessions, id-addressed) ─
  ipcMain.handle("workspace:launch", (_e, id: string) => workspaceService.launch(id))

  // ── Re-scan (WS-F — user-triggerable discovery refresh) ──────────────────────
  // Resolve the scan paths from config (mirrors the boot call in ipc.ts) → re-run
  // the seed-once discovery → return the updated PUBLIC list. Idempotent: seeds new
  // manifests, never duplicates a seeded workspace, never reverts user edits.
  ipcMain.handle("workspace:rescan", () => workspaceService.rescan(getScanPaths()))

  // ── Workspace memory (CAPP-87 / U3) ──────────────────────────────────────────
  // Thin wrappers over WorkspaceMemoryService — the durable, workspace-level
  // knowledge tier. A `null` workspaceId addresses the untagged "All" bucket. Every
  // mutator fires the service's `onMemoryChanged` seam (wired in ipc.ts to invalidate
  // recall + push `workspace:memory-changed` to the renderer).
  ipcMain.handle("workspace:get-memory", (_e, workspaceId: string | null) =>
    workspaceMemoryService.getMemory(workspaceId),
  )
  ipcMain.handle("workspace:set-instructions", (_e, workspaceId: string | null, text: string) =>
    workspaceMemoryService.setInstructions(workspaceId, text),
  )
  ipcMain.handle(
    "workspace:add-finding",
    (_e, workspaceId: string | null, text: string, source: "user" | "agent") =>
      workspaceMemoryService.addFinding(workspaceId, text, source),
  )
  ipcMain.handle(
    "workspace:edit-finding",
    (_e, workspaceId: string | null, findingId: string, text: string) =>
      workspaceMemoryService.editFinding(workspaceId, findingId, text),
  )
  ipcMain.handle(
    "workspace:delete-finding",
    (_e, workspaceId: string | null, findingId: string) =>
      workspaceMemoryService.deleteFinding(workspaceId, findingId),
  )
  ipcMain.handle(
    "workspace:promote-findings",
    (_e, workspaceId: string | null, entries: PromoteEntry[]) =>
      workspaceMemoryService.promoteFindings(workspaceId, entries),
  )

  // ── Native folder picker (WS-D/H) ────────────────────────────────────────────
  // The create-workspace modal's "Choose folder" and the selected-workspace
  // dir-row both open the OS folder dialog. WS-H: a workspace is ONE folder, so the
  // picker is SINGLE-select (no `multiSelections`). It still resolves to a string[]
  // (0 or 1 entries) for API continuity; callers take the first. Returns [] on
  // cancel (showOpenDialog yields `canceled: true` + an empty `filePaths`), so the
  // renderer treats cancel as a no-op. Parented to the focused BrowserWindow so it
  // presents as a modal sheet rather than a detached dialog; falls back to a
  // window-less dialog if none.
  ipcMain.handle("dialog:open-directory", async (e): Promise<string[]> => {
    const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const result = parent
      ? await dialog.showOpenDialog(parent, {
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        })
    return result.canceled ? [] : result.filePaths
  })
}
