import { describe, it, expect } from "vitest"
import {
  buildQuestionSubmit,
  buildQuestionCancel,
  parseQuestionAnswer,
  normalizeQuestionOptions,
} from "./questionSubmit"

/**
 * CAPP-107 (review MINOR 1) — the QuestionForm↔ask_user payload contract round-trip.
 * The component submits via buildQuestionSubmit/buildQuestionCancel and the tool
 * parses via parseQuestionAnswer — all from THIS module, so this suite pins the
 * whole cross-process contract: rename a key on either side and these fail.
 */

describe("questionSubmit — build → parse round-trip", () => {
  it("selected option + free text round-trip verbatim", () => {
    expect(parseQuestionAnswer(buildQuestionSubmit(["Yes"], "extra"))).toEqual({
      answer: "Yes, extra",
      selected: ["Yes"],
      free_text: "extra",
    })
  })

  it("multi-select round-trips all labels in order", () => {
    expect(parseQuestionAnswer(buildQuestionSubmit(["api", "db"], ""))).toEqual({
      answer: "api, db",
      selected: ["api", "db"],
      free_text: undefined,
    })
  })

  it("free-text-only round-trips (trimmed)", () => {
    expect(parseQuestionAnswer(buildQuestionSubmit([], "  Nimbus  "))).toEqual({
      answer: "Nimbus",
      selected: [],
      free_text: "Nimbus",
    })
  })

  it("the cancelled shape round-trips", () => {
    expect(parseQuestionAnswer(buildQuestionCancel())).toEqual({ cancelled: true })
    // PanelService's own close paths resolve the same shape — parse handles it too.
    expect(parseQuestionAnswer({ cancelled: true })).toEqual({ cancelled: true })
  })

  it("parse is defensive against a malformed payload", () => {
    expect(parseQuestionAnswer({})).toEqual({ answer: "", selected: [], free_text: undefined })
    expect(parseQuestionAnswer({ options: [1, "ok", null], text: 7 } as any)).toEqual({
      answer: "ok",
      selected: ["ok"],
      free_text: undefined,
    })
  })
})

describe("normalizeQuestionOptions — NIT 2 dedupe", () => {
  it("de-duplicates preserving first-occurrence order", () => {
    expect(normalizeQuestionOptions(["Yes", "No", "Yes", "Maybe", "No"])).toEqual([
      "Yes",
      "No",
      "Maybe",
    ])
  })

  it("collapses to undefined when fewer than 2 unique options remain", () => {
    expect(normalizeQuestionOptions(["Yes", "Yes"])).toBeUndefined()
    expect(normalizeQuestionOptions(["only"])).toBeUndefined()
    expect(normalizeQuestionOptions([])).toBeUndefined()
    expect(normalizeQuestionOptions(undefined)).toBeUndefined()
  })

  it("leaves an already-unique list untouched", () => {
    expect(normalizeQuestionOptions(["a", "b", "c"])).toEqual(["a", "b", "c"])
  })
})
