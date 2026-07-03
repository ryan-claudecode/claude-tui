/**
 * Pure view-model helpers for the Agent Rail BUTTONS group (CAPP-104 / AB-1).
 *
 * Renderer-side, so it CANNOT import `electron/services/actionButtons.ts` (that pulls
 * in `node:fs`). {@link UNTAGGED_OWNER_ID} mirrors the canonical
 * `WorkspaceMemoryService.UNTAGGED_STEM` sentinel; a compile-time parity pin
 * (`electron/services/actionButtonUntaggedSync.test.ts`) fails the build on drift.
 */

/** The stored owner id for the untagged / folderless workspace bucket. MUST equal the
 *  canonical `UNTAGGED_STEM` — the parity test guards this. */
export const UNTAGGED_OWNER_ID = "__untagged__"

export type ButtonScope = "session" | "workspace"

/** The renderer-facing button shape (a subset of the durable ActionButton — no createdBy/
 *  createdAt, which the rail doesn't render). Rides along each `actionbuttons:updated`
 *  push and the `listActionButtons()` seed. */
export interface ActionButtonView {
  id: string
  label: string
  prompt: string
  scope: ButtonScope
  ownerId: string
  confirm?: boolean
}

/**
 * The ordered visible subset for the rail: the ACTIVE session's buttons first, then
 * that session's workspace's buttons. Empty when there's no active session (there'd be
 * no dispatch target). The workspace match maps an absent workspaceId to the untagged
 * sentinel so an untagged session sees the "All" bucket's buttons.
 */
export function deriveVisibleButtons(
  all: readonly ActionButtonView[],
  sessionId: string | null | undefined,
  workspaceId: string | null | undefined,
): ActionButtonView[] {
  if (!sessionId) return []
  const wsOwner = workspaceId == null ? UNTAGGED_OWNER_ID : workspaceId
  const session = all.filter((b) => b.scope === "session" && b.ownerId === sessionId)
  const workspace = all.filter((b) => b.scope === "workspace" && b.ownerId === wsOwner)
  return [...session, ...workspace]
}

export interface ClickOutcome {
  /** The next armed button id (null = nothing armed). */
  armedId: string | null
  /** Whether this click should DISPATCH the button now. */
  dispatch: boolean
}

/**
 * The two-step inline-confirm state machine for a button click, KEYED BY BUTTON ID
 * (the CAPP-115 lesson: an armed confirm must never leak across rows).
 *
 *  • a non-confirm button dispatches immediately and clears any armed state.
 *  • a confirm button's FIRST click arms IT (disarming any other row); the SECOND
 *    click on the SAME id dispatches and disarms. Clicking a different confirm button
 *    re-arms that one (so the previous never fires by accident).
 */
export function resolveClick(
  button: { id: string; confirm?: boolean },
  armedId: string | null,
): ClickOutcome {
  if (!button.confirm) return { armedId: null, dispatch: true }
  if (armedId === button.id) return { armedId: null, dispatch: true }
  return { armedId: button.id, dispatch: false }
}
