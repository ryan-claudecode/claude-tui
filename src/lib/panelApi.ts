/**
 * CAPP-106 / S1 — the PanelApi contract: the EXHAUSTIVE, typed manifest of every
 * bridge method any of the behavior panels (#1 diff, #18 mission, #19 recall,
 * #20 session-overview, #21 workspace-memory, #22 context-inspector, #23
 * worktree-review) calls. The shared `PanelContent` switch (`src/components/panels/
 * PanelContent.tsx`) derives EVERY callback it threads to a panel from a single
 * `api: PanelApi` object, so a caller supplies ONE object and the switch owns the
 * per-panel wiring (this folds the six previously-inline companion callbacks —
 * onSendToSession / onMissionStop / onMissionPause / onApproveWorktree /
 * onRejectWorktree, plus the panel-internal accessors — into `api`).
 *
 * Two callers each build a PanelApi over their native bridge:
 *   - CompanionApp → over `window.companionApi` (1:1 wrap of today's callbacks +
 *     the panel-internal accessors the #19-23 panels used to read off companionApi).
 *   - (S2) ModalHost → over `window.api`, using the F1-added accessors.
 *
 * A compile-time parity GATE (`src/lib/panelApiParity.test.ts`) asserts that BOTH
 * `window.api` AND `window.companionApi` structurally satisfy `PanelApi`, so the
 * build fails if either window ever lacks a method some panel needs (this is the
 * standing guard against the exact F1 drift — `openSessionOverview` /
 * `promoteSessionToWorkspace` having been companion-only).
 *
 * These shapes reference the renderer-side type MIRRORS (`workspaceMemoryView.ts`,
 * `exportView.ts`, `contextInspectorView.ts`) because the canonical service modules
 * pull in `node:fs` and cannot be imported into the renderer build.
 */

import type {
  WorkspaceMemoryRecord,
  WorkspaceFinding,
} from "./workspaceMemoryView"
import type {
  ExportStateView,
  EnableResultView,
  AdoptionStateView,
  WireResultView,
} from "./exportView"
import type { InspectResultView } from "./contextInspectorView"
import type { ReviewActionResult } from "../components/panels/WorktreeReviewPanel"

export type { ReviewActionResult }

/** A recall hit — kept loose (`any[]`) to match the untyped IPC boundary both
 *  bridges return; RecallPanel owns its own concrete RecallHit shape. */
export type RecallHit = any

export interface PanelApi {
  // ── #1 diff + #23 worktree-review: the send-review sink. Returns false when
  //    there's no active session to receive it. ─────────────────────────────────
  sendToSession: (text: string) => boolean

  // ── #18 mission Stop / Pause ─────────────────────────────────────────────────
  missionStop: (id: string) => void
  missionPause: (id: string) => void

  // ── #23 worktree-review approve / reject (the result-bearing round-trip). The
  //    PanelContent switch swallows IPC failures to `null` so the panel shows its
  //    inline error rather than rejecting the click handler. ─────────────────────
  approveWorktreeTask: (
    missionId: string,
    taskId: string,
  ) => Promise<ReviewActionResult | null>
  rejectWorktreeTask: (
    missionId: string,
    taskId: string,
    reason?: string,
  ) => Promise<ReviewActionResult | null>

  // ── #19 recall: cross-session search + click-a-session-header → open its
  //    Overview into the SAME host (recursive-by-design from the modal). ─────────
  recall: (
    query: string,
    scope?: "session" | "workspace" | "all",
    sessionId?: string,
  ) => Promise<RecallHit[]>
  openSessionOverview: (sessionId: string) => Promise<unknown>

  // ── #20 session-overview: "Push context to workspace" ────────────────────────
  promoteSessionToWorkspace: (
    sessionId: string,
  ) => Promise<{ ok: boolean; count: number; workspaceId: string | null }>

  // ── #21 workspace-memory editor (instructions + findings + pin) + live-refresh ─
  getWorkspaceMemory: (workspaceId: string | null) => Promise<WorkspaceMemoryRecord>
  setWorkspaceInstructions: (
    workspaceId: string | null,
    text: string,
  ) => Promise<WorkspaceMemoryRecord>
  addWorkspaceFinding: (
    workspaceId: string | null,
    text: string,
    source: "user" | "agent",
  ) => Promise<WorkspaceFinding>
  editWorkspaceFinding: (
    workspaceId: string | null,
    findingId: string,
    text: string,
  ) => Promise<boolean>
  deleteWorkspaceFinding: (
    workspaceId: string | null,
    findingId: string,
  ) => Promise<boolean>
  setWorkspaceFindingPinned: (
    workspaceId: string | null,
    findingId: string,
    pinned: boolean,
  ) => Promise<boolean>
  onWorkspaceMemoryChanged: (cb: (workspaceId: string) => void) => () => void

  // ── #21 workspace-memory: export (CAPP-99 / E1) ──────────────────────────────
  getExportState: (workspaceId: string | null) => Promise<ExportStateView>
  enableExport: (
    workspaceId: string | null,
    mode: "A" | "C",
    customPath?: string,
  ) => Promise<EnableResultView>
  disableExport: (workspaceId: string | null) => Promise<ExportStateView>
  setUntaggedExportEnabled: (enabled: boolean) => Promise<ExportStateView>
  regenerateExport: (
    workspaceId: string | null,
  ) => Promise<{ ok: boolean; wrote?: boolean; error?: string }>

  // ── #21 workspace-memory: adoption (CAPP-100 / E2) ───────────────────────────
  getAdoptionState: (workspaceId: string | null) => Promise<AdoptionStateView>
  wireImportBlock: (workspaceId: string | null) => Promise<WireResultView>
  unwireImportBlock: (workspaceId: string | null) => Promise<WireResultView>
  setExportSelfWired: (
    workspaceId: string | null,
    selfWired: boolean,
  ) => Promise<ExportStateView>

  // ── #22 context-inspector: the READ-ONLY Refresh re-read ─────────────────────
  inspectWorkspaceContext: (
    workspaceId: string | null,
  ) => Promise<InspectResultView>
}

/**
 * The subset of `PanelApi` that maps 1:1 to a RAW bridge accessor present (with the SAME
 * signature) on BOTH `window.api` AND `window.companionApi` — i.e. the panel-INTERNAL
 * accessors the #19-23 panels read directly (recall, overview, promote, workspace-memory,
 * export, adoption, inspect, worktree approve/reject). The type-parity GATE
 * (`panelApiParity.test.ts`) checks BOTH bridges against THIS subset.
 *
 * The remaining three `PanelApi` members — `sendToSession` / `missionStop` / `missionPause`
 * — are deliberately EXCLUDED: each caller WRAPS a window-specific primitive into them
 * (CompanionApp wraps companionApi's fire-and-forget `sendToSession` to return `true`; the
 * S2 ModalHost will wrap `window.api`'s `companion:send-to-session` / `stopMission` /
 * `pauseMission`). They are not raw shared accessors, so a structural bridge check doesn't
 * apply — the wrapping is the contract. The F1 drift class (an ACCESSOR being on one bridge
 * but not the other) lives entirely in this subset, which is what the gate guards.
 */
export type PanelApiAccessors = Omit<
  PanelApi,
  "sendToSession" | "missionStop" | "missionPause"
>
