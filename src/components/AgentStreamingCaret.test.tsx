import { describe, it, expect } from "vitest"
import { streamingCaretId } from "./AgentView"
import type { TranscriptBlock } from "../lib/agentTranscript"

/**
 * WS5 — the STREAMING CARET marks the live-typing position at the end of the
 * trailing assistant block WHILE its turn streams. These tests exercise the pure
 * decision (`streamingCaretId`) directly: it returns the trailing assistant block's
 * id IFF busy AND that block is trailing, and `null` the instant the block settles
 * (a tool/result/error appends after it) or the turn ends (busy false) — mirroring
 * the dead-air working-row contract so the two never both fire on the same block.
 */

const user: TranscriptBlock = { kind: "user", id: "u", text: "hi" }
const assistant: TranscriptBlock = { kind: "assistant", id: "a", text: "answer" }
const assistant2: TranscriptBlock = { kind: "assistant", id: "a2", text: "more" }
const tool: TranscriptBlock = {
  kind: "tool",
  id: "t",
  toolUseId: "tu",
  name: "Edit",
  input: {},
  status: "running",
}
const result: TranscriptBlock = { kind: "result", id: "r", isError: false, text: "done" }
const error: TranscriptBlock = { kind: "error", id: "e", message: "boom" }

describe("WS5 — streamingCaretId", () => {
  it("is null when NOT busy (regardless of blocks)", () => {
    expect(streamingCaretId([], false)).toBeNull()
    expect(streamingCaretId([user, assistant], false)).toBeNull()
  })

  it("is null in the dead-air gap (no blocks / trailing user message)", () => {
    // The working row owns this gap; the caret only shows once prose streams.
    expect(streamingCaretId([], true)).toBeNull()
    expect(streamingCaretId([user], true)).toBeNull()
  })

  it("returns the trailing assistant block id while it streams", () => {
    expect(streamingCaretId([user, assistant], true)).toBe("a")
  })

  it("tracks the LATEST assistant block when a turn has several", () => {
    expect(streamingCaretId([user, assistant, tool, assistant2], true)).toBe("a2")
  })

  it("clears the instant a tool block appends after the assistant", () => {
    expect(streamingCaretId([user, assistant, tool], true)).toBeNull()
  })

  it("clears once the turn completes (trailing result block)", () => {
    expect(streamingCaretId([user, assistant, result], true)).toBeNull()
  })

  it("clears when an error block trails the assistant", () => {
    expect(streamingCaretId([user, assistant, error], true)).toBeNull()
  })

  it("clears the moment busy flips false even with a trailing assistant", () => {
    // Turn end: busy drops to false; the caret must vanish immediately.
    expect(streamingCaretId([user, assistant], false)).toBeNull()
  })
})
