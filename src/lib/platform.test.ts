import { describe, it, expect } from "vitest"
import { isMac, cmdOrCtrl, modKeyLabel } from "./platform"

// Minimal KeyboardEvent stub — only the two modifier fields matter.
function key(ctrl: boolean, meta: boolean): KeyboardEvent {
  return { ctrlKey: ctrl, metaKey: meta } as unknown as KeyboardEvent
}

describe("isMac", () => {
  it("returns true for darwin", () => expect(isMac("darwin")).toBe(true))
  it("returns false for win32", () => expect(isMac("win32")).toBe(false))
  it("returns false for linux", () => expect(isMac("linux")).toBe(false))
})

describe("cmdOrCtrl — darwin (metaKey)", () => {
  it("returns true when metaKey is pressed", () =>
    expect(cmdOrCtrl(key(false, true), "darwin")).toBe(true))
  it("returns false when only ctrlKey is pressed (Ctrl does NOT trigger on mac)", () =>
    expect(cmdOrCtrl(key(true, false), "darwin")).toBe(false))
  it("returns false when neither key is pressed", () =>
    expect(cmdOrCtrl(key(false, false), "darwin")).toBe(false))
})

describe("cmdOrCtrl — win32 (ctrlKey)", () => {
  it("returns true when ctrlKey is pressed", () =>
    expect(cmdOrCtrl(key(true, false), "win32")).toBe(true))
  it("returns false when only metaKey is pressed (Cmd does NOT trigger on win32)", () =>
    expect(cmdOrCtrl(key(false, true), "win32")).toBe(false))
  it("returns false when neither key is pressed", () =>
    expect(cmdOrCtrl(key(false, false), "win32")).toBe(false))
  it("returns EXACTLY e.ctrlKey — true case (win32 behavior is byte-identical)", () => {
    const e = key(true, false)
    expect(cmdOrCtrl(e, "win32")).toBe(e.ctrlKey)
  })
  it("returns EXACTLY e.ctrlKey — false case (win32 behavior is byte-identical)", () => {
    const e = key(false, false)
    expect(cmdOrCtrl(e, "win32")).toBe(e.ctrlKey)
  })
})

describe("cmdOrCtrl — linux (ctrlKey, same as win32)", () => {
  it("returns true when ctrlKey is pressed", () =>
    expect(cmdOrCtrl(key(true, false), "linux")).toBe(true))
  it("returns false when only metaKey is pressed", () =>
    expect(cmdOrCtrl(key(false, true), "linux")).toBe(false))
})

describe("modKeyLabel", () => {
  it("returns Cmd for darwin", () => expect(modKeyLabel("darwin")).toBe("Cmd"))
  it("returns Ctrl for win32", () => expect(modKeyLabel("win32")).toBe("Ctrl"))
  it("returns Ctrl for linux", () => expect(modKeyLabel("linux")).toBe("Ctrl"))
})
