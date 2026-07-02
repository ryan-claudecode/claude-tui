import { describe, it, expect } from "vitest"
import { registerDictationEscHandler, dispatchDictationEsc } from "./dictationEsc"

/**
 * CAPP-120 (review finding 2, MAJOR) — the Esc-discard registry App.tsx consults BEFORE
 * the busy-terminal interrupt. Handlers are module-global, so every test unregisters what
 * it registers (the returned disposer) to stay isolated.
 */
describe("dictationEsc registry", () => {
  it("no handlers → false (Esc falls through to the interrupt)", () => {
    expect(dispatchDictationEsc()).toBe(false)
  })

  it("a handler with nothing recording → false", () => {
    const off = registerDictationEscHandler(() => false)
    try {
      expect(dispatchDictationEsc()).toBe(false)
    } finally {
      off()
    }
  })

  it("one of several handlers discarding → true (split panes register two)", () => {
    let discarded = 0
    const off1 = registerDictationEscHandler(() => false)
    const off2 = registerDictationEscHandler(() => {
      discarded++
      return true
    })
    try {
      expect(dispatchDictationEsc()).toBe(true)
      expect(discarded).toBe(1)
    } finally {
      off1()
      off2()
    }
  })

  it("unregistering removes the handler", () => {
    const off = registerDictationEscHandler(() => true)
    off()
    expect(dispatchDictationEsc()).toBe(false)
  })

  it("a throwing handler never shadows a discarding sibling", () => {
    const off1 = registerDictationEscHandler(() => {
      throw new Error("boom")
    })
    const off2 = registerDictationEscHandler(() => true)
    try {
      expect(dispatchDictationEsc()).toBe(true)
    } finally {
      off1()
      off2()
    }
  })
})
