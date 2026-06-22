import { describe, it, expect } from "vitest"
import type {
  PromoteEntry as ServicePromoteEntry,
  FindingSource as ServiceFindingSource,
} from "./workspaceMemory"
import type {
  PromoteEntry as RendererPromoteEntry,
  FindingSource as RendererFindingSource,
} from "../../src/lib/killSessionPromote"

/**
 * CAPP-93 / U5 — COMPILE-TIME PIN for the renderer↔service PromoteEntry mirror.
 *
 * The delete-time Keep flow builds `PromoteEntry[]` in the renderer (via
 * `src/lib/killSessionPromote.ts`, a hand-mirror) and ships it over the preload boundary
 * (typed `any[]`) to the service's `promoteFindings` (`electron/services/workspaceMemory.ts`).
 * The renderer can't import the canonical service type — that module pulls `node:fs` into
 * the node-free renderer build — so the mirror is intentional. WITHOUT this pin, a drift
 * (a renamed/added/narrowed field on either side) would compile clean and silently send a
 * wrong-shaped entry across the `any[]` wire, quietly losing or mis-handling kept findings.
 *
 * This test lives in the electron project (which CAN import both types), and the
 * bidirectional assignments below fail `tsc -b` the moment the shapes diverge. It is a
 * type-only pin — no `node:fs` is dragged into the renderer bundle.
 */
describe("PromoteEntry renderer/service structural parity (CAPP-93)", () => {
  it("the two PromoteEntry shapes are mutually assignable (any drift breaks the build)", () => {
    // A renderer entry must satisfy the service type (catches a NEW REQUIRED service field)...
    const fromRenderer: RendererPromoteEntry = { text: "x" }
    const asService: ServicePromoteEntry = fromRenderer
    // ...and a service entry must satisfy the renderer type (catches a field the mirror lost).
    const asRenderer: RendererPromoteEntry = asService

    // FindingSource unions must match BOTH ways (catches a widened/narrowed service union,
    // e.g. a future `source: "tool"`).
    const rs: RendererFindingSource = "self"
    const ss: ServiceFindingSource = rs
    const back: RendererFindingSource = ss

    expect(asRenderer.text).toBe("x")
    expect(back).toBe("self")
  })
})
