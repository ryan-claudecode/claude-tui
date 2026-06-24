import { ipcMain } from "electron"
import type { ExportService, ExportMode } from "../services/export"
import type { WorkspaceService } from "../services/workspaces"

/**
 * CAPP-99 / E1 — export IPC handlers (the EXPORT pillar of the CLAUDE.md coexistence layer).
 *
 * Thin wrappers over {@link ExportService}. A `null` workspaceId addresses the untagged
 * "All" bucket. The handlers are reachable from BOTH the main preload and the companion
 * preload (the export UI lives in the companion WorkspaceMemoryPanel) over the `export:*`
 * channels. `workspaceService` is injected only to resolve a friendly display name where a
 * caller wants one — the exporter owns all the file/registry logic.
 *
 * SAFETY: these handlers NEVER expose a read-back path (file → store). Every channel only
 * either reads the registry/derived state, or triggers a one-directional regen (store → file).
 */
export function registerExportHandlers(deps: {
  exportService: ExportService
  workspaceService: WorkspaceService
}) {
  const { exportService } = deps

  // Read the current export state (registry entry + derived @import line + warnings).
  ipcMain.handle("export:get-state", (_e, workspaceId: string | null) =>
    exportService.getExportState(workspaceId),
  )

  // Enable export. Mode A is gitignore-first (declining/failing → no export); Mode C takes
  // an optional custom path (defaults outside any repo). Returns { ok, error?, state? }.
  ipcMain.handle(
    "export:enable",
    (_e, workspaceId: string | null, mode: ExportMode, customPath?: string) =>
      exportService.enableExport(workspaceId, mode, customPath),
  )

  // Disable export (stops regen; never deletes the user's file).
  ipcMain.handle("export:disable", (_e, workspaceId: string | null) =>
    exportService.disableExport(workspaceId),
  )

  // Flip an untagged (default-OFF) export ON/OFF explicitly — the deliberate gesture past the
  // machine-wide warning.
  ipcMain.handle("export:set-untagged-enabled", (_e, enabled: boolean) =>
    exportService.setUntaggedEnabled(enabled),
  )

  // Force a regen now (e.g. a "Regenerate" button). Returns { ok, wrote?, error? }.
  ipcMain.handle("export:regenerate", (_e, workspaceId: string | null) =>
    exportService.regenerate(workspaceId),
  )
}
