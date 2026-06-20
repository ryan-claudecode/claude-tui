import { describe, it, expect } from "vitest"
import { relativeTime } from "./relativeTime"

describe("relativeTime", () => {
  const now = 1_000_000_000_000

  it("reads 'just now' for a sub-45s or future delta", () => {
    expect(relativeTime(now, now)).toBe("just now")
    expect(relativeTime(now - 30_000, now)).toBe("just now")
    expect(relativeTime(now + 10_000, now)).toBe("just now")
  })

  it("formats minutes", () => {
    expect(relativeTime(now - 60_000, now)).toBe("1m ago")
    expect(relativeTime(now - 59 * 60_000, now)).toBe("59m ago")
  })

  it("formats hours", () => {
    expect(relativeTime(now - 60 * 60_000, now)).toBe("1h ago")
    expect(relativeTime(now - 2 * 60 * 60_000, now)).toBe("2h ago")
    expect(relativeTime(now - 23 * 60 * 60_000, now)).toBe("23h ago")
  })

  it("formats days then weeks", () => {
    expect(relativeTime(now - 24 * 60 * 60_000, now)).toBe("1d ago")
    expect(relativeTime(now - 6 * 24 * 60 * 60_000, now)).toBe("6d ago")
    expect(relativeTime(now - 7 * 24 * 60 * 60_000, now)).toBe("1w ago")
  })

  it("formats months then years for old conversations", () => {
    expect(relativeTime(now - 60 * 24 * 60 * 60_000, now)).toBe("2mo ago")
    expect(relativeTime(now - 400 * 24 * 60 * 60_000, now)).toBe("1y ago")
  })
})
