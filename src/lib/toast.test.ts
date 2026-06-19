import { describe, it, expect } from "vitest"
import { buildToast } from "./toast"

describe("buildToast", () => {
  it("constructs a toast payload with the given level, message, and title", () => {
    const t = buildToast("info", "hello", "Heads up")
    expect(t.level).toBe("info")
    expect(t.message).toBe("hello")
    expect(t.title).toBe("Heads up")
  })

  it("omits the title when not provided", () => {
    const t = buildToast("success", "done")
    expect(t.title).toBeUndefined()
  })

  it("gives errors a longer timeout than other levels", () => {
    expect(buildToast("error", "boom").timeout).toBe(8000)
    expect(buildToast("info", "fyi").timeout).toBe(6000)
    expect(buildToast("warning", "careful").timeout).toBe(6000)
    expect(buildToast("success", "ok").timeout).toBe(6000)
  })

  it("generates a unique id and a createdAt timestamp", () => {
    const before = Date.now()
    const a = buildToast("info", "a")
    const b = buildToast("info", "b")
    expect(a.id).not.toBe(b.id)
    expect(typeof a.id).toBe("string")
    expect(a.id.length).toBeGreaterThan(0)
    expect(a.createdAt).toBeGreaterThanOrEqual(before)
    expect(a.createdAt).toBeLessThanOrEqual(Date.now())
  })
})
