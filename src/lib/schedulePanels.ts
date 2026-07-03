/**
 * CAPP-115 review — pure view-model helpers for keeping open `schedule` detail panels
 * in sync with the live schedules list (node-testable, no React). usePanels calls
 * both off the `schedule:updated`/`removed`-driven list:
 *
 *  - `refreshSchedulePanels` — replace an open schedule panel's props with the fresh
 *    snapshot (matched on props.id — panels carry auto-generated panel-N ids).
 *  - `staleSchedulePanelIds` — panels whose schedule NO LONGER EXISTS (deleted). The
 *    caller hides these via the normal hidePanel path: a deleted schedule must never
 *    leave a zombie panel with stale data and dead buttons. Callers must only invoke
 *    this AFTER the schedules list has been seeded (an un-seeded empty list is
 *    indistinguishable from "everything deleted" — the safety gate lives in the hook).
 */

export interface SchedulePanelLike {
  id: string
  type: string
  props?: Record<string, any>
}

/** Replace each open schedule panel's props with its fresh schedule snapshot. */
export function refreshSchedulePanels<T extends SchedulePanelLike>(
  panels: T[],
  schedules: Array<{ id: string; [key: string]: any }>,
): T[] {
  return panels.map((p) => {
    if (p.type !== "schedule") return p
    const s = schedules.find((x) => x.id === (p.props as { id?: string })?.id)
    return s ? { ...p, props: s } : p
  })
}

/** Panel ids of open schedule panels whose schedule no longer exists. Panels without
 *  a props.id are left alone (nothing to match — never guess a destructive hide). */
export function staleSchedulePanelIds(
  panels: SchedulePanelLike[],
  schedules: Array<{ id: string }>,
): string[] {
  return panels
    .filter((p) => {
      if (p.type !== "schedule") return false
      const sid = (p.props as { id?: string })?.id
      if (!sid) return false
      return !schedules.some((x) => x.id === sid)
    })
    .map((p) => p.id)
}
