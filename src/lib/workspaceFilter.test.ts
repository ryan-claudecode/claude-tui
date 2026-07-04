import { describe, it, expect } from "vitest"
import { filterByWorkspace, type WorkspaceScoped } from "./workspaceFilter"

// A representative mixed set: two items tagged to ws-a, one to ws-b, two
// untagged (legacy / "All"-only). Each carries an `id` so we can assert WHICH
// items survive, not just the count.
type Item = WorkspaceScoped & { id: string }
const items: Item[] = [
  { id: "a1", workspaceId: "ws-a" },
  { id: "b1", workspaceId: "ws-b" },
  { id: "a2", workspaceId: "ws-a" },
  { id: "legacy1" }, // no workspaceId
  { id: "legacy2", workspaceId: undefined }, // explicit undefined
]

const ids = (xs: Item[]) => xs.map((x) => x.id)

describe("filterByWorkspace — 'All' mode (null/undefined active id)", () => {
  it("shows EVERYTHING (tagged + untagged) when active id is null", () => {
    expect(ids(filterByWorkspace(items, null))).toEqual(["a1", "b1", "a2", "legacy1", "legacy2"])
  })

  it("shows EVERYTHING when active id is undefined", () => {
    expect(ids(filterByWorkspace(items, undefined))).toEqual(["a1", "b1", "a2", "legacy1", "legacy2"])
  })

  it("preserves input order and returns a NEW array (no mutation)", () => {
    const out = filterByWorkspace(items, null)
    expect(out).not.toBe(items) // a fresh array
    expect(out).toEqual(items) // same contents/order
    // mutating the result must not touch the input
    out.pop()
    expect(items).toHaveLength(5)
  })
})

describe("filterByWorkspace — a SPECIFIC workspace is active", () => {
  it("shows only items whose workspaceId equals the active id", () => {
    expect(ids(filterByWorkspace(items, "ws-a"))).toEqual(["a1", "a2"])
    expect(ids(filterByWorkspace(items, "ws-b"))).toEqual(["b1"])
  })

  it("HIDES untagged/legacy items under a specific workspace ('All'-only)", () => {
    const out = filterByWorkspace(items, "ws-a")
    expect(ids(out)).not.toContain("legacy1")
    expect(ids(out)).not.toContain("legacy2")
  })

  it("returns an empty list for a workspace with no items", () => {
    expect(filterByWorkspace(items, "ws-nonexistent")).toEqual([])
  })

  it("returns a new array (never mutates the input)", () => {
    const out = filterByWorkspace(items, "ws-a")
    expect(out).not.toBe(items)
    expect(items).toHaveLength(5)
  })
})

describe("filterByWorkspace — edge cases", () => {
  it("handles an empty input list in both modes", () => {
    expect(filterByWorkspace([], null)).toEqual([])
    expect(filterByWorkspace([], "ws-a")).toEqual([])
  })

  it("works for any workspaceId-shaped items (structural)", () => {
    const items = [
      { id: "m1", label: "x", workspaceId: "ws-a" },
      { id: "m2", label: "y" },
    ]
    expect(filterByWorkspace(items, "ws-a").map((m) => m.id)).toEqual(["m1"])
    expect(filterByWorkspace(items, null).map((m) => m.id)).toEqual(["m1", "m2"])
  })
})
