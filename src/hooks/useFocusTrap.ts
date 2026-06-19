import { useEffect, useRef } from "react"

/**
 * CSS selector that matches every natively-focusable element.
 * Exported so tests can import and verify the selector without a DOM.
 */
export const FOCUSABLE_SELECTOR =
  'a[href], area[href], input:not([disabled]):not([type="hidden"]), ' +
  "select:not([disabled]), textarea:not([disabled]), button:not([disabled]), " +
  "iframe, object, embed, [contenteditable]:not([contenteditable='false']), " +
  "[tabindex]:not([tabindex='-1'])"

/**
 * Return the ordered list of focusable descendants inside `container`.
 */
function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
}

/**
 * useFocusTrap — shared focus-trap for modal overlays.
 *
 * When `active` flips to true:
 *  - Records the currently-focused element so focus can be restored on close.
 *  - Moves focus into the overlay (first focusable child, or the container itself).
 *  - Intercepts Tab / Shift+Tab to keep focus inside the overlay.
 *
 * When `active` flips to false:
 *  - Restores focus to the previously-focused element.
 *
 * @param containerRef  Ref to the overlay root element.
 * @param active        Whether the overlay is open.
 */
export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  active: boolean,
): void {
  // Remember where focus was before the overlay opened.
  const previouslyFocused = useRef<Element | null>(null)

  // Move focus into the overlay when it opens; restore when it closes.
  useEffect(() => {
    if (active) {
      previouslyFocused.current = document.activeElement
      const container = containerRef.current
      if (container) {
        const first = getFocusable(container)[0]
        if (first) {
          first.focus()
        } else {
          container.focus()
        }
      }
    } else {
      const el = previouslyFocused.current
      if (el && (el as HTMLElement).focus) {
        ;(el as HTMLElement).focus()
      }
      previouslyFocused.current = null
    }
  }, [active, containerRef])

  // Tab / Shift+Tab cycle within the overlay while it is active.
  useEffect(() => {
    if (!active) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return
      const container = containerRef.current
      if (!container) return

      const focusable = getFocusable(container)
      if (focusable.length === 0) {
        e.preventDefault()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const current = document.activeElement

      if (e.shiftKey) {
        // Shift+Tab: if at first (or outside), wrap to last.
        if (current === first || !container.contains(current)) {
          e.preventDefault()
          last.focus()
        }
      } else {
        // Tab: if at last (or outside), wrap to first.
        if (current === last || !container.contains(current)) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown, true)
    return () => document.removeEventListener("keydown", handleKeyDown, true)
  }, [active, containerRef])
}
