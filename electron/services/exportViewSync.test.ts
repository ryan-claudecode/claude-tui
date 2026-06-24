import { describe, it, expect } from "vitest"
import type { ExportState as ServiceState, EnableResult as ServiceEnable } from "./export"
import type { ExportStateView as ViewState, EnableResultView as ViewEnable } from "../../src/lib/exportView"

/**
 * CAPP-99 / E1 — COMPILE-TIME PIN for the renderer-local export type mirror.
 *
 * The export UI (the companion WorkspaceMemoryPanel) reads export state via
 * `src/lib/exportView.ts`, a hand-mirror of the canonical service contract
 * (`electron/services/export.ts`). The renderer can't import the service module (it pulls
 * `node:fs` into the node-free renderer build), so the mirror is intentional. The payload
 * crosses the preload boundary untyped, so without this pin a drift would compile clean and
 * silently ship a wrong-shaped result into the panel. Mirrors the workspaceMemoryViewSync /
 * contextInspectorViewSync pins. Type-only — no `node:fs` reaches the renderer bundle.
 */
describe("Export view/service structural parity (CAPP-99)", () => {
  it("ExportState + EnableResult round-trip service↔view (any drift breaks the build)", () => {
    const state: ServiceState = {
      workspaceId: "ws-1",
      mode: "A",
      path: "/x/.claude-tui/workspace-memory.md",
      enabled: true,
      importLine: "@./.claude-tui/workspace-memory.md",
      folderless: false,
      modeANote: undefined,
      untaggedWarning: undefined,
    }
    const asView: ViewState = state
    const back: ServiceState = asView
    expect(back.mode).toBe("A")

    const enable: ServiceEnable = { ok: true, state }
    const asViewEnable: ViewEnable = enable
    const backEnable: ServiceEnable = { ...asViewEnable, state: asViewEnable.state as ServiceState | undefined }
    expect(backEnable.ok).toBe(true)
  })
})
