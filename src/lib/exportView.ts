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

/** CAPP-100 / E2 — the adoption probe the Export section reads (fresh marker scan + host-file
 *  + whether our managed block can be auto-inserted). Mirrors the `adoption:get-state` payload. */
export interface AdoptionStateView {
  /** True iff this workspace's exported primer is `@import`ed in a host CLAUDE-family file. */
  adopted: boolean
  /** The `<F>/CLAUDE.local.md` host file the wire/unwire would edit, or null (folderless). */
  hostFile: string | null
  /** True when auto-wire is possible (Mode A + a resolvable folder). */
  canWire: boolean
  /** The explicit Mode-C "I wired it myself" hint. */
  selfWired: boolean
  /** The @import line (for the manual-paste / wire path). */
  importLine: string | null
}

/** CAPP-100 / E2 — the result of a Wire/Unwire attempt. Mirrors `WireResult` in `adoption.ts`. */
export interface WireResultView {
  ok: boolean
  status: "wired" | "already" | "removed" | "absent" | "refused" | "error"
  error?: string
  path?: string
}
