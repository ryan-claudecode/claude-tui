import { ipcMain } from "electron"
import type { LocalHistoryService } from "../services/localHistory"
import type { ShellService } from "../services/shell"

/**
 * CAPP-95 / D1 — local-history IPC handlers.
 *
 * Thin wrappers over `LocalHistoryService` (the local-git data-loss net for the
 * durable brain) plus a reveal that hands the history dir to the OS file manager
 * via the existing `ShellService` seam.
 *
 *   • `local-history:list`     → the snapshot log ({ hash, date, message }[]).
 *   • `local-history:restore`  → restore one curated file (or the whole subset)
 *                                from a snapshot into the LIVE store.
 *   • `local-history:snapshot` → take a snapshot NOW (manual "Save a snapshot").
 *   • `local-history:reveal`   → reveal `<rootDir>/.local-history` in Explorer/Finder.
 *
 * The snapshot/restore git work runs in the isolated `.local-history` repo ONLY —
 * never the project repo or any worktree (path-separation invariant).
 */
export function registerLocalHistoryHandlers(deps: {
  localHistoryService: LocalHistoryService
  shellService: ShellService
}) {
  const { localHistoryService, shellService } = deps

  ipcMain.handle("local-history:list", () => localHistoryService.listSnapshots())

  ipcMain.handle("local-history:restore", (_e, hash: string, relPath?: string) =>
    localHistoryService.restore(hash, relPath),
  )

  // Manual snapshot: returns the new commit hash, or null when nothing changed.
  ipcMain.handle("local-history:snapshot", (_e, reason?: string) =>
    localHistoryService.snapshot(reason ?? "manual snapshot"),
  )

  ipcMain.handle("local-history:reveal", () =>
    shellService.revealPath(localHistoryService.historyDir),
  )
}
