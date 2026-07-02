import { describe, it, expect } from "vitest"
import { spliceWithSpacing } from "./insertAtCursor"

describe("insertAtCursor — spliceWithSpacing", () => {
  it("into empty text: no surrounding spaces", () => {
    expect(spliceWithSpacing("", 0, 0, "hello")).toEqual({ text: "hello", cursor: 5 })
  })

  it("at the end of a word: adds a leading space", () => {
    const r = spliceWithSpacing("hello", 5, 5, "world")
    expect(r.text).toBe("hello world")
    expect(r.cursor).toBe("hello world".length)
  })

  it("does not double a space when one already precedes", () => {
    const r = spliceWithSpacing("hello ", 6, 6, "world")
    expect(r.text).toBe("hello world")
  })

  it("in the middle before a word: adds a trailing space", () => {
    const r = spliceWithSpacing("world", 0, 0, "hello")
    expect(r.text).toBe("hello world")
    expect(r.cursor).toBe("hello ".length)
  })

  it("replaces a selection", () => {
    // Select "brown" in "the brown fox" and replace with "red".
    const text = "the brown fox"
    const start = text.indexOf("brown")
    const end = start + "brown".length
    const r = spliceWithSpacing(text, start, end, "red")
    expect(r.text).toBe("the red fox")
  })

  it("no leading space right after an opening bracket", () => {
    const r = spliceWithSpacing("(", 1, 1, "hi")
    expect(r.text).toBe("(hi")
  })

  it("insert that starts with punctuation gets no leading space", () => {
    const r = spliceWithSpacing("hi", 2, 2, ".")
    expect(r.text).toBe("hi.")
  })

  it("clamps out-of-range selection indices", () => {
    const r = spliceWithSpacing("abc", 99, 99, "x")
    expect(r.text).toBe("abc x")
    expect(r.cursor).toBe("abc x".length)
  })
})
