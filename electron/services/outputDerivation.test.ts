import { describe, it, expect } from "vitest"
import {
  newTurnBuffer,
  addFileTouch,
  suppressDerived,
  extractLinks,
  flushTurn,
  baseName,
  draftKey,
  MAX_FILES_PER_TURN,
  MAX_LINKS_PER_TURN,
} from "./outputDerivation"

describe("outputDerivation — baseName / draftKey", () => {
  it("baseName handles / and \\ separators and trailing slashes", () => {
    expect(baseName("/repo/src/x.ts")).toBe("x.ts")
    expect(baseName("C:\\proj\\report.md")).toBe("report.md")
    expect(baseName("/repo/dir/")).toBe("dir")
    expect(baseName("plain.txt")).toBe("plain.txt")
  })

  it("draftKey keys files by path, links by url, and returns null for notes/target-less", () => {
    expect(draftKey({ kind: "file", path: "/a/b.ts" })).toBe("file:/a/b.ts")
    expect(draftKey({ kind: "link", url: "https://x.io" })).toBe("link:https://x.io")
    expect(draftKey({ kind: "note" })).toBeNull()
    expect(draftKey({ kind: "file" })).toBeNull()
  })
})

describe("outputDerivation — link extraction", () => {
  it("extracts a markdown link (its text is the title)", () => {
    const links = extractLinks("See [the PR](https://github.com/o/r/pull/5) for details.")
    expect(links).toEqual([
      { kind: "link", title: "the PR", url: "https://github.com/o/r/pull/5", source: "derived" },
    ])
  })

  it("extracts a bare http(s) URL with a host+path title, trimming a trailing period", () => {
    const links = extractLinks("Deployed to https://example.com/app/dashboard.")
    expect(links).toHaveLength(1)
    expect(links[0].url).toBe("https://example.com/app/dashboard")
    expect(links[0].title).toBe("example.com/app/dashboard")
  })

  it("dedupes by URL — a markdown link + the same bare URL yields ONE (markdown title wins)", () => {
    const links = extractLinks("[docs](https://example.com/x) and again https://example.com/x")
    expect(links).toHaveLength(1)
    expect(links[0].title).toBe("docs")
  })

  it("keeps first-appearance order across multiple distinct links", () => {
    const links = extractLinks("first https://a.io then [second](https://b.io/path)")
    expect(links.map((l) => l.url)).toEqual(["https://a.io", "https://b.io/path"])
  })

  it("returns [] for text with no links", () => {
    expect(extractLinks("no links here")).toEqual([])
    expect(extractLinks("")).toEqual([])
  })
})

describe("outputDerivation — file coalescing + flush order", () => {
  it("coalesces the same path touched twice into ONE draft (first-touch order kept)", () => {
    const buf = newTurnBuffer()
    addFileTouch(buf, "/repo/a.ts")
    addFileTouch(buf, "/repo/b.ts")
    addFileTouch(buf, "/repo/a.ts") // Write then Edit of a.ts → still one
    const out = flushTurn(buf, "")
    expect(out.map((d) => d.path)).toEqual(["/repo/a.ts", "/repo/b.ts"])
    expect(out.every((d) => d.kind === "file")).toBe(true)
  })

  it("skips a missing / non-string / blank file path defensively", () => {
    const buf = newTurnBuffer()
    addFileTouch(buf, undefined)
    addFileTouch(buf, 42 as unknown)
    addFileTouch(buf, "   ")
    expect(flushTurn(buf, "")).toEqual([])
  })

  it("emits files (touch order) THEN links from the result text as one batch", () => {
    const buf = newTurnBuffer()
    addFileTouch(buf, "/repo/x.ts")
    const out = flushTurn(buf, "Wrote it. See [PR](https://gh.com/pr/1).")
    expect(out.map((d) => d.kind)).toEqual(["file", "link"])
    expect(out[0].path).toBe("/repo/x.ts")
    expect(out[1].url).toBe("https://gh.com/pr/1")
  })
})

describe("outputDerivation — noise caps", () => {
  it("caps files at 10 and appends ONE derived 'and N more files' note", () => {
    const buf = newTurnBuffer()
    for (let i = 0; i < 13; i++) addFileTouch(buf, `/repo/f${i}.ts`)
    const out = flushTurn(buf, "")
    const files = out.filter((d) => d.kind === "file")
    const notes = out.filter((d) => d.kind === "note")
    expect(files).toHaveLength(MAX_FILES_PER_TURN)
    expect(notes).toHaveLength(1)
    expect(notes[0].title).toBe("…and 3 more files")
    // The note sits right after the 10 files.
    expect(out[MAX_FILES_PER_TURN].kind).toBe("note")
  })

  it("uses the singular 'file' for exactly one overflow", () => {
    const buf = newTurnBuffer()
    for (let i = 0; i < 11; i++) addFileTouch(buf, `/repo/f${i}.ts`)
    const out = flushTurn(buf, "")
    expect(out.find((d) => d.kind === "note")!.title).toBe("…and 1 more file")
  })

  it("caps links at 10, silently dropping the rest (no overflow note)", () => {
    const buf = newTurnBuffer()
    const text = Array.from({ length: 15 }, (_, i) => `https://ex.com/p${i}`).join(" ")
    const out = flushTurn(buf, text)
    expect(out.filter((d) => d.kind === "link")).toHaveLength(MAX_LINKS_PER_TURN)
    expect(out.filter((d) => d.kind === "note")).toHaveLength(0)
  })
})

describe("outputDerivation — explicit beats derived (suppress at flush)", () => {
  it("drops a derived FILE draft whose path an explicit post already claimed", () => {
    const buf = newTurnBuffer()
    addFileTouch(buf, "/repo/report.md") // derived (basename title)
    addFileTouch(buf, "/repo/other.ts")
    // An explicit post for the same path this turn (records the suppress key).
    suppressDerived(buf, { kind: "file", path: "/repo/report.md" })
    const out = flushTurn(buf, "")
    // report.md is dropped (the explicit post carried the better title, forwarded already);
    // other.ts survives.
    expect(out.map((d) => d.path)).toEqual(["/repo/other.ts"])
  })

  it("drops a derived LINK whose url an explicit post already claimed", () => {
    const buf = newTurnBuffer()
    suppressDerived(buf, { kind: "link", url: "https://gh.com/pr/9" })
    const out = flushTurn(buf, "Opened [PR](https://gh.com/pr/9) and https://other.io")
    expect(out.map((d) => d.url)).toEqual(["https://other.io"])
  })

  it("a note suppress records nothing (can't collide with a derived draft)", () => {
    const buf = newTurnBuffer()
    addFileTouch(buf, "/repo/a.ts")
    suppressDerived(buf, { kind: "note" })
    expect(flushTurn(buf, "")).toHaveLength(1)
  })
})
