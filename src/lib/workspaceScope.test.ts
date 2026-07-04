import { describe, it, expect } from "vitest"
import {
  attentionWorkspaceId,
  filterAttentionByWorkspace,
  type ScopedSession,
  type ScopedAttention,
} from "./workspaceScope"

const sessions: ScopedSession[] = [
  { id: "s-a", workspaceId: "ws-a" },
  { id: "s-b", workspaceId: "ws-b" },
  { id: "s-untagged" }, // no workspaceId → "All"-only
]

describe("attentionWorkspaceId — resolving an entry's owner workspace", () => {
  it("resolves a terminal entry from its owning session's workspaceId", () => {
    const e: ScopedAttention = { sessionId: "s-b", tier: 2 }
    expect(attentionWorkspaceId(e, sessions)).toBe("ws-b")
  })

  it("returns undefined for an untagged owner ('All'-only)", () => {
    expect(attentionWorkspaceId({ sessionId: "s-untagged", tier: 2 }, sessions)).toBeUndefined()
  })

  it("returns undefined for an unresolvable owner (no such session)", () => {
    expect(attentionWorkspaceId({ sessionId: "nope", tier: 2 }, sessions)).toBeUndefined()
  })
})

describe("filterAttentionByWorkspace", () => {
  // A mixed set of TIER-2 entries (the normal-filtering tier) so the bucket
  // policy is exercised without the tier-1 exemption muddying it.
  const entries: ScopedAttention[] = [
    { sessionId: "s-a", tier: 2 }, // → ws-a
    { sessionId: "s-b", tier: 2 }, // → ws-b
    { sessionId: "s-untagged", tier: 2 }, // → undefined (All-only)
    { sessionId: "nope", tier: 2 }, // → undefined (unresolvable)
  ]

  it("'All' mode (null) shows EVERYTHING, order preserved, new array", () => {
    const out = filterAttentionByWorkspace(entries, null, sessions)
    expect(out).toEqual(entries)
    expect(out).not.toBe(entries)
  })

  it("'All' mode (undefined) shows everything too", () => {
    expect(filterAttentionByWorkspace(entries, undefined, sessions)).toEqual(entries)
  })

  it("a specific workspace shows only entries resolving to it", () => {
    const out = filterAttentionByWorkspace(entries, "ws-a", sessions)
    expect(out).toEqual([{ sessionId: "s-a", tier: 2 }])
  })

  it("HIDES untagged + unresolvable tier-2/3 entries under a specific workspace", () => {
    const out = filterAttentionByWorkspace(entries, "ws-b", sessions)
    expect(out).toEqual([{ sessionId: "s-b", tier: 2 }])
  })

  it("filters tier-3 entries by workspace just like tier-2", () => {
    const t3: ScopedAttention[] = [
      { sessionId: "s-a", tier: 3 }, // ws-a → hidden under ws-b
      { sessionId: "s-b", tier: 3 }, // ws-b → kept under ws-b
    ]
    expect(filterAttentionByWorkspace(t3, "ws-b", sessions)).toEqual([
      { sessionId: "s-b", tier: 3 },
    ])
  })

  it("returns empty when nothing tier-2/3 resolves to the active workspace", () => {
    expect(filterAttentionByWorkspace(entries, "ws-none", sessions)).toEqual([])
  })

  it("handles an empty entry list in both modes", () => {
    expect(filterAttentionByWorkspace([], null, sessions)).toEqual([])
    expect(filterAttentionByWorkspace([], "ws-a", sessions)).toEqual([])
  })
})

// The MAJOR 2 contract: a tier-1 entry is a HARD BLOCKER (a show_form checkpoint)
// and must NEVER be hidden by the workspace filter — otherwise a cross-workspace
// blocker silently strands the user on something they must act on.
describe("filterAttentionByWorkspace — tier-1 exemption (MAJOR 2)", () => {
  it("ALWAYS includes a tier-1 entry owned by workspace A while workspace B is active", () => {
    const entries: ScopedAttention[] = [
      { sessionId: "s-a", tier: 1 }, // tier-1 blocker, ws-a
      { sessionId: "s-b", tier: 2 }, // tier-2, ws-b
    ]
    // Active = ws-b: the cross-workspace tier-1 blocker survives; the ws-b tier-2 also survives.
    expect(filterAttentionByWorkspace(entries, "ws-b", sessions)).toEqual([
      { sessionId: "s-a", tier: 1 },
      { sessionId: "s-b", tier: 2 },
    ])
  })

  it("hides a cross-workspace tier-2/3 but keeps the cross-workspace tier-1 (same active ws)", () => {
    const entries: ScopedAttention[] = [
      { sessionId: "s-a", tier: 1 }, // tier-1 ws-a → kept (blocker)
      { sessionId: "s-a", tier: 2 }, // tier-2 ws-a → hidden under ws-b
      { sessionId: "s-a", tier: 3 }, // tier-3 ws-a → hidden under ws-b
    ]
    expect(filterAttentionByWorkspace(entries, "ws-b", sessions)).toEqual([
      { sessionId: "s-a", tier: 1 },
    ])
  })

  it("includes a tier-1 entry with an untagged/unresolvable owner (blocker, never hidden)", () => {
    const entries: ScopedAttention[] = [
      { sessionId: "s-untagged", tier: 1 },
      { sessionId: "nope", tier: 1 },
    ]
    expect(filterAttentionByWorkspace(entries, "ws-a", sessions)).toEqual(entries)
  })

  it("preserves input order across the tier-1 exemption + tier-2/3 filter", () => {
    const entries: ScopedAttention[] = [
      { sessionId: "s-b", tier: 2 }, // hidden under ws-a
      { sessionId: "s-b", tier: 1 }, // tier-1 cross-workspace → kept, KEEPS its position
      { sessionId: "s-a", tier: 2 }, // kept under ws-a
    ]
    expect(filterAttentionByWorkspace(entries, "ws-a", sessions)).toEqual([
      { sessionId: "s-b", tier: 1 },
      { sessionId: "s-a", tier: 2 },
    ])
  })

  it("'All' mode still shows tier-1 (no special-casing needed)", () => {
    const entries: ScopedAttention[] = [{ sessionId: "s-a", tier: 1 }]
    expect(filterAttentionByWorkspace(entries, null, sessions)).toEqual(entries)
  })
})
