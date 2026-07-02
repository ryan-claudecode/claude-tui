import { describe, it, expect } from "vitest"
import {
  HOLD_THRESHOLD_MS,
  MAX_RECORDING_MS,
  micPointerDownAction,
  micPointerUpAction,
  micPointerCancelAction,
  isDictationShortcut,
  escapePrecedence,
  recordingTick,
} from "./micInteraction"

/**
 * CAPP-120 (review finding 10) — the mic's interaction decisions, tested exhaustively as
 * pure logic (hold-vs-click, pointercancel, the Esc precedence, the Ctrl+M guard, the
 * recording cap). The composer is a thin executor over these.
 */

describe("micInteraction — pointer down", () => {
  it("primary press while ready arms the hold-vs-click decision", () => {
    expect(micPointerDownAction({ status: "ready", primaryButton: true })).toBe("arm")
  })
  it("primary press while NOT ready opens the setup/download flow", () => {
    expect(micPointerDownAction({ status: "not-downloaded", primaryButton: true })).toBe("open-setup")
    expect(micPointerDownAction({ status: "downloading", primaryButton: true })).toBe("open-setup")
    expect(micPointerDownAction({ status: "error", primaryButton: true })).toBe("open-setup")
  })
  it("non-primary buttons are ignored in every status", () => {
    expect(micPointerDownAction({ status: "ready", primaryButton: false })).toBe("none")
    expect(micPointerDownAction({ status: "error", primaryButton: false })).toBe("none")
  })
})

describe("micInteraction — pointer up (hold vs click)", () => {
  it("armed + held (past the threshold) → push-to-talk release: stop + transcribe", () => {
    expect(micPointerUpAction({ armed: true, held: true, primaryButton: true })).toBe("stop-transcribe")
  })
  it("armed + NOT held (quick click) → toggle", () => {
    expect(micPointerUpAction({ armed: true, held: false, primaryButton: true })).toBe("toggle")
  })
  it("un-armed up (open-setup press, stray up, or an already-finished press) → none", () => {
    expect(micPointerUpAction({ armed: false, held: false, primaryButton: true })).toBe("none")
    expect(micPointerUpAction({ armed: false, held: true, primaryButton: true })).toBe("none")
  })
  it("non-primary release → none", () => {
    expect(micPointerUpAction({ armed: true, held: true, primaryButton: false })).toBe("none")
  })
})

describe("micInteraction — pointer cancel (finding 8: never leave the mic hot)", () => {
  it("cancel AFTER the hold elapsed takes the SAME stop path as pointerup", () => {
    expect(micPointerCancelAction({ armed: true, held: true })).toBe("stop-transcribe")
  })
  it("cancel BEFORE the hold elapsed just disarms (never toggles a cancelled click)", () => {
    expect(micPointerCancelAction({ armed: true, held: false })).toBe("none")
  })
  it("un-armed cancel (e.g. the duplicate lostpointercapture after our own release) → none", () => {
    expect(micPointerCancelAction({ armed: false, held: true })).toBe("none")
    expect(micPointerCancelAction({ armed: false, held: false })).toBe("none")
  })
})

describe("micInteraction — Ctrl+M shortcut guard", () => {
  const key = (over: Partial<Parameters<typeof isDictationShortcut>[0]>) =>
    isDictationShortcut({ key: "m", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over })

  it("matches Ctrl+M and Cmd+M (either case)", () => {
    expect(key({ ctrlKey: true })).toBe(true)
    expect(key({ metaKey: true })).toBe(true)
    expect(key({ ctrlKey: true, key: "M" })).toBe(true)
  })
  it("rejects chords with Shift or Alt, plain m, and other keys", () => {
    expect(key({ ctrlKey: true, shiftKey: true })).toBe(false)
    expect(key({ ctrlKey: true, altKey: true })).toBe(false)
    expect(key({})).toBe(false)
    expect(key({ ctrlKey: true, key: "n" })).toBe(false)
  })
})

describe("micInteraction — Esc precedence (finding 2, MAJOR)", () => {
  it("an active recording owns Esc EVEN when the busy-terminal interrupt is available", () => {
    expect(escapePrecedence({ recordingActive: true, interruptAvailable: true })).toBe("discard-recording")
    expect(escapePrecedence({ recordingActive: true, interruptAvailable: false })).toBe("discard-recording")
  })
  it("no recording → the interrupt (when available), else none", () => {
    expect(escapePrecedence({ recordingActive: false, interruptAvailable: true })).toBe("interrupt")
    expect(escapePrecedence({ recordingActive: false, interruptAvailable: false })).toBe("none")
  })
})

describe("micInteraction — recording clock + cap (finding 4)", () => {
  it("reports whole elapsed seconds, not capped below the limit", () => {
    expect(recordingTick(1000, 1000)).toEqual({ elapsedSec: 0, capped: false })
    expect(recordingTick(1000, 4200)).toEqual({ elapsedSec: 3, capped: false })
  })
  it("caps exactly AT the limit and beyond", () => {
    expect(recordingTick(0, MAX_RECORDING_MS).capped).toBe(true)
    expect(recordingTick(0, MAX_RECORDING_MS + 1).capped).toBe(true)
    expect(recordingTick(0, MAX_RECORDING_MS - 1).capped).toBe(false)
  })
  it("honors a custom max and clamps a negative clock skew", () => {
    expect(recordingTick(0, 50, 50)).toEqual({ elapsedSec: 0, capped: true })
    expect(recordingTick(1000, 500)).toEqual({ elapsedSec: 0, capped: false })
  })
  it("the constants are sane (hold < 1s, cap = 5 min)", () => {
    expect(HOLD_THRESHOLD_MS).toBe(350)
    expect(MAX_RECORDING_MS).toBe(5 * 60_000)
  })
})
