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
  { id: "m-untagged" },
]

describe("attentionWorkspaceId — resolving an entry's owner workspace", () => {
  it("resolves a mission entry from its mission's workspaceId", () => {
    const e: ScopedAttention = { sessionId: "ignored", missionId: "m-a" }
    expect(attentionWorkspaceId(e, sessions, missions)).toBe("ws-a")
  })

  it("resolves a terminal entry from its owning session's workspaceId", () => {
    const e: ScopedAttention = { sessionId: "s-b" }
    expect(attentionWorkspaceId(e, sessions, missions)).toBe("ws-b")
  })

  it("prefers the mission owner over the session when both are present", () => {
    // A review/mission entry can carry a sessionId AND a missionId; the mission
    // owns the scope.
    const e: ScopedAttention = { sessionId: "s-b", missionId: "m-a" }
    expect(attentionWorkspaceId(e, sessions, missions)).toBe("ws-a")
  })

  it("returns undefined for an untagged owner ('All'-only)", () => {
    expect(attentionWorkspaceId({ sessionId: "s-untagged" }, sessions, missions)).toBeUndefined()
    expect(
      attentionWorkspaceId({ sessionId: "x", missionId: "m-untagged" }, sessions, missions),
    ).toBeUndefined()
  })

  it("returns undefined for an unresolvable owner (no such session/mission)", () => {
    expect(attentionWorkspaceId({ sessionId: "nope" }, sessions, missions)).toBeUndefined()
    expect(
      attentionWorkspaceId({ sessionId: "x", missionId: "nope" }, sessions, missions),
    ).toBeUndefined()
  })
})

describe("filterAttentionByWorkspace", () => {
  const entries: ScopedAttention[] = [
    { sessionId: "s-a" }, // → ws-a
    { sessionId: "s-b" }, // → ws-b
    { sessionId: "x", missionId: "m-a" }, // → ws-a (mission)
    { sessionId: "s-untagged" }, // → undefined (All-only)
    { sessionId: "nope" }, // → undefined (unresolvable)
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
    expect(out).toEqual([{ sessionId: "s-a" }, { sessionId: "x", missionId: "m-a" }])
  })

  it("HIDES untagged + unresolvable entries under a specific workspace", () => {
    const out = filterAttentionByWorkspace(entries, "ws-b", sessions, missions)
    expect(out).toEqual([{ sessionId: "s-b" }])
  })

  it("returns empty when nothing resolves to the active workspace", () => {
    expect(filterAttentionByWorkspace(entries, "ws-none", sessions, missions)).toEqual([])
  })

  it("handles an empty entry list in both modes", () => {
    expect(filterAttentionByWorkspace([], null, sessions, missions)).toEqual([])
    expect(filterAttentionByWorkspace([], "ws-a", sessions, missions)).toEqual([])
  })
})
