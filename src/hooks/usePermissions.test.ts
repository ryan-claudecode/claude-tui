import { describe, it, expect } from "vitest"
import { pruneOrphanedRequests } from "./usePermissions"
import type { PermissionRequest } from "../../electron/services/streamProtocol"

// Pure logic test — no DOM/jsdom required. Locks in the BO-11 (CAPP-50) self-heal
// that clears a permission card belonging to a terminal that no longer exists (the
// stale-overlay-over-the-composer bug when a `permission:resolved` push is missed).
const req = (id: string, terminalId?: string): PermissionRequest => ({
  id,
  toolName: "Write",
  toolInput: {},
  terminalId,
})

describe("pruneOrphanedRequests (BO-11 orphan self-heal)", () => {
  it("drops requests whose terminal is no longer live", () => {
    const reqs = [req("a", "t1"), req("b", "t2"), req("c", "t3")]
    const live = new Set(["t1", "t3"])
    expect(pruneOrphanedRequests(reqs, live).map((r) => r.id)).toEqual(["a", "c"])
  })

  it("drops requests with no terminalId (un-attributable / un-renderable)", () => {
    expect(pruneOrphanedRequests([req("a", undefined)], new Set(["t1"]))).toEqual([])
  })

  it("returns the SAME array reference when nothing is orphaned (no needless re-render)", () => {
    const reqs = [req("a", "t1"), req("b", "t2")]
    const live = new Set(["t1", "t2"])
    expect(pruneOrphanedRequests(reqs, live)).toBe(reqs)
  })

  it("clears everything when the live set is empty (all terminals gone)", () => {
    const reqs = [req("a", "t1")]
    expect(pruneOrphanedRequests(reqs, new Set())).toEqual([])
  })
})
