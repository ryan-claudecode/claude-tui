import { describe, it, expect } from "vitest"
import {
  validateWorkspaceName,
  addFormDir,
  addFormDirs,
  removeFormDir,
  nextActiveId,
  activeWorkspace,
} from "./workspaceForm"

describe("validateWorkspaceName", () => {
  it("accepts a non-empty name and trims it", () => {
    expect(validateWorkspaceName("  Billing  ")).toEqual({ ok: true, name: "Billing" })
  })

  it("rejects an empty or whitespace-only name", () => {
    expect(validateWorkspaceName("")).toEqual({ ok: false, error: "Name is required" })
    expect(validateWorkspaceName("   ")).toEqual({ ok: false, error: "Name is required" })
  })
})

describe("addFormDir / addFormDirs / removeFormDir", () => {
  it("adds a trimmed dir", () => {
    expect(addFormDir([], "  C:/a  ")).toEqual(["C:/a"])
  })

  it("de-dupes (returns SAME ref when already present)", () => {
    const dirs = ["C:/a"]
    expect(addFormDir(dirs, "C:/a")).toBe(dirs)
  })

  it("ignores blank paths (returns SAME ref)", () => {
    const dirs = ["C:/a"]
    expect(addFormDir(dirs, "   ")).toBe(dirs)
  })

  it("addFormDirs merges many, de-duped, order preserved", () => {
    expect(addFormDirs(["C:/a"], ["C:/b", "C:/a", "C:/c"])).toEqual(["C:/a", "C:/b", "C:/c"])
  })

  it("removeFormDir drops the matching dir only", () => {
    expect(removeFormDir(["C:/a", "C:/b"], "C:/a")).toEqual(["C:/b"])
    expect(removeFormDir(["C:/a"], "C:/x")).toEqual(["C:/a"])
  })
})

describe("nextActiveId — active-changed reducer", () => {
  it("maps a workspace payload to its id", () => {
    expect(nextActiveId({ id: "ws-1" })).toBe("ws-1")
  })

  it("maps null (cleared / deleted-active) to null (→ All)", () => {
    expect(nextActiveId(null)).toBeNull()
  })
})

describe("activeWorkspace — resolve the pill's workspace", () => {
  const list = [{ id: "ws-1" }, { id: "ws-2" }]

  it("returns null for 'All' mode (null id)", () => {
    expect(activeWorkspace(list, null)).toBeNull()
  })

  it("returns the matching workspace by id", () => {
    expect(activeWorkspace(list, "ws-2")).toEqual({ id: "ws-2" })
  })

  it("returns null when the active id no longer resolves (stale deleted-active)", () => {
    expect(activeWorkspace(list, "ws-gone")).toBeNull()
  })
})
