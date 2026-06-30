import { useMemo } from "react"
import type { PanelLike } from "../components/panels/PanelContent"

/**
 * CAPP-109 / S2 — FORM-EXCLUSIVE active-panel selection for the in-main-window
 * ModalHost. PURE + tested (no React state, no DOM) so the highest-risk rule — a
 * pending `show_form` must NEVER be silently unmounted by a later `show_panel` — is
 * provable in a unit test.
 *
 * The rules (plan §A.6):
 *   1. FORM EXCLUSIVITY. If ANY visible panel is a `form`, it WINS the active slot
 *      regardless of recency or of an explicit tab selection. A pending form is the
 *      user's blocking obligation (the MCP `show_form` call hangs until it resolves),
 *      so it must stay mounted + reachable. If multiple forms stack, the OLDEST wins
 *      (the queue drains in order — visible[] preserves show order, so the first form
 *      in the list is the oldest).
 *   2. Otherwise honor the renderer's explicit tab selection (`preferredId`) when it
 *      still points at a visible panel; else fall back to the MOST-RECENT visible
 *      panel (last in show order). This matches the companion's "most-recent wins"
 *      default while letting the tab strip pin a chosen panel.
 *
 * Returns `null` when nothing is visible (ModalHost renders nothing).
 */
export function pickActivePanel<T extends PanelLike>(
  visible: T[],
  preferredId?: string | null,
): T | null {
  if (visible.length === 0) return null
  // Rule 1 — a visible form is exclusive; the oldest (first-shown) drains first.
  const firstForm = visible.find((p) => p.type === "form")
  if (firstForm) return firstForm
  // Rule 2 — explicit tab selection, if it still points at a visible panel.
  if (preferredId != null) {
    const chosen = visible.find((p) => p.id === preferredId)
    if (chosen) return chosen
  }
  // Else the most-recent visible panel (last in show order).
  return visible[visible.length - 1]
}

/** React hook wrapper around `pickActivePanel`, memoized on the visible set + the
 *  renderer-side preferred tab id. */
export function useActivePanel<T extends PanelLike>(
  visible: T[],
  preferredId?: string | null,
): T | null {
  return useMemo(() => pickActivePanel(visible, preferredId), [visible, preferredId])
}
