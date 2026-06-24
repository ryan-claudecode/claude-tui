/**
 * CAPP-99 / E1 — renderer-side type mirror for the export feature.
 *
 * The canonical `electron/services/export.ts` imports `node:fs`, so the renderer cannot import
 * its types directly (the same posture as `workspaceMemoryView.ts` / `contextInspectorView.ts`).
 * These shapes mirror the IPC payloads the export UI consumes. A compile-time parity pin
 * (`electron/services/exportViewSync.test.ts`) fails the build if these drift from the service.
 */

export type ExportMode = "A" | "C"

/** What the export UI renders — the registry entry projection + the derived @import line +
 *  the folderless / untagged advisories. Mirrors `ExportState` in `export.ts`. */
export interface ExportStateView {
  workspaceId: string | null
  mode: ExportMode | null
  path: string | null
  enabled: boolean
  importLine: string | null
  folderless: boolean
  modeANote?: string
  untaggedWarning?: string
}

/** The result of an enable attempt. Mirrors `EnableResult` in `export.ts`. */
export interface EnableResultView {
  ok: boolean
  error?: string
  state?: ExportStateView
}
