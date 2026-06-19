/**
 * WS-D (MAJOR 3 review fix) — the pure keyboard-navigation reducer for the
 * WorkspaceSwitcher dropdown. Kept React-free (no hooks, no DOM) so the
 * ↑/↓/Enter/Esc semantics are unit-testable in vitest's node env — mirrors
 * `workspaceFilter.ts` / `workspaceScope.ts` / `sessionRow.ts`.
 *
 * The component owns FOCUS (it must move focus into the menu so the key handler
 * receives events at all — the bug this fix addresses) and the SIDE EFFECTS
 * (activate / close); this module owns only the deterministic "what does this key
 * mean?" mapping, so both the wiring and the math can be reasoned about (and
 * tested) independently.
 */

/** The intent a key press resolves to, given the current menu state. */
export type MenuNavResult =
  | { type: "move"; highlight: number } // ↑/↓ — new highlight index (wrapping)
  | { type: "activate" } // Enter — fire the highlighted option
  | { type: "close" } // Esc — dismiss + return focus to the pill
  | { type: "none" } // any other key — let it pass through

/**
 * Resolve a key press in the open menu to a navigation intent.
 *
 * @param key the KeyboardEvent.key value.
 * @param highlight the currently-highlighted option index.
 * @param count the number of navigable options (>= 1 expected).
 * @returns the intent. ↑/↓ wrap around the list; Enter activates; Escape closes;
 *          anything else is `none`. With an empty list (count <= 0) ↑/↓ are
 *          `none` (nothing to move to) but Enter/Esc still resolve.
 */
export function menuNav(key: string, highlight: number, count: number): MenuNavResult {
  switch (key) {
    case "ArrowDown":
      if (count <= 0) return { type: "none" }
      return { type: "move", highlight: (highlight + 1) % count }
    case "ArrowUp":
      if (count <= 0) return { type: "none" }
      return { type: "move", highlight: (highlight - 1 + count) % count }
    case "Enter":
      return { type: "activate" }
    case "Escape":
      return { type: "close" }
    default:
      return { type: "none" }
  }
}
