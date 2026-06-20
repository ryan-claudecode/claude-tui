import { describe, it, expect } from "vitest"
import {
  validateWorkspaceName,
  dirBasename,
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

describe("dirBasename — WS-H single-folder display label", () => {
  it("returns the last segment of a Windows path", () => {
    expect(dirBasename("C:\\Users\\me\\projects\\claude-tui-app")).toBe("claude-tui-app")
  })

  it("returns the last segment of a POSIX path", () => {
    expect(dirBasename("/home/me/projects/billing")).toBe("billing")
  })

  it("ignores a trailing separator", () => {
    expect(dirBasename("C:\\projects\\demo\\")).toBe("demo")
    expect(dirBasename("/projects/demo/")).toBe("demo")
  })

  it("returns '' for empty / null / undefined", () => {
    expect(dirBasename("")).toBe("")
    expect(dirBasename(null)).toBe("")
    expect(dirBasename(undefined)).toBe("")
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
