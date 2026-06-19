import { describe, it, expect } from "vitest"
import { reconcileSplit, type SplitTerminal } from "./useSplitView"

// Pure logic test — no DOM/jsdom required. Locks in the CAPP-42 fix: a respawn
// (Stop/interrupt, model-switch, handoff) mints a NEW terminal id, and the split
// slots must re-point to it instead of falling through to a blank pane.
const t = (id: string, cc?: string, lastState: string = "idle"): SplitTerminal => ({
  id,
  ccConversationId: cc,
  lastState,
})

describe("reconcileSplit (CAPP-42 split-pane id reconciliation)", () => {
  it("keeps healthy slots unchanged and refreshes their conversation id", () => {
    const terms = [t("L", "ccL"), t("R", "ccR")]
    const out = reconcileSplit({ left: "L", right: "R", leftCc: null, rightCc: null }, terms, "L")
    expect(out).toEqual({ left: "L", right: "R", leftCc: "ccL", rightCc: "ccR" })
  })

  it("re-points an in-place respawn (interrupt/model-switch) by conversation id", () => {
    // The old id "L" is GONE from the list (respawnHeadlessRef mutated the ref in
    // place); the replacement "L2" carries the SAME conversation id.
    const terms = [t("L2", "ccL"), t("R", "ccR")]
    const out = reconcileSplit({ left: "L", right: "R", leftCc: "ccL", rightCc: "ccR" }, terms, "L2")
    expect(out.left).toBe("L2")
    expect(out.right).toBe("R")
    expect(out.leftCc).toBe("ccL")
  })

  it("re-points by cc even when the active terminal is the OTHER pane", () => {
    // The respawn target isn't the active selection here — cc match must still win
    // so we never collapse both panes onto one terminal.
    const terms = [t("L2", "ccL"), t("R", "ccR")]
    const out = reconcileSplit({ left: "L", right: "R", leftCc: "ccL", rightCc: "ccR" }, terms, "R")
    expect(out.left).toBe("L2")
    expect(out.right).toBe("R")
  })

  it("re-points a handoff (old id dead-in-list, new fresh convo) via the active terminal", () => {
    // handoffTerminal marks the old ref dead and APPENDS a fresh terminal with a NEW
    // conversation id; it re-points activeTerminalId at the replacement.
    const terms = [t("L", "ccL", "dead"), t("R", "ccR"), t("L2", "ccNew")]
    const out = reconcileSplit({ left: "L", right: "R", leftCc: "ccL", rightCc: "ccR" }, terms, "L2")
    expect(out.left).toBe("L2")
    expect(out.right).toBe("R")
    expect(out.leftCc).toBe("ccNew")
  })

  it("re-points a respawn that has no conversation id yet via the active terminal", () => {
    // A terminal respawned before its first turn has no cc; the active-id fallback
    // still re-points the slot.
    const terms = [t("L2", undefined), t("R", "ccR")]
    const out = reconcileSplit({ left: "L", right: "R", leftCc: null, rightCc: "ccR" }, terms, "L2")
    expect(out.left).toBe("L2")
  })

  it("never collapses both slots onto the same terminal via the fallback", () => {
    // The active terminal is the surviving OTHER pane and there is no cc successor —
    // the broken slot must NOT adopt the other slot's terminal.
    const terms = [t("R", "ccR")] // "L" is gone; only the right pane survives
    const out = reconcileSplit({ left: "L", right: "R", leftCc: null, rightCc: "ccR" }, terms, "R")
    expect(out.left).toBe("L") // left over to its own (empty) state, not "R"
    expect(out.right).toBe("R")
  })

  it("leaves a slot whose terminal genuinely died (crash, no replacement) untouched", () => {
    const terms = [t("L", "ccL", "dead"), t("R", "ccR")]
    // The dead terminal is still the active one (no respawn happened), so no fallback.
    const out = reconcileSplit({ left: "L", right: "R", leftCc: "ccL", rightCc: "ccR" }, terms, "L")
    expect(out.left).toBe("L")
    expect(out.right).toBe("R")
  })

  it("is a no-op when the split is off (both slots null)", () => {
    const out = reconcileSplit({ left: null, right: null, leftCc: null, rightCc: null }, [], null)
    expect(out).toEqual({ left: null, right: null, leftCc: null, rightCc: null })
  })

  it("re-points the right slot too (symmetry)", () => {
    const terms = [t("L", "ccL"), t("R2", "ccR")]
    const out = reconcileSplit({ left: "L", right: "R", leftCc: "ccL", rightCc: "ccR" }, terms, "R2")
    expect(out.right).toBe("R2")
    expect(out.left).toBe("L")
  })

  it("CAPP-39 gate ③: re-points a slot after a per-terminal ENGINE switch (same cc, new id)", () => {
    // setTerminalEngine respawns the terminal under a NEW id while RESUMING the same
    // conversation (it preserves ccConversationId on the ref), exactly like the
    // model-switch/interrupt respawn — so the by-cc re-point carries the escape hatch
    // for free, whether the new terminal is structured or xterm.
    // activeTerminalId is the OTHER (right) pane, so the active-id fallback (path 3)
    // CANNOT explain the re-point — this strictly isolates the by-cc mechanism (path 2).
    const terms = [t("Lraw", "ccL"), t("R", "ccR")] // "L" structured → "Lraw" xterm, same cc
    const out = reconcileSplit({ left: "L", right: "R", leftCc: "ccL", rightCc: "ccR" }, terms, "R")
    expect(out.left).toBe("Lraw")
    expect(out.right).toBe("R")
    expect(out.leftCc).toBe("ccL")
  })
})
