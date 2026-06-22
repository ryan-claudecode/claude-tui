import { describe, it, expect } from "vitest"
import type {
  WorkspaceFinding as ServiceFinding,
  WorkspaceMemoryRecord as ServiceRecord,
  FindingSource as ServiceFindingSource,
} from "./workspaceMemory"
import type {
  WorkspaceFinding as ViewFinding,
  WorkspaceMemoryRecord as ViewRecord,
  FindingSource as ViewFindingSource,
} from "../../src/lib/workspaceMemoryView"

/**
 * CAPP-94 / U6 — COMPILE-TIME PIN for the renderer-local workspace-memory mirror.
 *
 * `WorkspaceMemoryPanel` (companion window) reads `WorkspaceMemoryRecord`/`WorkspaceFinding`
 * via `src/lib/workspaceMemoryView.ts`, a hand-mirror of the canonical service types
 * (`electron/services/workspaceMemory.ts`). The renderer can't import the service module —
 * it pulls `node:fs` into the node-free renderer build — so the mirror is intentional. The
 * records cross the preload boundary untyped (`any`), so WITHOUT this pin a drift (a
 * renamed/added/narrowed field on either side) would compile clean and silently ship a
 * wrong-shaped record into the editor. This test lives in the electron project (which CAN
 * import both), and the bidirectional assignments fail `tsc -b` the moment the shapes
 * diverge. Type-only — no `node:fs` is dragged into the renderer bundle. Mirrors the U5
 * pin in `promoteEntrySync.test.ts`.
 */
describe("WorkspaceMemory view/service structural parity (CAPP-94)", () => {
  it("WorkspaceFinding + WorkspaceMemoryRecord are mutually assignable (any drift breaks the build)", () => {
    const finding: ViewFinding = {
      id: "f1",
      text: "x",
      createdAt: 0,
      source: "self",
      status: "active",
      promotedAt: 0,
    }
    const asServiceFinding: ServiceFinding = finding
    const asViewFinding: ViewFinding = asServiceFinding

    const record: ViewRecord = {
      workspaceId: "ws",
      instructions: "",
      findings: [finding],
      createdAt: 0,
      updatedAt: 0,
    }
    const asServiceRecord: ServiceRecord = record
    const asViewRecord: ViewRecord = asServiceRecord

    // FindingSource unions must match BOTH ways (catches a widened/narrowed service union).
    const vs: ViewFindingSource = "agent"
    const ss: ServiceFindingSource = vs
    const back: ViewFindingSource = ss

    expect(asViewFinding.text).toBe("x")
    expect(asViewRecord.findings).toHaveLength(1)
    expect(back).toBe("agent")
  })
})
