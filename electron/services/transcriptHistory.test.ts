import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { parseTranscriptLine, readTranscriptEvents } from "./transcriptHistory"
import { encodeProjectDir } from "./terminals"
import { foldTranscript } from "../../src/lib/agentTranscript"
import {
  REAL_TRANSCRIPT_LINES,
  REAL_TRANSCRIPT_JSONL,
  SIDECHAIN_LINE,
  META_LINE,
  PARTIAL_LAST_LINE,
  FIXTURE_CC_ID,
  FIXTURE_CWD,
} from "./transcriptHistory.fixtures"

const [USER_TEXT, ASST_THINKING, ASST_TEXT, QUEUE_OP, ASST_TOOL_USE, USER_TOOL_RESULT] =
  REAL_TRANSCRIPT_LINES

describe("parseTranscriptLine", () => {
  it("maps a user text line to a user_message event", () => {
    expect(parseTranscriptLine(USER_TEXT)).toEqual([
      { kind: "user_message", text: "Please remember this number for the rest of our conversation: 42. Reply with just: noted." },
    ])
  })

  it("maps an assistant thinking block to a thinking_delta event", () => {
    expect(parseTranscriptLine(ASST_THINKING)).toEqual([
      { kind: "thinking_delta", text: "The user wants me to remember 42." },
    ])
  })

  it("maps an assistant text block to an assistant_delta event", () => {
    expect(parseTranscriptLine(ASST_TEXT)).toEqual([{ kind: "assistant_delta", text: "noted." }])
  })

  it("maps an assistant tool_use block to a tool_use event", () => {
    expect(parseTranscriptLine(ASST_TOOL_USE)).toEqual([
      {
        kind: "tool_use",
        id: "toolu_01R8hpnP5UDCM5z5uePHxhgF",
        name: "Write",
        input: {
          file_path: "C:/Users/ryguy/AppData/Local/Temp/bo10-live-ByCajV/should-not-exist.txt",
          content: "READY",
        },
      },
    ])
  })

  it("maps a user tool_result block to a tool_result event carrying isError", () => {
    expect(parseTranscriptLine(USER_TOOL_RESULT)).toEqual([
      {
        kind: "tool_result",
        toolUseId: "toolu_01R8hpnP5UDCM5z5uePHxhgF",
        content: "agent-exited",
        isError: true,
      },
    ])
  })

  it("drops metadata lines (queue-operation) instead of surfacing raw blocks", () => {
    expect(parseTranscriptLine(QUEUE_OP)).toEqual([])
  })

  it("drops sidechain (subagent) lines", () => {
    expect(parseTranscriptLine(SIDECHAIN_LINE)).toEqual([])
  })

  it("drops isMeta synthetic lines", () => {
    expect(parseTranscriptLine(META_LINE)).toEqual([])
  })

  it("tolerates a partial / non-JSON line without throwing", () => {
    expect(() => parseTranscriptLine(PARTIAL_LAST_LINE)).not.toThrow()
    expect(parseTranscriptLine(PARTIAL_LAST_LINE)).toEqual([])
    expect(parseTranscriptLine("")).toEqual([])
    expect(parseTranscriptLine("   ")).toEqual([])
  })

  it("maps a user line whose content is a bare string to a user_message", () => {
    const line = `{"type":"user","message":{"role":"user","content":"hello there"}}`
    expect(parseTranscriptLine(line)).toEqual([{ kind: "user_message", text: "hello there" }])
  })

  it("tolerates an on-disk result line (rare) -> result event", () => {
    const line = `{"type":"result","subtype":"success","is_error":false,"result":"done","usage":{"input_tokens":10,"output_tokens":5}}`
    expect(parseTranscriptLine(line)).toEqual([
      {
        kind: "result",
        subtype: "success",
        isError: false,
        result: "done",
        raw: { type: "result", subtype: "success", is_error: false, result: "done", usage: { input_tokens: 10, output_tokens: 5 } },
      },
    ])
  })
})

describe("readTranscriptEvents", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bo12-th-"))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeFixture(jsonl: string, ccId = FIXTURE_CC_ID, cwd = FIXTURE_CWD) {
    const dir = join(root, encodeProjectDir(cwd))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${ccId}.jsonl`), jsonl)
  }

  it("reads a real transcript and folds to the expected render blocks", () => {
    writeFixture(REAL_TRANSCRIPT_JSONL)
    const events = readTranscriptEvents(root, FIXTURE_CC_ID)
    const blocks = foldTranscript(events)

    // user → thinking → assistant("noted.") → tool(Write, settled error). The
    // metadata/sidechain/meta/partial lines contribute nothing.
    expect(blocks.map((b) => b.kind)).toEqual(["user", "thinking", "assistant", "tool"])
    expect(blocks[0]).toMatchObject({ kind: "user", text: /42/ })
    expect(blocks[2]).toMatchObject({ kind: "assistant", text: "noted." })
    // The Stop-aborted Write tool is SETTLED to error via its tool_result —
    // never left perpetually "running".
    expect(blocks[3]).toMatchObject({ kind: "tool", name: "Write", status: "error" })
  })

  it("does not throw on a partial last line", () => {
    writeFixture(REAL_TRANSCRIPT_JSONL)
    expect(() => readTranscriptEvents(root, FIXTURE_CC_ID)).not.toThrow()
  })

  it("locates the transcript by id across project dirs without a cwd hint", () => {
    writeFixture(REAL_TRANSCRIPT_JSONL, FIXTURE_CC_ID, "C:\\some\\other\\place")
    const events = readTranscriptEvents(root, FIXTURE_CC_ID)
    expect(events.length).toBeGreaterThan(0)
  })

  it("returns [] for a missing transcript", () => {
    expect(readTranscriptEvents(root, "does-not-exist")).toEqual([])
  })

  it("returns [] when the projects root itself is absent", () => {
    expect(readTranscriptEvents(join(root, "nope"), FIXTURE_CC_ID)).toEqual([])
  })
})
