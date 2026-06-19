import { describe, it, expect } from "vitest"
import {
  attentionWorkspaceId,
  filterAttentionByWorkspace,
  type ScopedSession,
  type ScopedMission,
  type ScopedAttention,
} from "./workspaceScope"

const sessions: ScopedSession[] = [
  { id: "s-a", workspaceId: "ws-a" },
  { id: "s-b", workspaceId: "ws-b" },
  { id: "s-untagged" }, // no workspaceId → "All"-only
]

const missions: ScopedMission[] = [
  { id: "m-a", workspaceId: "ws-a" },
  { id: "m-b", workspaceId: "ws-b" },
  { id: "m-untagged" },
]

describe("attentionWorkspaceId — resolving an entry's owner workspace", () => {
  it("resolves a mission entry from its mission's workspaceId", () => {
    const e: ScopedAttention = { sessionId: "ignored", missionId: "m-a", tier: 2 }
    expect(attentionWorkspaceId(e, sessions, missions)).toBe("ws-a")
  })

  it("resolves a terminal entry from its owning session's workspaceId", () => {
    const e: ScopedAttention = { sessionId: "s-b", tier: 2 }
    expect(attentionWorkspaceId(e, sessions, missions)).toBe("ws-b")
  })

  it("prefers the mission owner over the session when both are present", () => {
    // A review/mission entry can carry a sessionId AND a missionId; the mission
    // owns the scope.
    const e: ScopedAttention = { sessionId: "s-b", missionId: "m-a", tier: 2 }
    expect(attentionWorkspaceId(e, sessions, missions)).toBe("ws-a")
  })

  it("returns undefined for an untagged owner ('All'-only)", () => {
    expect(attentionWorkspaceId({ sessionId: "s-untagged", tier: 2 }, sessions, missions)).toBeUndefined()
    expect(
      attentionWorkspaceId({ sessionId: "x", missionId: "m-untagged", tier: 2 }, sessions, missions),
    ).toBeUndefined()
  })

  it("returns undefined for an unresolvable owner (no such session/mission)", () => {
    expect(attentionWorkspaceId({ sessionId: "nope", tier: 2 }, sessions, missions)).toBeUndefined()
    expect(
      attentionWorkspaceId({ sessionId: "x", missionId: "nope", tier: 2 }, sessions, missions),
    ).toBeUndefined()
  })
})

describe("filterAttentionByWorkspace", () => {
  // A mixed set of TIER-2 entries (the normal-filtering tier) so the bucket
  // policy is exercised without the tier-1 exemption muddying it.
  const entries: ScopedAttention[] = [
    { sessionId: "s-a", tier: 2 }, // → ws-a
    { sessionId: "s-b", tier: 2 }, // → ws-b
    { sessionId: "x", missionId: "m-a", tier: 2 }, // → ws-a (mission)
    { sessionId: "s-untagged", tier: 2 }, // → undefined (All-only)
    { sessionId: "nope", tier: 2 }, // → undefined (unresolvable)
  ]

  it("'All' mode (null) shows EVERYTHING, order preserved, new array", () => {
    const out = filterAttentionByWorkspace(entries, null, sessions, missions)
    expect(out).toEqual(entries)
    expect(out).not.toBe(entries)
  })

  it("'All' mode (undefined) shows everything too", () => {
    expect(filterAttentionByWorkspace(entries, undefined, sessions, missions)).toEqual(entries)
  })

  it("a specific workspace shows only entries resolving to it (incl. mission-owned)", () => {
    const out = filterAttentionByWorkspace(entries, "ws-a", sessions, missions)
    expect(out).toEqual([
      { sessionId: "s-a", tier: 2 },
      { sessionId: "x", missionId: "m-a", tier: 2 },
    ])
  })

  it("HIDES untagged + unresolvable tier-2/3 entries under a specific workspace", () => {
    const out = filterAttentionByWorkspace(entries, "ws-b", sessions, missions)
    expect(out).toEqual([{ sessionId: "s-b", tier: 2 }])
  })

  it("filters tier-3 entries by workspace just like tier-2", () => {
    const t3: ScopedAttention[] = [
      { sessionId: "s-a", tier: 3 }, // ws-a → hidden under ws-b
      { sessionId: "s-b", tier: 3 }, // ws-b → kept under ws-b
    ]
    expect(filterAttentionByWorkspace(t3, "ws-b", sessions, missions)).toEqual([
      { sessionId: "s-b", tier: 3 },
    ])
  })

  it("returns empty when nothing tier-2/3 resolves to the active workspace", () => {
    expect(filterAttentionByWorkspace(entries, "ws-none", sessions, missions)).toEqual([])
  })

  it("handles an empty entry list in both modes", () => {
    expect(filterAttentionByWorkspace([], null, sessions, missions)).toEqual([])
    expect(filterAttentionByWorkspace([], "ws-a", sessions, missions)).toEqual([])
  })
})

// The MAJOR 2 contract: a tier-1 entry is a HARD BLOCKER (a show_form checkpoint
// or worktree-review gate) and must NEVER be hidden by the workspace filter —
// otherwise a cross-workspace worktree-review (no toast/notif, owning mission row
// also hidden) silently strands the user on something they must approve/reject.
describe("filterAttentionByWorkspace — tier-1 exemption (MAJOR 2)", () => {
  it("ALWAYS includes a tier-1 entry owned by workspace A while workspace B is active", () => {
    const entries: ScopedAttention[] = [
      { sessionId: "s-a", missionId: "m-a", tier: 1 }, // tier-1 worktree-review, ws-a
      { sessionId: "s-b", tier: 2 }, // tier-2, ws-b
    ]
    // Active = ws-b: the cross-workspace tier-1 blocker survives; the ws-b tier-2 also survives.
    expect(filterAttentionByWorkspace(entries, "ws-b", sessions, missions)).toEqual([
      { sessionId: "s-a", missionId: "m-a", tier: 1 },
      { sessionId: "s-b", tier: 2 },
    ])
  })

  it("hides a cross-workspace tier-2/3 but keeps the cross-workspace tier-1 (same active ws)", () => {
    const entries: ScopedAttention[] = [
      { sessionId: "s-a", tier: 1 }, // tier-1 ws-a → kept (blocker)
      { sessionId: "s-a", tier: 2 }, // tier-2 ws-a → hidden under ws-b
      { sessionId: "s-a", tier: 3 }, // tier-3 ws-a → hidden under ws-b
    ]
    expect(filterAttentionByWorkspace(entries, "ws-b", sessions, missions)).toEqual([
      { sessionId: "s-a", tier: 1 },
    ])
  })

  it("includes a tier-1 entry with an untagged/unresolvable owner (blocker, never hidden)", () => {
    const entries: ScopedAttention[] = [
      { sessionId: "s-untagged", tier: 1 },
      { sessionId: "nope", tier: 1 },
    ]
    expect(filterAttentionByWorkspace(entries, "ws-a", sessions, missions)).toEqual(entries)
  })

  it("preserves input order across the tier-1 exemption + tier-2/3 filter", () => {
    const entries: ScopedAttention[] = [
      { sessionId: "s-b", tier: 2 }, // hidden under ws-a
      { sessionId: "s-b", tier: 1 }, // tier-1 cross-workspace → kept, KEEPS its position
      { sessionId: "s-a", tier: 2 }, // kept under ws-a
    ]
    expect(filterAttentionByWorkspace(entries, "ws-a", sessions, missions)).toEqual([
      { sessionId: "s-b", tier: 1 },
      { sessionId: "s-a", tier: 2 },
    ])
  })

  it("'All' mode still shows tier-1 (no special-casing needed)", () => {
    const entries: ScopedAttention[] = [{ sessionId: "s-a", tier: 1 }]
    expect(filterAttentionByWorkspace(entries, null, sessions, missions)).toEqual(entries)
  })
})
