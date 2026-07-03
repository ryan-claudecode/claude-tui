import { describe, it, expect } from "vitest"
import { refreshSchedulePanels, staleSchedulePanelIds } from "./schedulePanels"

/**
 * CAPP-115 review (MAJOR 2) — the pure halves of usePanels' schedule-panel sync:
 * refresh replaces an open panel's props with the fresh snapshot; stale detection
 * names the panels whose schedule was DELETED so the hook can hide them (a deleted
 * schedule must never leave a zombie panel).
 */

const panel = (id: string, type: string, scheduleId?: string) => ({
  id,
  type,
  props: scheduleId ? { id: scheduleId, name: `sched ${scheduleId}` } : {},
})

describe("refreshSchedulePanels", () => {
  it("replaces a matching schedule panel's props with the fresh snapshot", () => {
    const panels = [panel("panel-1", "schedule", "s1"), panel("panel-2", "mission", "m1")]
    const fresh = { id: "s1", name: "renamed", enabled: false }
    const out = refreshSchedulePanels(panels, [fresh])
    expect(out[0].props).toBe(fresh)
    // Non-schedule panels are untouched (same reference).
    expect(out[1]).toBe(panels[1])
  })

  it("leaves a schedule panel alone when its schedule isn't in the list", () => {
    const panels = [panel("panel-1", "schedule", "s1")]
    const out = refreshSchedulePanels(panels, [{ id: "s2" }])
    expect(out[0]).toBe(panels[0])
  })
})

describe("staleSchedulePanelIds", () => {
  it("names a schedule panel whose schedule no longer exists", () => {
    const panels = [panel("panel-1", "schedule", "s1"), panel("panel-2", "schedule", "s2")]
    expect(staleSchedulePanelIds(panels, [{ id: "s2" }])).toEqual(["panel-1"])
  })

  it("LAST-SCHEDULE-DELETED: an EMPTY schedules list stales every schedule panel", () => {
    // The early-return trap from review: deleting the final schedule yields an empty
    // list, which must still close its panel (the seeded gate lives in the hook).
    const panels = [panel("panel-1", "schedule", "s1")]
    expect(staleSchedulePanelIds(panels, [])).toEqual(["panel-1"])
  })

  it("ignores non-schedule panels and schedule panels without a props.id", () => {
    const panels = [
      panel("panel-1", "mission", "m1"), // wrong type
      panel("panel-2", "schedule"), // no props.id — never guess a destructive hide
      panel("panel-3", "markdown"),
    ]
    expect(staleSchedulePanelIds(panels, [])).toEqual([])
  })

  it("returns nothing when every open schedule panel still has its schedule", () => {
    const panels = [panel("panel-1", "schedule", "s1")]
    expect(staleSchedulePanelIds(panels, [{ id: "s1" }, { id: "s2" }])).toEqual([])
  })
})
