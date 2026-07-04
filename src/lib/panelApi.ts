/**
 * CAPP-106 / S1 — the PanelApi contract: the EXHAUSTIVE, typed manifest of every
 * bridge method any of the behavior panels (#1 diff, #20 session-overview, #22
 * context-inspector) calls. The shared `PanelContent` switch
 * (`src/components/panels/PanelContent.tsx`) derives EVERY callback it threads to a
 * panel from a single `api: PanelApi` object, so a caller supplies ONE object and the
 * switch owns the per-panel wiring.
 *
 * Two callers each build a PanelApi over their native bridge:
 *   - CompanionApp → over `window.companionApi`.
 *   - ModalHost → over `window.api`.
 *
 * A compile-time parity GATE (`src/lib/panelApiParity.test.ts`) asserts that BOTH
 * `window.api` AND `window.companionApi` structurally satisfy `PanelApi`, so the
 * build fails if either window ever lacks a method some panel needs.
 *
 * These shapes reference the renderer-side type MIRROR (`contextInspectorView.ts`)
 * because the canonical service module pulls in `node:fs` and cannot be imported into
 * the renderer build.
 */

import type { InspectResultView } from "./contextInspectorView"

export interface PanelApi {
  // ── #1 diff: the send-review sink. Returns false when there's no active session
  //    to receive it. ─────────────────────────────────────────────────────────
  sendToSession: (text: string) => boolean

  // ── #24 schedule detail panel (CAPP-115): run-now / enable-disable / delete /
  //    edit. WRAPPED per-window (each builder wires them over its own bridge), so
  //    they're EXCLUDED from the accessor-parity subset below. ──
  scheduleRunNow: (id: string) => void
  scheduleSetEnabled: (id: string, enabled: boolean) => void
  scheduleDelete: (id: string) => void
  /** Open the pre-filled ScheduleForm for this schedule (routes to the main window). */
  scheduleEdit: (id: string) => void

  // ── close a panel by its PANEL id (routes through PanelService.hide, which clears
  //    BOTH surfaces + resolves a pending form as cancelled). Used by panels that must
  //    close themselves (the schedule panel after a confirmed delete — the zombie-panel
  //    guard). WRAPPED per-window like the schedule members above. ──────────────────
  hidePanel: (panelId: string) => void

  // ── #20 session-overview: open a session's Overview into the SAME host ─────────
  openSessionOverview: (sessionId: string) => Promise<unknown>

  // ── #22 context-inspector: the READ-ONLY Refresh re-read ─────────────────────
  inspectWorkspaceContext: (
    workspaceId: string | null,
  ) => Promise<InspectResultView>
}

/**
 * The subset of `PanelApi` that maps 1:1 to a RAW bridge accessor present (with the SAME
 * signature) on BOTH `window.api` AND `window.companionApi` — i.e. the panel-INTERNAL
 * accessors the panels read directly (overview, inspect). The type-parity GATE
 * (`panelApiParity.test.ts`) checks BOTH bridges against THIS subset.
 *
 * The remaining `PanelApi` member — `sendToSession` — is deliberately EXCLUDED: each caller
 * WRAPS a window-specific primitive into it. It is not a raw shared accessor, so a structural
 * bridge check doesn't apply — the wrapping is the contract.
 */
export type PanelApiAccessors = Omit<
  PanelApi,
  | "sendToSession"
  | "scheduleRunNow"
  | "scheduleSetEnabled"
  | "scheduleDelete"
  | "scheduleEdit"
  | "hidePanel"
>
