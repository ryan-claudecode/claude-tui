import { describe, it, expect } from "vitest"
import {
  ASSISTANT_TEXT_DELTA,
  ASSISTANT_TOOL_USE,
  USER_TOOL_RESULT,
  THINKING_DELTA_WITH_TEXT,
  RESULT,
  RATE_LIMIT,
} from "../../electron/services/streamEvents.fixtures"
import type { StreamEvent } from "../../electron/services/streamProtocol"
import {
  foldTranscript,
  reduceTranscript,
  emptyTranscript,
  settleRunningTools,
  panelForBlock,
  expandLabelForBlock,
  modelErrorFromResult,
  type TranscriptBlock,
  type ToolBlock,
  type AssistantTextBlock,
  type ResultBlock,
  type UserBlock,
  type ModelErrorBlock,
  type NeedsAuthBlock,
} from "./agentTranscript"

/**
 * The reducer's input is a `StreamEvent[]` produced by the BO-1 parser. To keep
 * this test on the renderer side of the architecture boundary (src code must not
 * import the parser, which drags node-only modules), we derive the canonical
 * StreamEvent shapes from the REAL captured fixture LINES (the zero-dep fixtures
 * module) via plain JSON field access — so assertions ride real captured values
 * (ids, text, cost, tokens) without re-implementing the parser. The parser
 * itself is covered by BO-1's own tests.
 */
const FX = {
  assistantDelta: (() => {
    const d = JSON.parse(ASSISTANT_TEXT_DELTA)
    return { kind: "assistant_delta", text: d.event.delta.text } as StreamEvent
  })(),
  thinking: (() => {
    const d = JSON.parse(THINKING_DELTA_WITH_TEXT)
    return { kind: "thinking_delta", text: d.event.delta.thinking } as StreamEvent
  })(),
  toolUse: (() => {
    const block = JSON.parse(ASSISTANT_TOOL_USE).message.content[0]
    return { kind: "tool_use", id: block.id, name: block.name, input: block.input } as StreamEvent
  })(),
  toolResult: (() => {
    const block = JSON.parse(USER_TOOL_RESULT).message.content[0]
    return { kind: "tool_result", toolUseId: block.tool_use_id, content: block.content } as StreamEvent
  })(),
  result: (() => {
    const r = JSON.parse(RESULT)
    return { kind: "result", subtype: r.subtype, isError: r.is_error, result: r.result, raw: r } as StreamEvent
  })(),
  unknown: { kind: "unknown", raw: JSON.parse(RATE_LIMIT) } as StreamEvent,
}

describe("foldTranscript — assistant text coalescing", () => {
  it("merges consecutive assistant_delta into ONE growing text block", () => {
    const events: StreamEvent[] = [
      { kind: "assistant_delta", text: "Hello" },
      { kind: "assistant_delta", text: ", " },
      { kind: "assistant_delta", text: "world" },
    ]
    const blocks = foldTranscript(events)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe("assistant")
    expect((blocks[0] as AssistantTextBlock).text).toBe("Hello, world")
  })

  it("coalesces multi-delta from a REAL captured assistant_delta fixture", () => {
    const blocks = foldTranscript([FX.assistantDelta, FX.assistantDelta])
    expect(blocks).toHaveLength(1)
    expect((blocks[0] as AssistantTextBlock).text).toBe(
      "I'll find the echo MCP tool first.I'll find the echo MCP tool first.",
    )
  })

  it("keeps a STABLE block id across deltas and text == in-order concatenation", () => {
    let state = emptyTranscript()
    state = reduceTranscript(state, { kind: "assistant_delta", text: "a" })
    const firstId = state.blocks[0].id
    state = reduceTranscript(state, { kind: "assistant_delta", text: "b" })
    state = reduceTranscript(state, { kind: "assistant_delta", text: "c" })
    expect(state.blocks).toHaveLength(1)
    expect(state.blocks[0].id).toBe(firstId)
    expect((state.blocks[0] as AssistantTextBlock).text).toBe("abc")
  })

  it("starts a NEW assistant block after an interrupting block (settled text keeps its id)", () => {
    const events: StreamEvent[] = [
      { kind: "assistant_delta", text: "before tool" },
      { kind: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      { kind: "assistant_delta", text: "after tool" },
    ]
    const blocks = foldTranscript(events)
    expect(blocks.map((b) => b.kind)).toEqual(["assistant", "tool", "assistant"])
    expect((blocks[0] as AssistantTextBlock).text).toBe("before tool")
    expect((blocks[2] as AssistantTextBlock).text).toBe("after tool")
    expect(blocks[0].id).not.toBe(blocks[2].id)
  })
})

describe("foldTranscript — tool correlation", () => {
  it("merges a tool_use + its later tool_result by id into ONE tool block (real fixtures)", () => {
    const blocks = foldTranscript([FX.toolUse, FX.toolResult])
    expect(blocks).toHaveLength(1)
    const tool = blocks[0] as ToolBlock
    expect(tool.kind).toBe("tool")
    expect(tool.name).toBe("ToolSearch")
    expect(tool.toolUseId).toBe("toolu_01Gq29CunqooAUkvro9BcfSC")
    expect(tool.status).toBe("done")
    expect(tool.result).toBeDefined()
  })

  it("a tool_use is 'running' until its result arrives", () => {
    const blocks = foldTranscript([FX.toolUse])
    expect((blocks[0] as ToolBlock).status).toBe("running")
  })

  it("flips status to 'error' when the tool_result is an error", () => {
    const events: StreamEvent[] = [
      { kind: "tool_use", id: "t1", name: "Bash", input: {} },
      { kind: "tool_result", toolUseId: "t1", content: "boom", isError: true },
    ]
    const tool = foldTranscript(events)[0] as ToolBlock
    expect(tool.status).toBe("error")
    expect(tool.isError).toBe(true)
  })

  it("handles an interleaved second tool_use (two independent tool blocks)", () => {
    const events: StreamEvent[] = [
      { kind: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
      { kind: "tool_use", id: "t2", name: "Read", input: { file_path: "b.ts" } },
      { kind: "tool_result", toolUseId: "t2", content: "B" },
      { kind: "tool_result", toolUseId: "t1", content: "A" },
    ]
    const blocks = foldTranscript(events)
    expect(blocks).toHaveLength(2)
    const [first, second] = blocks as ToolBlock[]
    expect(first.toolUseId).toBe("t1")
    expect(first.status).toBe("done")
    expect(first.result).toBe("A")
    expect(second.toolUseId).toBe("t2")
    expect(second.status).toBe("done")
    expect(second.result).toBe("B")
  })

  it("an orphan tool_result (no matching tool_use) becomes a raw block, never throws", () => {
    const blocks = foldTranscript([{ kind: "tool_result", toolUseId: "ghost", content: "x" }])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe("raw")
  })
})

/** Fold events into the FULL TranscriptState (foldTranscript returns only blocks). */
const foldTranscriptState = (events: StreamEvent[]) =>
  events.reduce(reduceTranscript, emptyTranscript())

describe("BO-12 settleRunningTools — rehydrated history has no dangling running tool", () => {
  it("settles a trailing running tool block to error (interrupted turn)", () => {
    const state = reduceTranscript(emptyTranscript(), {
      kind: "tool_use",
      id: "t1",
      name: "Write",
      input: {},
    })
    expect((state.blocks[0] as ToolBlock).status).toBe("running")

    const settled = settleRunningTools(state)
    const tool = settled.blocks[0] as ToolBlock
    expect(tool.status).toBe("error")
    expect(tool.isError).toBe(true)
  })

  it("preserves a tool already settled (done/error) and the seq counter", () => {
    const state = foldTranscriptState([
      { kind: "tool_use", id: "t1", name: "Read", input: {} },
      { kind: "tool_result", toolUseId: "t1", content: "ok" },
    ])
    const settled = settleRunningTools(state)
    expect((settled.blocks[0] as ToolBlock).status).toBe("done")
    expect(settled.seq).toBe(state.seq)
  })

  it("returns the SAME state object when nothing is running (no needless rerender)", () => {
    const state = foldTranscriptState([{ kind: "assistant_delta", text: "hi" }])
    expect(settleRunningTools(state)).toBe(state)
  })

  it("does not touch non-tool blocks", () => {
    const state = foldTranscriptState([{ kind: "assistant_delta", text: "hello" }])
    const settled = settleRunningTools(state)
    expect(settled.blocks[0]).toMatchObject({ kind: "assistant", text: "hello" })
  })
})

describe("foldTranscript — thinking, result, error, raw", () => {
  it("emits a distinct thinking block from a real thinking_delta fixture", () => {
    const blocks = foldTranscript([FX.thinking])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe("thinking")
  })

  it("does not let thinking corrupt adjacent assistant text", () => {
    const events: StreamEvent[] = [
      { kind: "thinking_delta", text: "pondering" },
      { kind: "assistant_delta", text: "answer" },
    ]
    const blocks = foldTranscript(events)
    expect(blocks.map((b) => b.kind)).toEqual(["thinking", "assistant"])
    expect((blocks[1] as AssistantTextBlock).text).toBe("answer")
  })

  it("surfaces token / cost / duration from a real result fixture", () => {
    const blocks = foldTranscript([FX.result])
    expect(blocks).toHaveLength(1)
    const r = blocks[0] as ResultBlock
    expect(r.kind).toBe("result")
    expect(r.isError).toBe(false)
    expect(r.cost?.costUsd).toBeCloseTo(0.18570375, 6)
    expect(r.cost?.durationMs).toBe(1470)
    expect(r.cost?.inputTokens).toBe(8647)
    expect(r.cost?.outputTokens).toBe(4)
    // BO-4a (punch-list f): the total bills ALL token classes, not just in+out.
    // Real fixture: input 8647 + output 4 + cache_creation 22779 + cache_read 0.
    expect(r.cost?.cacheCreationTokens).toBe(22779)
    expect(r.cost?.cacheReadTokens).toBe(0)
    expect(r.cost?.totalTokens).toBe(31430)
  })

  it("renders needs_auth as a DISTINCT actionable block (CAPP-39), not a bare error or a drop", () => {
    const blocks = foldTranscript([{ kind: "needs_auth", message: "Not logged in · Please run /login" }])
    expect(blocks).toHaveLength(1)
    // Distinct from a generic ErrorBlock — AgentView renders the Sign-in CTA off this.
    expect(blocks[0].kind).toBe("needs_auth")
    expect((blocks[0] as NeedsAuthBlock).message).toBe("Not logged in · Please run /login")
  })

  it("needs_auth falls back to a default message when none is provided", () => {
    const blocks = foldTranscript([{ kind: "needs_auth" }])
    expect(blocks[0].kind).toBe("needs_auth")
    expect((blocks[0] as NeedsAuthBlock).message).toBe("Authentication required.")
  })

  it("coalesces consecutive needs_auth into ONE banner (assistant + result both signal)", () => {
    // A single live auth failure emits BOTH an assistant (error:auth_failed) and a
    // result (is_error + 'Not logged in') → two needs_auth events. The user should
    // see ONE Sign-in banner, not two stacked identical ones.
    const blocks = foldTranscript([
      { kind: "needs_auth", message: "Not logged in · Please run /login" },
      { kind: "needs_auth", message: "Not logged in · Please run /login" },
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe("needs_auth")
  })

  it("an unknown variant (real rate_limit fixture) renders as a raw block and never throws", () => {
    expect(() => foldTranscript([FX.unknown])).not.toThrow()
    const blocks = foldTranscript([FX.unknown])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe("raw")
  })

  it("ignores the init event (metadata, not a render block)", () => {
    const blocks = foldTranscript([{ kind: "init", raw: {} }])
    expect(blocks).toHaveLength(0)
  })

  it("never throws on an empty stream", () => {
    expect(foldTranscript([])).toEqual([])
  })
})

describe("CAPP-39 gate ② — auth-result coalescing is gated on a preceding banner", () => {
  // The genuine end-to-end auth failure: the live stream emits the
  // `authentication_failed` assistant FIRST (→ needs_auth), then a trailing
  // is_error result whose prose echoes "Not logged in". The reducer must coalesce
  // the result INTO the banner so the user sees EXACTLY ONE Sign-in banner.
  it("genuine auth failure (needs_auth then trailing is_error result) → EXACTLY ONE Sign-in banner", () => {
    const blocks = foldTranscript([
      { kind: "needs_auth", message: "Not logged in · Please run /login" },
      { kind: "result", isError: true, subtype: "success", result: "Not logged in · Please run /login", raw: {} },
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe("needs_auth")
    expect((blocks[0] as NeedsAuthBlock).message).toBe("Not logged in · Please run /login")
  })

  // The false-positive the review caught: a HEALTHY authenticated turn that errors
  // for a NON-auth reason (error_during_execution / error_max_turns) whose final
  // result prose merely MENTIONS an auth phrase (the model debugging a 401, a
  // failing auth test, a `gh` CLI message). With NO preceding needs_auth banner it
  // must render as the REAL result block — never needs_auth — and its genuine error
  // must NOT be swallowed.
  it("REGRESSION: an is_error result with auth-mentioning prose and NO preceding banner renders as a result, NOT needs_auth", () => {
    const blocks = foldTranscript([
      { kind: "user_message", text: "make the auth test pass" },
      { kind: "assistant_delta", text: "Investigating the failing test…" },
      {
        kind: "result",
        isError: true,
        subtype: "error_during_execution",
        result: "The gh CLI reports you are not logged in",
        raw: {},
      },
    ])
    expect(blocks.some((b) => b.kind === "needs_auth")).toBe(false)
    const result = blocks[blocks.length - 1] as ResultBlock
    expect(result.kind).toBe("result")
    expect(result.isError).toBe(true)
    expect(result.subtype).toBe("error_during_execution")
    // The genuine error prose is preserved (not swallowed): no assistant text
    // echoes it, so the result keeps its text.
    expect(result.text).toBe("The gh CLI reports you are not logged in")
  })

  it("REGRESSION: a healthy auth-mentioning errored result does NOT coalesce into an EARLIER, unrelated needs_auth", () => {
    // Only the IMMEDIATELY preceding block being a banner gates coalescing. An
    // errored result that follows other content (here: an assistant turn) is its
    // own block even if an auth banner appeared earlier in the conversation.
    const blocks = foldTranscript([
      { kind: "needs_auth", message: "Not logged in · Please run /login" },
      { kind: "user_message", text: "I signed in, retry" },
      { kind: "assistant_delta", text: "Retrying…" },
      { kind: "result", isError: true, result: "Please run /login again — still not logged in", raw: {} },
    ])
    // The banner is preserved; the later errored result is its OWN result block.
    expect(blocks.filter((b) => b.kind === "needs_auth")).toHaveLength(1)
    expect(blocks[blocks.length - 1].kind).toBe("result")
  })
})

describe("BO-4b — user message echo + result de-duplication", () => {
  it("renders a user_message as its own user block (the user's side of the chat)", () => {
    const blocks = foldTranscript([{ kind: "user_message", text: "fix the bug" }])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe("user")
    expect((blocks[0] as UserBlock).text).toBe("fix the bug")
  })

  it("keeps user + assistant as distinct, ordered blocks (a two-sided conversation)", () => {
    const blocks = foldTranscript([
      { kind: "user_message", text: "hi" },
      { kind: "assistant_delta", text: "hello there" },
    ])
    expect(blocks.map((b) => b.kind)).toEqual(["user", "assistant"])
  })

  it("does NOT show the reply twice: a result echoing the last assistant text drops its text", () => {
    const blocks = foldTranscript([
      { kind: "assistant_delta", text: "The answer is 42." },
      { kind: "result", isError: false, result: "The answer is 42.", raw: {} },
    ])
    expect(blocks.map((b) => b.kind)).toEqual(["assistant", "result"])
    // Assistant prose shows once; the result keeps only its footer (no echoed text).
    expect((blocks[1] as ResultBlock).text).toBeUndefined()
  })

  it("keeps result text when there is no assistant prose to duplicate (tool-only / silent turn)", () => {
    const blocks = foldTranscript([
      { kind: "result", isError: false, result: "Done — no narration.", raw: {} },
    ])
    expect((blocks[0] as ResultBlock).text).toBe("Done — no narration.")
  })
})

describe("panelForBlock — click-to-expand routing", () => {
  it("routes an Edit tool to the diff panel with old/new content", () => {
    const tool: ToolBlock = {
      kind: "tool",
      id: "b0",
      toolUseId: "t1",
      name: "Edit",
      input: { file_path: "x.ts", old_string: "foo", new_string: "bar" },
      status: "done",
    }
    const req = panelForBlock(tool)
    expect(req?.type).toBe("diff")
    const files = (req?.props as { files: Array<Record<string, unknown>> }).files
    expect(files[0]).toMatchObject({ path: "x.ts", oldContent: "foo", newContent: "bar" })
  })

  it("routes a Write tool to the diff panel as all-additions", () => {
    const tool: ToolBlock = {
      kind: "tool",
      id: "b0",
      toolUseId: "t1",
      name: "Write",
      input: { file_path: "n.ts", content: "hello" },
      status: "done",
    }
    const req = panelForBlock(tool)
    expect(req?.type).toBe("diff")
    const files = (req?.props as { files: Array<Record<string, unknown>> }).files
    expect(files[0]).toMatchObject({ path: "n.ts", newContent: "hello" })
  })

  it("routes a generic tool to markdown and a raw block to the code panel", () => {
    const tool: ToolBlock = {
      kind: "tool",
      id: "b0",
      toolUseId: "t1",
      name: "Bash",
      input: { command: "ls" },
      status: "done",
    }
    expect(panelForBlock(tool)?.type).toBe("markdown")
    expect(panelForBlock({ kind: "raw", id: "b1", raw: { a: 1 } })?.type).toBe("code")
  })

  it("routes assistant text to the markdown panel", () => {
    const req = panelForBlock({ kind: "assistant", id: "b0", text: "# hi" })
    expect(req?.type).toBe("markdown")
    expect((req?.props as { content: string }).content).toBe("# hi")
  })
})

// ---------------------------------------------------------------------------
// CAPP-111 (S4) — expandLabelForBlock drift-pin: the per-block expand button is
// rendered IFF a block has a detail view, so the helper must be in lockstep with
// panelForBlock across EVERY block kind. This is the standing guard against the two
// drifting (a kind growing a panel but no button, or a button with no panel).
// ---------------------------------------------------------------------------
describe("expandLabelForBlock — parity with panelForBlock (drift-pin)", () => {
  // One representative block per TranscriptBlock kind. The 4 with a detail view
  // (assistant/tool/result/raw) get a label; the 5 without (user/thinking/error/
  // model_error/needs_auth) get null — nothing regresses on them (they never had
  // click-to-open).
  const samples: TranscriptBlock[] = [
    { kind: "user", id: "b", text: "hi" },
    { kind: "assistant", id: "b", text: "# hi" },
    { kind: "thinking", id: "b", text: "hmm" },
    { kind: "tool", id: "b", toolUseId: "t", name: "Edit", input: { file_path: "x.ts" }, status: "done" },
    { kind: "tool", id: "b", toolUseId: "t", name: "Bash", input: { command: "ls" }, status: "done" },
    { kind: "error", id: "b", message: "boom" },
    { kind: "result", id: "b", isError: false, text: "done" },
    { kind: "model_error", id: "b", message: "model x unavailable" },
    { kind: "needs_auth", id: "b", message: "Not logged in" },
    { kind: "raw", id: "b", raw: { a: 1 } },
  ]

  it("returns a label EXACTLY when panelForBlock returns a request (iff), per kind", () => {
    for (const block of samples) {
      const hasPanel = panelForBlock(block) != null
      const ex = expandLabelForBlock(block)
      expect(
        (ex != null) === hasPanel,
        `kind ${block.kind}: expandLabelForBlock ${ex ? "labelled" : "null"} but panelForBlock ${hasPanel ? "has" : "no"} panel`,
      ).toBe(true)
      // When a label exists it must be a non-empty string (carried on title/aria-label).
      if (ex) expect(ex.label.length).toBeGreaterThan(0)
    }
  })

  it("returns the 4 expected detail-view kinds and NO others", () => {
    const labelled = samples.filter((b) => expandLabelForBlock(b) != null).map((b) => b.kind)
    expect(new Set(labelled)).toEqual(new Set(["assistant", "tool", "result", "raw"]))
  })

  it("marks the dense rows (tool/raw) compact and the prose blocks (assistant/result) non-compact", () => {
    expect(expandLabelForBlock({ kind: "tool", id: "b", toolUseId: "t", name: "Bash", input: {}, status: "done" })?.compact).toBe(true)
    expect(expandLabelForBlock({ kind: "raw", id: "b", raw: {} })?.compact).toBe(true)
    expect(expandLabelForBlock({ kind: "assistant", id: "b", text: "" })?.compact).toBe(false)
    expect(expandLabelForBlock({ kind: "result", id: "b", isError: false })?.compact).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// BO-6 — a model-unavailability failure renders the distinct, actionable banner
// (model_error block), NOT the bare "Turn failed" result.
// ---------------------------------------------------------------------------

describe("BO-6 model-unavailable error", () => {
  // The exact shape the disablement produced: an errored result whose text names
  // the model + reads as unavailable, carrying an api 404 status.
  const modelDisabled: StreamEvent = {
    kind: "result",
    subtype: "error_during_execution",
    isError: true,
    result:
      "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access.",
    raw: {
      type: "result",
      is_error: true,
      api_error_status: 404,
      result:
        "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access.",
    },
  } as StreamEvent

  it("folds a model-404 result into a model_error block (NOT a result/'Turn failed')", () => {
    const blocks = foldTranscript([modelDisabled])
    expect(blocks).toHaveLength(1)
    const b = blocks[0] as ModelErrorBlock
    expect(b.kind).toBe("model_error")
    expect(b.model).toBe("claude-fable-5")
    expect(b.message).toContain("claude-fable-5")
    // It is explicitly NOT rendered as a result block.
    expect(blocks.some((x) => x.kind === "result")).toBe(false)
  })

  it("detects the model error via unavailability phrasing even without a 404 status", () => {
    const noStatus: StreamEvent = {
      kind: "result",
      isError: true,
      result: "The selected model (claude-opus-9) is unavailable.",
      raw: { is_error: true, result: "The selected model (claude-opus-9) is unavailable." },
    } as StreamEvent
    const hit = modelErrorFromResult(noStatus)
    expect(hit).not.toBeNull()
    expect(hit!.model).toBe("claude-opus-9")
  })

  it("a GENERIC error result is unaffected — still a normal result block ('Turn failed')", () => {
    const generic: StreamEvent = {
      kind: "result",
      subtype: "error_during_execution",
      isError: true,
      result: "Something went wrong while running the tool.",
      raw: { is_error: true, result: "Something went wrong while running the tool." },
    } as StreamEvent
    expect(modelErrorFromResult(generic)).toBeNull()
    const blocks = foldTranscript([generic])
    expect(blocks).toHaveLength(1)
    const b = blocks[0] as ResultBlock
    expect(b.kind).toBe("result")
    expect(b.isError).toBe(true)
  })

  it("modelErrorFromResult returns null for non-result / non-error events", () => {
    expect(modelErrorFromResult({ kind: "assistant_delta", text: "model" } as StreamEvent)).toBeNull()
    expect(
      modelErrorFromResult({
        kind: "result",
        isError: false,
        result: "the model finished",
        raw: {},
      } as StreamEvent),
    ).toBeNull()
  })
})
