/**
 * Pure placement math for the companion window — split out of companion.ts so it
 * has ZERO electron-runtime imports and is node-testable like src/lib/sessionRow.ts.
 *
 * WHY this exists: the old inline positioning was `x = main.x + main.width + 8`
 * with no clamp. If the main window sat near the right edge of its monitor (or on
 * a single laptop display), the companion was born partly or fully OFF-SCREEN with
 * no way to drag it back into view. This function guarantees the companion always
 * lands inside the given work area.
 *
 * ALL MATH IS IN DIP (device-independent pixels). Electron's `screen` bounds /
 * workArea AND `BrowserWindow` x/y are BOTH expressed in DIP — they are already
 * scale-normalized. So this function must NEVER read `devicePixelRatio` or any
 * other ambient scale: mixing DIP coords with a physical-pixel ratio is exactly
 * the multi-monitor bug we're fixing. Keeping it a pure function of its arguments
 * (no globals) makes that property testable.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Compute the top-left DIP coordinate for a companion window of `size`, placed
 * next to `main`, constrained to `workArea` (the monitor area excluding
 * taskbar/dock).
 *
 * Horizontal preference order:
 *   1. RIGHT of main (the historical default) — used when it fits in the work area.
 *   2. LEFT of main — fallback when the right side would overflow.
 *   3. Flush against the work area's right edge — last resort (overlaps main), used
 *      when neither gutter-side fits (e.g. a narrow monitor).
 * Then a HARD clamp on BOTH axes pins the window fully inside the work area, so the
 * "flush-right" case and a window wider/taller than the work area can never leave
 * the top-left corner off-screen (Math.max(workArea.x/y, …) wins, keeping the
 * draggable title corner reachable).
 */
export function placeCompanion(
  main: Rect,
  size: { width: number; height: number },
  workArea: Rect,
  gutter = 8,
): { x: number; y: number } {
  const rightX = main.x + main.width + gutter
  const leftX = main.x - size.width - gutter
  let x =
    rightX + size.width <= workArea.x + workArea.width
      ? rightX // fits to the right of main
      : leftX >= workArea.x
        ? leftX // else fits to the left of main
        : workArea.x + workArea.width - size.width // else flush against the right edge
  let y = main.y

  // Hard clamp into the work area on both axes. The lower bound (workArea.x/y)
  // is applied LAST so that even a window wider/taller than the work area keeps
  // its top-left corner on-screen rather than its bottom-right.
  const maxX = workArea.x + workArea.width - size.width
  const maxY = workArea.y + workArea.height - size.height
  x = Math.max(workArea.x, Math.min(x, maxX))
  y = Math.max(workArea.y, Math.min(y, maxY))
  return { x, y }
}
