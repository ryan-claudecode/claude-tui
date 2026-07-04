import { describe, it, expect } from "vitest"
import { syncWindowSchedulePanels, type SyncPanelLike, type SchedulePanelBridge } from "./schedulePanelSync"

/**
 * CAPP-115 review (MINOR 4 / MAJOR 2) — the service/ipc seam that keeps POPPED-OUT
 * (`surface:"window"`) schedule panels live, driven with a FAKE PanelService bridge:
 * `updated` routes panelService.update to the matching window panel; `removed` routes
 * panelService.hide (no zombie panel in the companion). Modal-surface panels are the
 * renderer mirror's job — untouched here.
 */

interface Calls {
  updated: Array<{ panelId: string; props: Record<string, any> }>
  hidden: string[]
}

function fakeBridge(): SchedulePanelBridge & { calls: Calls } {
  const calls: Calls = { updated: [], hidden: [] }
  return {
    calls,
    update: (panelId, props) => calls.updated.push({ panelId, props }),
    hide: (panelId) => calls.hidden.push(panelId),
  }
}

const p = (id: string, type: string, surface: string, scheduleId?: string): SyncPanelLike => ({
  id,
  type,
  surface,
  props: scheduleId ? { id: scheduleId } : {},
})

describe("syncWindowSchedulePanels", () => {
  it("updated → panelService.update on the MATCHING window-surface schedule panel only", () => {
    const bridge = fakeBridge()
    const schedule = { id: "s1", name: "Fable watch", enabled: true }
    syncWindowSchedulePanels(
      { type: "updated", schedule },
      [
        p("panel-1", "schedule", "window", "s1"), // the popped-out target
        p("panel-2", "schedule", "window", "s2"), // different schedule
        p("panel-3", "schedule", "modal", "s1"), // modal — the renderer mirror's job
        p("panel-4", "markdown", "window", "s1"), // wrong type
      ],
      bridge,
    )
    expect(bridge.calls.updated).toEqual([{ panelId: "panel-1", props: schedule }])
    expect(bridge.calls.hidden).toEqual([])
  })

  it("removed → panelService.hide on the matching window-surface panel (no zombie)", () => {
    const bridge = fakeBridge()
    syncWindowSchedulePanels(
      { type: "removed", id: "s1" },
      [
        p("panel-1", "schedule", "window", "s1"),
        p("panel-2", "schedule", "window", "s2"),
        p("panel-3", "schedule", "modal", "s1"),
      ],
      bridge,
    )
    expect(bridge.calls.hidden).toEqual(["panel-1"])
    expect(bridge.calls.updated).toEqual([])
  })

  it("a window schedule panel WITHOUT a props.id is left alone (never guess)", () => {
    const bridge = fakeBridge()
    syncWindowSchedulePanels(
      { type: "removed", id: "s1" },
      [p("panel-1", "schedule", "window")],
      bridge,
    )
    expect(bridge.calls.hidden).toEqual([])
  })

  it("no window schedule panels → a no-op for both event kinds", () => {
    const bridge = fakeBridge()
    const panels = [p("panel-1", "markdown", "modal"), p("panel-2", "schedule", "modal", "s1")]
    syncWindowSchedulePanels({ type: "updated", schedule: { id: "s1" } }, panels, bridge)
    syncWindowSchedulePanels({ type: "removed", id: "s1" }, panels, bridge)
    expect(bridge.calls.updated).toEqual([])
    expect(bridge.calls.hidden).toEqual([])
  })
})
