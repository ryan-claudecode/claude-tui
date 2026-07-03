import { describe, it, expect } from "vitest"
import {
  deriveVisibleButtons,
  resolveClick,
  buttonsKeyOf,
  shouldDisarm,
  UNTAGGED_OWNER_ID,
  type ActionButtonView,
} from "./actionButtonRow"

/**
 * CAPP-104 (AB-1) — pure rail view-model. Covers the visible-subset derivation
 * (session ∪ workspace, untagged mapping, no-session empty), the two-step
 * inline-confirm state machine (keyed by id — an armed confirm never leaks across rows),
 * and the armed-RESET decision (`shouldDisarm` — the component's effect is a thin shell
 * over it, so this is where the reset mechanism is exhaustively pinned).
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

describe("shouldDisarm — the armed-reset decision (exhaustive)", () => {
  // The list halves, expressed through buttonsKeyOf so the test pins the SAME
  // signature the component feeds in.
  const keyAB = buttonsKeyOf([b({ id: "A" }), b({ id: "B", confirm: true })])
  const keyA = buttonsKeyOf([b({ id: "A" })])
  const keyAC = buttonsKeyOf([b({ id: "A" }), b({ id: "C" })])

  it("armed → visible list changed (button added/replaced) DISARMS", () => {
    expect(shouldDisarm(keyAB, keyAC, "s1", "s1")).toBe(true)
  })

  it("armed → the armed button was REMOVED from the list DISARMS", () => {
    // keyAB → keyA: button B (the armed one) is gone.
    expect(shouldDisarm(keyAB, keyA, "s1", "s1")).toBe(true)
  })

  it("armed → ACTIVE-SESSION switch DISARMS even with an IDENTICAL list", () => {
    // The workspace-button retarget hazard: two sessions in one workspace share the
    // exact same visible list, so the list half alone would let the armed confirm
    // survive the switch and fire at the new session.
    expect(shouldDisarm(keyAB, keyAB, "s1", "s2")).toBe(true)
  })

  it("armed → same list AND same session STAYS ARMED", () => {
    expect(shouldDisarm(keyAB, keyAB, "s1", "s1")).toBe(false)
  })

  it("armed → session cleared (s1 → none) DISARMS", () => {
    expect(shouldDisarm(keyAB, keyAB, "s1", null)).toBe(true)
    expect(shouldDisarm(keyAB, keyAB, "s1", undefined)).toBe(true)
  })

  it("null ↔ undefined session flicker is NOT a switch (normalized)", () => {
    expect(shouldDisarm(keyAB, keyAB, null, undefined)).toBe(false)
    expect(shouldDisarm(keyAB, keyAB, undefined, null)).toBe(false)
  })

  it("both halves changed at once DISARMS (no cancellation)", () => {
    expect(shouldDisarm(keyAB, keyA, "s1", "s2")).toBe(true)
  })
})
