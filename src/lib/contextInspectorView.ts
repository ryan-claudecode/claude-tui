/**
 * CAPP-98 / I1 — the RENDERER-SIDE MIRROR of the Context Inspector contract.
 *
 * The companion `ContextInspectorPanel` reads the inspection result that crosses the
 * preload boundary (untyped `any`). The canonical types live in
 * `electron/services/contextInspector.ts`, which pulls in `node:fs`/`node:child_process` —
 * so it CANNOT be imported into the node-free renderer build. This module is the
 * type-only mirror the renderer reads instead.
 *
 * A COMPILE-TIME PARITY PIN (`electron/services/contextInspectorViewSync.test.ts`) asserts
 * these are mutually assignable with the canonical service types, so any drift (a
 * renamed/added/narrowed field on either side) fails `tsc -b` instead of silently shipping
 * a wrong-shaped result into the panel.
 */

/** Mirror of `ContextSource` (electron/services/contextInspector.ts). */
export interface ContextSourceView {
  tier: number
  label: string
  path: string
  exists: boolean
  content: string
  imports: string[]
  excluded?: boolean
  truncatedNote?: string
  resolved?: string
}

/** Mirror of `InspectResult` (electron/services/contextInspector.ts). */
export interface InspectResultView {
  folder: string | null
  gitRoot: string | null
  sources: ContextSourceView[]
  effective?: string
}
