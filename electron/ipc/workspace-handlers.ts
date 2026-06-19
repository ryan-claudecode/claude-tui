import { ipcMain } from "electron"
import type { WorkspaceService } from "../services/workspaces"

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
 * `rename`/`addDir`/`removeDir`/`get`) re-project through `listPublic()` (keyed by
 * id) so a single source of truth owns the projection.
 *
 * SELECTION vs LAUNCH (the WS-B split):
 *   • `workspace:set-active` — SELECTION-ONLY. Marks the active workspace,
 *     persists, and emits `workspace:active-changed` (wired in ipc.ts). Does NOT
 *     spawn editors/sessions.
 *   • `workspace:launch` — the explicit BOOT verb (spawns editors + sessions).
 *   The old `workspace:activate(index)` remains the legacy index-based launch.
 */
export function registerWorkspaceHandlers(deps: { workspaceService: WorkspaceService }) {
  const { workspaceService } = deps

  // Re-project a single id through the public projection so a handler never has
  // to hand-build (and risk drifting from) the no-leak shape.
  const publicById = (id: string) => workspaceService.listPublic().find((w) => w.id === id) ?? null

  // ── Reads ───────────────────────────────────────────────────────────────────
  ipcMain.handle("workspace:get", (_e, id: string) => publicById(id))
  ipcMain.handle("workspace:get-active", () => workspaceService.getActivePublic())

  // ── Mutators (all return the PUBLIC projection of the affected workspace) ─────
  ipcMain.handle("workspace:create", (_e, name: string, dirs?: string[]) => {
    const ws = workspaceService.create(name, dirs ?? [])
    return publicById(ws.id)
  })
  ipcMain.handle("workspace:rename", (_e, id: string, name: string) => {
    const ws = workspaceService.rename(id, name)
    return ws ? publicById(ws.id) : null
  })
  ipcMain.handle("workspace:add-dir", (_e, id: string, dir: string) => {
    const ws = workspaceService.addDir(id, dir)
    return ws ? publicById(ws.id) : null
  })
  ipcMain.handle("workspace:remove-dir", (_e, id: string, dir: string) => {
    const ws = workspaceService.removeDir(id, dir)
    return ws ? publicById(ws.id) : null
  })
  ipcMain.handle("workspace:delete", (_e, id: string) => workspaceService.delete(id))

  // ── Selection (SELECTION-ONLY — no spawn; emits workspace:active-changed) ─────
  ipcMain.handle("workspace:set-active", (_e, id: string | null) => workspaceService.setActive(id))

  // ── Launch (the explicit BOOT verb — spawns editors + sessions, id-addressed) ─
  ipcMain.handle("workspace:launch", (_e, id: string) => workspaceService.launch(id))
}
