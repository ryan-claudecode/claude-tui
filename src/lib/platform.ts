/**
 * Platform helpers — pure, unit-tested, zero side effects.
 *
 * `cmdOrCtrl` is the canonical modifier check for all app keyboard shortcuts:
 *   - darwin  → e.metaKey  (Cmd key)
 *   - win32 / linux → e.ctrlKey (Ctrl key)
 *
 * On win32/linux it returns EXACTLY e.ctrlKey — behavior is byte-identical to the
 * former direct `e.ctrlKey` checks. The opposite modifier is never matched
 * (Ctrl on darwin or Cmd on win32/linux does NOT trigger shortcuts).
 */

export const isMac = (platform: string): boolean => platform === "darwin"

export function cmdOrCtrl(
  e: KeyboardEvent | React.KeyboardEvent,
  platform: string,
): boolean {
  return platform === "darwin" ? e.metaKey : e.ctrlKey
}

export function modKeyLabel(platform: string): string {
  return platform === "darwin" ? "Cmd" : "Ctrl"
}
