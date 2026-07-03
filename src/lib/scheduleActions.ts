/**
 * CAPP-115 review — the schedule detail panel's action-dispatch decisions as a PURE
 * state machine, so the two-step Delete confirm (a destructive, wrong-target-prone
 * flow) is exhaustively node-testable without jsdom/RTL (the repo's testing posture).
 * `SchedulePanel.tsx` is a thin shell over this: every button maps to one event, and
 * the component applies the outcome (set the armed flag, fire the named callback,
 * close the panel).
 *
 * Safety invariants encoded here (and pinned by scheduleActions.test.ts):
 *  - `delete` fires ONLY from an ARMED `delete-confirm` — never from any other event,
 *    and never when disarmed (the wrong-target-delete guard).
 *  - `panel-target-changed` (the panel instance now shows a DIFFERENT schedule id —
 *    the cross-panel leak scenario) DISARMS and fires nothing.
 *  - Every non-delete action also disarms (the user moved on; a stale armed confirm
 *    must not survive unrelated activity).
 *  - A successful delete also requests the panel CLOSE (the zombie-panel guard).
 */

export interface ScheduleActionState {
  /** Whether the two-step Delete confirm is currently armed. */
  confirmArmed: boolean
  /** The schedule's current enabled flag (drives the Enable/Disable toggle target). */
  enabled: boolean
}

export type ScheduleActionEvent =
  | { type: "edit" }
  | { type: "toggle-enabled" }
  | { type: "run-now" }
  | { type: "delete-press" }
  | { type: "delete-confirm" }
  | { type: "delete-cancel" }
  /** The component instance's target id changed (defensive reset — MAJOR 1). */
  | { type: "panel-target-changed" }

export type ScheduleActionCall =
  | { kind: "edit" }
  | { kind: "setEnabled"; enabled: boolean }
  | { kind: "runNow" }
  | { kind: "delete" }

export interface ScheduleActionOutcome {
  /** The next armed state of the two-step Delete confirm. */
  confirmArmed: boolean
  /** The callback to fire (against the schedule id), or null. */
  call: ScheduleActionCall | null
  /** Whether the panel should close itself (after a confirmed delete). */
  closePanel: boolean
}

export function scheduleAction(
  state: ScheduleActionState,
  event: ScheduleActionEvent,
): ScheduleActionOutcome {
  switch (event.type) {
    case "edit":
      return { confirmArmed: false, call: { kind: "edit" }, closePanel: false }
    case "toggle-enabled":
      return {
        confirmArmed: false,
        call: { kind: "setEnabled", enabled: !state.enabled },
        closePanel: false,
      }
    case "run-now":
      return { confirmArmed: false, call: { kind: "runNow" }, closePanel: false }
    case "delete-press":
      // Arm (idempotent) — NEVER a delete call from the first press.
      return { confirmArmed: true, call: null, closePanel: false }
    case "delete-confirm":
      // The ONLY path to a delete — and only when armed. An unarmed confirm (a
      // stale/leaked click) REFUSES rather than deleting.
      return state.confirmArmed
        ? { confirmArmed: false, call: { kind: "delete" }, closePanel: true }
        : { confirmArmed: false, call: null, closePanel: false }
    case "delete-cancel":
      return { confirmArmed: false, call: null, closePanel: false }
    case "panel-target-changed":
      // The instance now renders a different schedule — disarm, fire nothing.
      return { confirmArmed: false, call: null, closePanel: false }
  }
}
