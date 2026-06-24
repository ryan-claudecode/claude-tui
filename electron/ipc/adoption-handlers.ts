import { ipcMain } from "electron"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ExportService } from "../services/export"
import type { WorkspaceService } from "../services/workspaces"
import { wireImport, unwireImport, detectAdoption } from "../services/adoption"

/**
 * CAPP-100 / E2 — adoption IPC handlers (the reversible CLAUDE.local.md insert + the read-only
 * adoption probe).
 *
 * HARD INVARIANT: the "Wire it in for me" / "Unwire" write paths are a SINGLE user-initiated
 * MAIN-WINDOW action and are **NOT MCP-exposed** — no agent can trigger them, so there are no
 * concurrent-agent races on the user's CLAUDE.local.md. They append/remove ONLY our delimited
 * block (`<F>/CLAUDE.local.md`), with a change-guard + a pristine-block Unwire refusal.
 *
 * These live on the MAIN preload only (the export UI's Export section). The export READ/regen
 * channels stay in export-handlers.ts; this module owns the native-file WRITE + the adoption read.
 */
export function registerAdoptionHandlers(deps: {
  exportService: ExportService
  workspaceService: WorkspaceService
}) {
  const { exportService, workspaceService } = deps

  /** The `<F>/CLAUDE.local.md` host file for a workspace, or null when folderless. */
  function hostFileFor(workspaceId: string | null): string | null {
    if (workspaceId == null) return null
    const folder = workspaceService.resolveWorkspaceDir(workspaceId)
    if (!folder) return null
    return join(folder, "CLAUDE.local.md")
  }

  // Read-only: is this workspace's export ADOPTED right now? (A fresh marker scan over the host
  // CLAUDE-family files.) Plus the host file path + whether our managed block is present, so the
  // UI can show Wire vs Unwire. NEVER throws.
  ipcMain.handle("adoption:get-state", (_e, workspaceId: string | null) => {
    const adopted = detectAdoption(workspaceId, {
      resolveFolder: (id) => workspaceService.resolveWorkspaceDir(id),
      selfWiredHint: (id) => exportService.isSelfWired(id),
      importLine: (id) => exportService.getExportState(id).importLine,
    })
    const hostFile = hostFileFor(workspaceId)
    const state = exportService.getExportState(workspaceId)
    return {
      adopted,
      hostFile,
      // Only Mode A (in-folder) supports the auto-insert (the @import is a relative path into
      // the project's own .claude-tui). Mode C / folderless → the user wires it manually + can
      // flip the self-wired hint.
      canWire: state.mode === "A" && hostFile != null,
      selfWired: exportService.isSelfWired(workspaceId),
      importLine: state.importLine,
    }
  })

  // "Wire it in for me" — append OUR delimited @import block to <F>/CLAUDE.local.md. Captures the
  // file pre-image HERE (read-modify-rename) so the change-guard can abort on a concurrent edit
  // between this read and the write. Idempotent, EOL-preserving, CRLF-agnostic.
  ipcMain.handle("adoption:wire", (_e, workspaceId: string | null) => {
    const hostFile = hostFileFor(workspaceId)
    if (!hostFile) {
      return { ok: false, status: "error", error: "This workspace has no folder — nothing to wire." }
    }
    const state = exportService.getExportState(workspaceId)
    if (state.mode !== "A" || !state.importLine) {
      return {
        ok: false,
        status: "error",
        error: "Auto-wire is only available for an in-folder (Mode A) export. Paste the @import line yourself.",
      }
    }
    // Capture the pre-image now so wireImport's change-guard is exact for this read-modify-rename.
    let preImage: string | null = null
    try {
      if (existsSync(hostFile)) preImage = readFileSync(hostFile, "utf8")
    } catch {
      preImage = null // unreadable → wireImport will surface the real failure on write
    }
    return wireImport({ hostFile, importLine: state.importLine, expectedPreImage: preImage })
  })

  // "Unwire" — remove OUR exact pristine block; REFUSE when the user edited inside our delimiters.
  ipcMain.handle("adoption:unwire", (_e, workspaceId: string | null) => {
    const hostFile = hostFileFor(workspaceId)
    if (!hostFile) {
      return { ok: false, status: "error", error: "This workspace has no folder — nothing to unwire." }
    }
    const state = exportService.getExportState(workspaceId)
    const importLine = state.importLine ?? `@./.claude-tui/workspace-memory.md`
    return unwireImport({ hostFile, importLine })
  })

  // The explicit, reversible Mode-C "I've wired this myself" hint (the only non-scan adoption
  // signal). Returns the updated export state.
  ipcMain.handle("adoption:set-self-wired", (_e, workspaceId: string | null, selfWired: boolean) =>
    exportService.setSelfWired(workspaceId, selfWired),
  )
}
