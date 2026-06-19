import { describe, it, expect } from "vitest"
import { workingRowState } from "./AgentView"
import type { TranscriptBlock } from "../lib/agentTranscript"

/**
 * WS1 — the branded "working" row exists for ONE job: cover the DEAD-AIR gap between
 * submit and the turn's first sign of life. These tests exercise the pure decision
 * (`workingRowState`) directly under the dead-air-only contract: it shows IFF busy AND
 * we're still pre-content (no blocks, or the trailing block is the user's own message),
 * and suppresses the instant ANY content block lands as trailing — so it shows exactly
 * once per turn and can never flicker as the turn alternates prose↔tool.
 */

const user: TranscriptBlock = { kind: "user", id: "u", text: "hi" }
const tool: TranscriptBlock = {
  kind: "tool",
  id: "t",
  toolUseId: "tu",
  name: "Edit",
  input: {},
  status: "running",
}
const thinking: TranscriptBlock = { kind: "thinking", id: "th", text: "…" }
const assistant: TranscriptBlock = { kind: "assistant", id: "a", text: "answer" }
const result: TranscriptBlock = { kind: "result", id: "r", isError: false, text: "done" }

describe("WS1 — workingRowState (dead-air only)", () => {
  it("is null when NOT busy (regardless of blocks)", () => {
    expect(workingRowState([], false)).toBeNull()
    expect(workingRowState([user], false)).toBeNull()
    expect(workingRowState([user, tool], false)).toBeNull()
  })

  it("shows 'Thinking' on cold start: busy with no blocks yet", () => {
    expect(workingRowState([], true)).toEqual({ status: "Thinking" })
  })

  it("shows 'Thinking' right after submit: trailing block is the user's message", () => {
    expect(workingRowState([user], true)).toEqual({ status: "Thinking" })
  })

  it("SUPPRESSES the row once a tool call lands (trailing tool, no flicker)", () => {
    // Regression: a tool-using turn folds to a trailing TOOL block; the row must
    // stay hidden — the tool card is itself the activity signal.
    expect(workingRowState([user, tool], true)).toBeNull()
  })

  it("SUPPRESSES the row when the tool is tool-first in the turn", () => {
    expect(workingRowState([user, tool], true)).toBeNull()
  })

  it("SUPPRESSES the row once a thinking block lands", () => {
    expect(workingRowState([user, thinking], true)).toBeNull()
  })

  it("SUPPRESSES the row once assistant prose has started", () => {
    expect(workingRowState([user, assistant], true)).toBeNull()
  })

  it("SUPPRESSES the row on the alternating prose↔tool turn (trailing tool)", () => {
    // The defect the old test missed: every tool-using turn folds to
    // [user, assistant, tool] with a trailing TOOL block. The row MUST be null —
    // otherwise it double-signals beside the visible assistant prose and flickers
    // as the turn alternates prose↔tool.
    expect(workingRowState([user, assistant, tool], true)).toBeNull()
  })

  it("SUPPRESSES the row when a result block is present (turn complete)", () => {
    expect(workingRowState([user, result], true)).toBeNull()
  })
})
