/**
 * CAPP-115 review (MINOR 4 / MAJOR 2) — keep POPPED-OUT (`surface:"window"`) schedule
 * detail panels in sync with scheduler mutations, SERVICE-side. After a pop-out the
 * panel leaves the main-window mirror, so usePanels' renderer live-refresh stops
 * driving it and the companion has no `schedule:updated` listener of its own — the
 * same ownership split the CAPP-110 M4 mission block solved. So on each scheduler
 * event, any tracked window-surface `schedule` panel matching the schedule id (on
 * props.id — panels carry auto-generated panel-N ids) is:
 *
 *  - `updated` → `bridge.update(panelId, schedule)` (PanelService.update routes
 *    `panel:update` to the companion for window panels), and
 *  - `removed` → `bridge.hide(panelId)` (never a zombie panel over a dead schedule).
 *
 * Pure + dependency-injected (a structural PanelService subset) so it tests at the
 * seam with a fake bridge. The ipc.ts caller guards with `companionService.isOpen()`
 * exactly like the mission M4 block, so a background tick can never resurrect a
 * closed companion via update→route→sendToCompanion→getOrCreate.
 */

/** The panel fields the sync reads (a structural subset of PanelState). */
export interface SyncPanelLike {
  id: string
  type: string
  surface: string
  props?: Record<string, any>
}

/** The PanelService subset the sync drives (structurally satisfied by PanelService). */
export interface SchedulePanelBridge {
  update(panelId: string, props: Record<string, any>): unknown
  hide(panelId: string): unknown
}

export type ScheduleSyncEvent =
  | { type: "updated"; schedule: { id: string; [key: string]: any } }
  | { type: "removed"; id: string }

export function syncWindowSchedulePanels(
  event: ScheduleSyncEvent,
  panels: SyncPanelLike[],
  bridge: SchedulePanelBridge,
): void {
  for (const p of panels) {
    if (p.type !== "schedule" || p.surface !== "window") continue
    const scheduleId = (p.props as { id?: string } | undefined)?.id
    if (!scheduleId) continue
    if (event.type === "updated") {
      if (scheduleId === event.schedule.id) bridge.update(p.id, event.schedule)
    } else if (scheduleId === event.id) {
      bridge.hide(p.id)
    }
  }
}
