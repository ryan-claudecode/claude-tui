import { describe, it, expect } from "vitest"
import { commitRenameValue } from "./renameValue"

describe("commitRenameValue", () => {
  it("trims surrounding whitespace and reports a change", () => {
    expect(commitRenameValue("  New Name  ", "Old")).toEqual({ name: "New Name", changed: true })
  })

  it("reverts to the previous name when the input is empty (never blanks)", () => {
    expect(commitRenameValue("", "Old")).toEqual({ name: "Old", changed: false })
  })

  it("reverts to the previous name when the input is whitespace-only", () => {
    expect(commitRenameValue("   ", "Old")).toEqual({ name: "Old", changed: false })
  })

  it("reports no change when the trimmed value equals the previous name", () => {
    expect(commitRenameValue("Old", "Old")).toEqual({ name: "Old", changed: false })
    expect(commitRenameValue("  Old  ", "Old")).toEqual({ name: "Old", changed: false })
  })

  it("reports a change for a distinct trimmed value", () => {
    expect(commitRenameValue("Different", "Old")).toEqual({ name: "Different", changed: true })
  })
})
