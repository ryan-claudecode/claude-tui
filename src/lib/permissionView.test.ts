import { describe, it, expect } from "vitest"
import { describePermission } from "./permissionView"

describe("BO-3 describePermission — tool input view-model", () => {
  it("Bash → command + description", () => {
    const v = describePermission("Bash", { command: "git status", description: "check repo" })
    expect(v).toEqual({ kind: "bash", command: "git status", description: "check repo" })
  })

  it("PowerShell is treated like Bash (command surface)", () => {
    const v = describePermission("PowerShell", { command: "Get-ChildItem" })
    expect(v).toEqual({ kind: "bash", command: "Get-ChildItem", description: undefined })
  })

  it("Write → file path + content (all-additions preview)", () => {
    const v = describePermission("Write", { file_path: "src/App.tsx", content: "hello" })
    expect(v).toEqual({ kind: "write", filePath: "src/App.tsx", content: "hello" })
  })

  it("Edit → old → new diff preview", () => {
    const v = describePermission("Edit", {
      file_path: "a.ts",
      old_string: "const x = 1",
      new_string: "const x = 2",
    })
    expect(v).toEqual({ kind: "edit", filePath: "a.ts", oldText: "const x = 1", newText: "const x = 2" })
  })

  it("unknown tool → generic JSON summary", () => {
    const v = describePermission("mcp__github__create_issue", { title: "bug", body: "x" })
    expect(v.kind).toBe("generic")
    if (v.kind === "generic") expect(v.summary).toContain("title")
  })

  it("Write missing fields falls back to generic", () => {
    const v = describePermission("Write", { something_else: true })
    expect(v.kind).toBe("generic")
  })

  it("never throws on a null/odd input", () => {
    expect(describePermission("Bash", null).kind).toBe("generic")
    expect(describePermission("", undefined).kind).toBe("generic")
  })
})
