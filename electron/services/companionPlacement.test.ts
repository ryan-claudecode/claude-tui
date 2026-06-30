import { describe, it, expect } from "vitest"
import { placeCompanion, type Rect } from "./companionPlacement"

const SIZE = { width: 680, height: 860 }

describe("placeCompanion", () => {
  it("places to the RIGHT of main when it fits in the work area", () => {
    // Primary monitor, main window on the left half with room to its right.
    const workArea: Rect = { x: 0, y: 0, width: 2560, height: 1400 }
    const main: Rect = { x: 100, y: 120, width: 1200, height: 900 }

    const { x, y } = placeCompanion(main, SIZE, workArea)

    expect(x).toBe(main.x + main.width + 8) // 1308 — flush gutter to the right
    expect(y).toBe(main.y) // tracks the main window's top
    // Fully inside the work area.
    expect(x + SIZE.width).toBeLessThanOrEqual(workArea.x + workArea.width)
  })

  it("falls back to the LEFT of main when the right side overflows", () => {
    // Main pinned to the right edge — right placement would overflow, but there's
    // room to its left.
    const workArea: Rect = { x: 0, y: 0, width: 1920, height: 1080 }
    const main: Rect = { x: 1000, y: 60, width: 900, height: 1000 }

    const { x, y } = placeCompanion(main, SIZE, workArea)

    expect(x).toBe(main.x - SIZE.width - 8) // 312 — flush gutter to the left
    expect(y).toBe(main.y)
    expect(x).toBeGreaterThanOrEqual(workArea.x) // left edge on-screen
  })

  it("clamps flush against the right edge when neither side fits (overlap)", () => {
    // A narrow monitor where main fills most of it: no gutter room on either side,
    // so we fall through to flush-right and clamp.
    const workArea: Rect = { x: 0, y: 0, width: 1000, height: 1400 }
    const main: Rect = { x: 50, y: 40, width: 700, height: 1000 }

    const { x, y } = placeCompanion(main, SIZE, workArea)

    // flush-right candidate = workArea right - size = 1000 - 680 = 320; it's within
    // bounds so the clamp leaves it unchanged.
    expect(x).toBe(320)
    expect(y).toBe(main.y)
    // Right edge sits exactly on the work-area boundary (overlaps main — acceptable).
    expect(x + SIZE.width).toBe(workArea.x + workArea.width)
  })

  it("keeps the LEFT edge on-screen when the window is WIDER than the work area", () => {
    // Pathological: companion is wider than the whole monitor. The lower clamp
    // (Math.max(workArea.x, …)) must win so the draggable top-left stays visible
    // rather than being pushed off to satisfy the right edge.
    const workArea: Rect = { x: 0, y: 0, width: 500, height: 600 }
    const main: Rect = { x: 0, y: 0, width: 480, height: 580 }

    const { x, y } = placeCompanion(main, SIZE, workArea)

    expect(x).toBe(workArea.x) // 0 — left edge pinned on-screen
    expect(y).toBe(workArea.y) // 0 — top edge pinned on-screen (taller than work area too)
  })

  it("handles a multi-monitor display with a NEGATIVE origin", () => {
    // A secondary monitor positioned to the LEFT of the primary has a negative x
    // origin in the virtual desktop. Main lives on it; companion must clamp into
    // that monitor's coordinate space, not the primary's.
    const workArea: Rect = { x: -1920, y: 0, width: 1920, height: 1080 }
    const main: Rect = { x: -1820, y: 100, width: 900, height: 800 }

    const { x, y } = placeCompanion(main, SIZE, workArea)

    // Right of main fits: -1820 + 900 + 8 = -912; -912 + 680 = -232 <= -1920+1920=0. OK.
    expect(x).toBe(-912)
    expect(y).toBe(main.y)
    // Stays within the negative-origin monitor.
    expect(x).toBeGreaterThanOrEqual(workArea.x)
    expect(x + SIZE.width).toBeLessThanOrEqual(workArea.x + workArea.width)
  })

  it("is DIP-pure: reads no global, identical output regardless of ambient scale", () => {
    const workArea: Rect = { x: 0, y: 0, width: 2560, height: 1400 }
    const main: Rect = { x: 100, y: 120, width: 1200, height: 900 }

    const first = placeCompanion(main, SIZE, workArea)

    // Mutate a global that a scale-leaking implementation might read. A correct,
    // DIP-only function ignores it entirely and returns the same coordinates.
    const g = globalThis as unknown as { devicePixelRatio?: number }
    const prev = g.devicePixelRatio
    g.devicePixelRatio = 2.5
    try {
      const second = placeCompanion(main, SIZE, workArea)
      expect(second).toEqual(first)
    } finally {
      if (prev === undefined) delete g.devicePixelRatio
      else g.devicePixelRatio = prev
    }
  })

  it("respects a custom gutter", () => {
    const workArea: Rect = { x: 0, y: 0, width: 2560, height: 1400 }
    const main: Rect = { x: 100, y: 120, width: 1200, height: 900 }

    const { x } = placeCompanion(main, SIZE, workArea, 24)

    expect(x).toBe(main.x + main.width + 24) // 1324
  })
})

/**
 * The "main-center-in-dead-space" case lives at the computePlacement layer (which
 * picks the display) rather than placeCompanion (which is given a workArea). We
 * exercise the display-selection contract here with a tiny fake of
 * screen.getDisplayNearestPoint to prove: a main window whose CENTER sits between
 * two monitors resolves to the NEAREST live display, and placeCompanion then
 * clamps the result fully onto that display.
 */
describe("display selection for a main window centered in dead space", () => {
  // Two monitors side by side with a gap (dead space) between 1920 and 2200.
  const displays: Array<{ workArea: Rect }> = [
    { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    { workArea: { x: 2200, y: 0, width: 1920, height: 1080 } },
  ]

  // Stand-in for Electron's nearest-point lookup: returns the display whose work
  // area center is closest to the queried point (always a live display).
  const getDisplayNearestPoint = (pt: { x: number; y: number }) => {
    let best = displays[0]
    let bestDist = Infinity
    for (const d of displays) {
      const cx = d.workArea.x + d.workArea.width / 2
      const cy = d.workArea.y + d.workArea.height / 2
      const dist = Math.hypot(cx - pt.x, cy - pt.y)
      if (dist < bestDist) {
        bestDist = dist
        best = d
      }
    }
    return best
  }

  it("picks the nearest live display and clamps the companion onto it", () => {
    // Main window's center (x ≈ 2050) falls in the dead-space gap, closer to the
    // RIGHT monitor (center 3160) than the left (center 960)? No — 2050 is closer
    // to the left's 960 by 1090 vs the right's 1110. We assert whichever is nearer
    // is chosen, then that the placement clamps onto it.
    const main: Rect = { x: 1900, y: 200, width: 300, height: 400 }
    const center = {
      x: main.x + Math.floor(main.width / 2),
      y: main.y + Math.floor(main.height / 2),
    }
    const display = getDisplayNearestPoint(center)

    // center.x = 2050 → nearer the LEFT monitor (dist 1090 < 1110).
    expect(display.workArea.x).toBe(0)

    const { x, y } = placeCompanion(main, SIZE, display.workArea)
    // Right of main (1900+300+8=2208) + 680 = 2888 > 1920 → overflow; left of main
    // (1900-680-8=1212) >= 0 → fits left.
    expect(x).toBe(1212)
    expect(y).toBe(main.y)
    // Fully on the chosen (left) display.
    expect(x).toBeGreaterThanOrEqual(display.workArea.x)
    expect(x + SIZE.width).toBeLessThanOrEqual(display.workArea.x + display.workArea.width)
  })
})
