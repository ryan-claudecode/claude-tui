import { describe, it, expect } from "vitest"
import { scheduleAction, type ScheduleActionEvent } from "./scheduleActions"

/**
 * CAPP-115 review — exhaustive coverage of the schedule panel's action-dispatch
 * machine, especially the two-step Delete confirm (a destructive flow where a
 * cross-panel state leak previously meant a WRONG-TARGET delete). The component
 * (`SchedulePanel.tsx`) is a thin shell over this machine, so these transitions ARE
 * the button semantics.
 */

const armed = { confirmArmed: true, enabled: true }
const disarmed = { confirmArmed: false, enabled: true }

describe("scheduleAction — the two-step delete state machine", () => {
  it("delete-press ARMS the confirm and fires NOTHING", () => {
    const out = scheduleAction(disarmed, { type: "delete-press" })
    expect(out).toEqual({ confirmArmed: true, call: null, closePanel: false })
  })

  it("delete-press while already armed stays armed and fires nothing (idempotent)", () => {
    const out = scheduleAction(armed, { type: "delete-press" })
    expect(out).toEqual({ confirmArmed: true, call: null, closePanel: false })
  })

  it("ARMED delete-confirm is the ONLY delete path — and it also closes the panel", () => {
    const out = scheduleAction(armed, { type: "delete-confirm" })
    expect(out.call).toEqual({ kind: "delete" })
    expect(out.closePanel).toBe(true) // MAJOR 2 — never a zombie panel after delete
    expect(out.confirmArmed).toBe(false)
  })

  it("UNARMED delete-confirm REFUSES (never deletes without an armed confirm)", () => {
    const out = scheduleAction(disarmed, { type: "delete-confirm" })
    expect(out).toEqual({ confirmArmed: false, call: null, closePanel: false })
  })

  it("delete-cancel disarms without firing anything", () => {
    const out = scheduleAction(armed, { type: "delete-cancel" })
    expect(out).toEqual({ confirmArmed: false, call: null, closePanel: false })
  })

  it("TWO-PANEL SWITCH (MAJOR 1): target change disarms, so the next confirm cannot delete", () => {
    // Arm the confirm on schedule A…
    const armedOnA = scheduleAction(disarmed, { type: "delete-press" })
    expect(armedOnA.confirmArmed).toBe(true)
    // …the instance is re-targeted at schedule B (the tab-switch leak scenario) —
    // the id-change transition MUST disarm and fire nothing.
    const afterSwitch = scheduleAction(
      { confirmArmed: armedOnA.confirmArmed, enabled: true },
      { type: "panel-target-changed" },
    )
    expect(afterSwitch).toEqual({ confirmArmed: false, call: null, closePanel: false })
    // A confirm click arriving after the switch (the one-click-deletes-B bug) refuses.
    const confirmOnB = scheduleAction(
      { confirmArmed: afterSwitch.confirmArmed, enabled: true },
      { type: "delete-confirm" },
    )
    expect(confirmOnB.call).toBeNull()
    expect(confirmOnB.closePanel).toBe(false)
  })
})

describe("scheduleAction — non-delete actions", () => {
  it("edit fires the edit callback and disarms a pending confirm", () => {
    const out = scheduleAction(armed, { type: "edit" })
    expect(out).toEqual({ confirmArmed: false, call: { kind: "edit" }, closePanel: false })
  })

  it("toggle-enabled targets the INVERSE of the current enabled flag", () => {
    expect(scheduleAction({ confirmArmed: false, enabled: true }, { type: "toggle-enabled" }).call)
      .toEqual({ kind: "setEnabled", enabled: false })
    expect(scheduleAction({ confirmArmed: false, enabled: false }, { type: "toggle-enabled" }).call)
      .toEqual({ kind: "setEnabled", enabled: true })
  })

  it("run-now fires runNow and disarms", () => {
    const out = scheduleAction(armed, { type: "run-now" })
    expect(out).toEqual({ confirmArmed: false, call: { kind: "runNow" }, closePanel: false })
  })

  it("NO event other than an armed delete-confirm ever produces a delete or a close", () => {
    const events: ScheduleActionEvent[] = [
      { type: "edit" },
      { type: "toggle-enabled" },
      { type: "run-now" },
      { type: "delete-press" },
      { type: "delete-cancel" },
      { type: "panel-target-changed" },
    ]
    for (const state of [armed, disarmed]) {
      for (const event of events) {
        const out = scheduleAction(state, event)
        expect(out.call?.kind).not.toBe("delete")
        expect(out.closePanel).toBe(false)
      }
    }
    // And the unarmed confirm (covered above) also never deletes — the full negative
    // space around the single legitimate delete transition.
    expect(scheduleAction(disarmed, { type: "delete-confirm" }).call).toBeNull()
  })
})
