import { describe, it, expect } from "vitest"
import type {
  ContextSource as ServiceSource,
  InspectResult as ServiceResult,
} from "./contextInspector"
import type {
  ContextSourceView as ViewSource,
  InspectResultView as ViewResult,
} from "../../src/lib/contextInspectorView"

/**
 * CAPP-98 / I1 — COMPILE-TIME PIN for the renderer-local Context Inspector mirror.
 *
 * `ContextInspectorPanel` (companion window) reads the inspection result via
 * `src/lib/contextInspectorView.ts`, a hand-mirror of the canonical service contract
 * (`electron/services/contextInspector.ts`). The renderer can't import the service module —
 * it pulls `node:fs`/`node:child_process` into the node-free renderer build — so the mirror
 * is intentional. The result crosses the preload boundary untyped (`any`), so WITHOUT this
 * pin a drift (a renamed/added/narrowed field on either side) would compile clean and
 * silently ship a wrong-shaped result into the panel. This test lives in the electron
 * project (which CAN import both); the bidirectional assignments fail `tsc -b` the moment
 * the shapes diverge. Type-only — no `node:fs` is dragged into the renderer bundle. Mirrors
 * the `workspaceMemoryViewSync.test.ts` pin.
 *
 * NOTE: the SERVICE `tier` is a literal-union `ContextTier`, the VIEW `tier` is a widened
 * `number`. Service→View is therefore the meaningful direction (a view that's MISSING a
 * field, or whose field is narrower than the service's, breaks here). We assert that
 * direction so a dropped/renamed field on the view side fails the build.
 */
describe("ContextInspector view/service structural parity (CAPP-98)", () => {
  it("ContextSource + InspectResult assign service→view (any drift breaks the build)", () => {
    const source: ServiceSource = {
      tier: 4,
      label: "Project memory",
      path: "/x/CLAUDE.md",
      exists: true,
      content: "body",
      imports: ["@./a.md"],
      excluded: false,
      truncatedNote: "note",
      resolved: undefined,
    }
    // Service → View: a view that dropped/renamed/narrowed a field fails to compile here.
    const asView: ViewSource = source
    // View → Service (sans the literal-union `tier`): the rest of the shape must round-trip.
    const back: ServiceSource = { ...asView, tier: asView.tier as ServiceSource["tier"] }

    const result: ServiceResult = {
      folder: "/x",
      gitRoot: "/x",
      adopted: false,
      sources: [source],
      effective: undefined,
    }
    const asViewResult: ViewResult = result
    const backResult: ServiceResult = {
      ...asViewResult,
      sources: asViewResult.sources.map((s) => ({ ...s, tier: s.tier as ServiceSource["tier"] })),
    }

    expect(asView.label).toBe("Project memory")
    expect(back.exists).toBe(true)
    expect(asViewResult.sources).toHaveLength(1)
    expect(backResult.adopted).toBe(false)
  })
})
