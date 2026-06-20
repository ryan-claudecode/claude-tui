import { describe, it, expect, afterEach } from "vitest"
import { prefersReducedMotion } from "./reducedMotion"

/**
 * CAPP-74 — `prefersReducedMotion` gates the streaming smoothing buffer (and any
 * other motion-gated UI). Under the node test env there's no `window.matchMedia`, so
 * it must safely report false (no crash); when a stub reports the reduce preference,
 * it must report true.
 */

const g = globalThis as { window?: unknown }

afterEach(() => {
  // Tear down any window stub so tests stay isolated.
  delete g.window
})

describe("prefersReducedMotion", () => {
  it("returns false when there is no window / matchMedia (SSR / node env)", () => {
    expect(prefersReducedMotion()).toBe(false)
  })

  it("returns false when matchMedia reports the user does NOT want reduced motion", () => {
    g.window = { matchMedia: (q: string) => ({ matches: false, media: q }) }
    expect(prefersReducedMotion()).toBe(false)
  })

  it("returns true when matchMedia reports the reduce preference", () => {
    g.window = { matchMedia: (q: string) => ({ matches: q.includes("reduce"), media: q }) }
    expect(prefersReducedMotion()).toBe(true)
  })
})
