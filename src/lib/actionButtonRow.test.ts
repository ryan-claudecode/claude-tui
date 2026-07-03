import { describe, it, expect } from "vitest"
import {
  deriveVisibleButtons,
  resolveClick,
  UNTAGGED_OWNER_ID,
  type ActionButtonView,
} from "./actionButtonRow"

/**
 * CAPP-104 (AB-1) — pure rail view-model. Covers the visible-subset derivation
 * (session ∪ workspace, untagged mapping, no-session empty) and the two-step
 * inline-confirm state machine (keyed by id — an armed confirm never leaks across rows).
 */

const b = (over: Partial<ActionButtonView>): ActionButtonView => ({
  id: "b", label: "L", prompt: "p", scope: "session", ownerId: "s1", ...over,
})

describe("deriveVisibleButtons", () => {
  it("unions the active session's buttons then its workspace's buttons", () => {
    const all = [
      b({ id: "s-1", scope: "session", ownerId: "s1" }),
      b({ id: "s-other", scope: "session", ownerId: "s2" }),
      b({ id: "w-1", scope: "workspace", ownerId: "ws-A" }),
      b({ id: "w-other", scope: "workspace", ownerId: "ws-B" }),
    ]
    const out = deriveVisibleButtons(all, "s1", "ws-A")
    expect(out.map((x) => x.id)).toEqual(["s-1", "w-1"]) // session first, then workspace
  })

  it("maps an absent workspaceId to the untagged bucket", () => {
    const all = [
      b({ id: "w-untagged", scope: "workspace", ownerId: UNTAGGED_OWNER_ID }),
      b({ id: "w-real", scope: "workspace", ownerId: "ws-A" }),
    ]
    expect(deriveVisibleButtons(all, "s1", undefined).map((x) => x.id)).toEqual(["w-untagged"])
    expect(deriveVisibleButtons(all, "s1", null).map((x) => x.id)).toEqual(["w-untagged"])
  })

  it("returns empty when there's no active session (no dispatch target)", () => {
    const all = [b({ id: "s-1", scope: "session", ownerId: "s1" })]
    expect(deriveVisibleButtons(all, null, "ws-A")).toEqual([])
    expect(deriveVisibleButtons(all, undefined, "ws-A")).toEqual([])
  })
})

describe("resolveClick — two-step confirm state machine", () => {
  it("a non-confirm button dispatches immediately and clears any armed state", () => {
    expect(resolveClick({ id: "x" }, null)).toEqual({ armedId: null, dispatch: true })
    expect(resolveClick({ id: "x" }, "y")).toEqual({ armedId: null, dispatch: true })
  })

  it("a confirm button arms on first click, dispatches on second", () => {
    const first = resolveClick({ id: "danger", confirm: true }, null)
    expect(first).toEqual({ armedId: "danger", dispatch: false })
    const second = resolveClick({ id: "danger", confirm: true }, "danger")
    expect(second).toEqual({ armedId: null, dispatch: true })
  })

  it("arming a different confirm button re-arms it (no cross-row leak)", () => {
    // Button A is armed; clicking confirm button B arms B and does NOT dispatch A.
    const out = resolveClick({ id: "B", confirm: true }, "A")
    expect(out).toEqual({ armedId: "B", dispatch: false })
  })
})
