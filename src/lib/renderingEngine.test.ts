import { describe, it, expect } from "vitest"
import { resolveEngine } from "./renderingEngine"

describe("resolveEngine (BO-4a renderer fork)", () => {
  // CAPP-39 gate ④ — the default flipped to structured; only an explicit "xterm"
  // selects the legacy PTY surface. Stays logically in sync with the main-process
  // resolveRenderingEngine (electron/config.ts).
  it("defaults to structured while config is still loading (null/undefined)", () => {
    expect(resolveEngine(null)).toBe("structured")
    expect(resolveEngine(undefined)).toBe("structured")
  })

  it("defaults to structured when rendering/engine is absent or unrecognized", () => {
    expect(resolveEngine({})).toBe("structured")
    expect(resolveEngine({ rendering: {} })).toBe("structured")
    expect(resolveEngine({ rendering: { engine: "bogus" } })).toBe("structured")
    expect(resolveEngine({ rendering: { engine: "structured" } })).toBe("structured")
  })

  it("selects xterm ONLY when explicitly configured", () => {
    expect(resolveEngine({ rendering: { engine: "xterm" } })).toBe("xterm")
  })
})
