import { describe, it, expect } from "vitest"
import { UNTAGGED_STEM } from "./actionButtons"
import { UNTAGGED_OWNER_ID } from "../../src/lib/actionButtonRow"

/**
 * CAPP-104 (AB-1) — compile-time parity pin. The renderer's `actionButtonRow.ts`
 * cannot import the canonical `UNTAGGED_STEM` (it pulls in node:fs via workspaceMemory),
 * so it hardcodes `UNTAGGED_OWNER_ID`. This asserts the two stay identical — an untagged
 * workspace button's stored ownerId must match what the rail filters on, or its buttons
 * would silently never render. Fails the build on drift.
 */
describe("action-button untagged sentinel parity", () => {
  it("the renderer const equals the canonical stem", () => {
    expect(UNTAGGED_OWNER_ID).toBe(UNTAGGED_STEM)
  })
})
