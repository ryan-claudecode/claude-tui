import { describe, it, expect } from "vitest"
import { parseUnifiedDiff } from "./unifiedDiff"

describe("parseUnifiedDiff", () => {
  it("returns [] for empty or whitespace-only input", () => {
    expect(parseUnifiedDiff("")).toEqual([])
    expect(parseUnifiedDiff("   \n  \n")).toEqual([])
  })

  it("reconstructs old/new content for a simple edit", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 1111111..2222222 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,3 @@",
      " const a = 1",
      "-const b = 2",
      "+const b = 3",
      " const c = 4",
    ].join("\n")
    const files = parseUnifiedDiff(diff)
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe("src/foo.ts")
    expect(files[0].oldContent).toBe("const a = 1\nconst b = 2\nconst c = 4\n")
    expect(files[0].newContent).toBe("const a = 1\nconst b = 3\nconst c = 4\n")
  })

  it("handles a pure addition (new file)", () => {
    const diff = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+line one",
      "+line two",
    ].join("\n")
    const files = parseUnifiedDiff(diff)
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe("new.txt")
    expect(files[0].oldContent).toBe("")
    expect(files[0].newContent).toBe("line one\nline two\n")
  })

  it("handles a deletion", () => {
    const diff = [
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "index 4444444..0000000",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-bye",
    ].join("\n")
    const files = parseUnifiedDiff(diff)
    expect(files).toHaveLength(1)
    // +++ is /dev/null, so the path falls back to the git header (gone.txt).
    expect(files[0].path).toBe("gone.txt")
    expect(files[0].oldContent).toBe("bye\n")
    expect(files[0].newContent).toBe("")
  })

  it("splits a multi-file diff into one entry per file", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1 @@",
      "-old x",
      "+new x",
      "diff --git a/y.ts b/y.ts",
      "--- a/y.ts",
      "+++ b/y.ts",
      "@@ -1 +1 @@",
      "-old y",
      "+new y",
    ].join("\n")
    const files = parseUnifiedDiff(diff)
    expect(files.map((f) => f.path)).toEqual(["x.ts", "y.ts"])
    expect(files[0].newContent).toBe("new x\n")
    expect(files[1].newContent).toBe("new y\n")
  })

  it("surfaces a binary-file note so the panel isn't blank", () => {
    const diff = [
      "diff --git a/logo.png b/logo.png",
      "index 5555555..6666666 100644",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n")
    const files = parseUnifiedDiff(diff)
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe("logo.png")
    expect(files[0].oldContent).toContain("Binary files")
    expect(files[0].newContent).toContain("Binary files")
  })

  it("ignores the no-newline-at-eof annotation", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-a",
      "\\ No newline at end of file",
      "+b",
      "\\ No newline at end of file",
    ].join("\n")
    const files = parseUnifiedDiff(diff)
    expect(files[0].oldContent).toBe("a\n")
    expect(files[0].newContent).toBe("b\n")
  })
})
