import { describe, it, expect } from "vitest"
import { resolveEngine } from "./renderingEngine"

describe("resolveEngine (BO-4a renderer fork)", () => {
  it("defaults to xterm while config is still loading (null/undefined)", () => {
    expect(resolveEngine(null)).toBe("xterm")
    expect(resolveEngine(undefined)).toBe("xterm")
  })

  it("defaults to xterm when rendering/engine is absent or unrecognized", () => {
    expect(resolveEngine({})).toBe("xterm")
    expect(resolveEngine({ rendering: {} })).toBe("xterm")
    expect(resolveEngine({ rendering: { engine: "bogus" } })).toBe("xterm")
    expect(resolveEngine({ rendering: { engine: "xterm" } })).toBe("xterm")
  })

  it("selects structured ONLY when explicitly configured", () => {
    expect(resolveEngine({ rendering: { engine: "structured" } })).toBe("structured")
  })
})
