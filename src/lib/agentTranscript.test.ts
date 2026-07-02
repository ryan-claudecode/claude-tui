import { describe, it, expect } from "vitest"
import {
  ASSISTANT_TEXT_DELTA,
  ASSISTANT_TOOL_USE,
  USER_TOOL_RESULT,
  THINKING_DELTA_WITH_TEXT,
  RESULT,
  RATE_LIMIT,
} from "../../electron/services/streamEvents.fixtures"
// The canned fake reply (CAPP-119 review finding 4 — the e2e↔gate linking pin).
// Import-safe from a src test: fakeStream's only ./terminals import is type-only.
import { REPLY_TEXT } from "../../electron/services/fakeStream"
import type { StreamEvent } from "../../electron/services/streamProtocol"
import {
  foldTranscript,
  reduceTranscript,
  emptyTranscript,
  settleRunningTools,
  panelForBlock,
  expandLabelForBlock,
  assistantExpandUseful,
  ASSISTANT_EXPAND_MIN_CHARS,
  classifyInjectedUserContent,
  INJECTED_CLASSIFY_MAX_CHARS,
  INJECTED_CLOSE_SCAN_WINDOW,
  modelErrorFromResult,
  type TranscriptBlock,
  type ToolBlock,
  type AssistantTextBlock,
  type ResultBlock,
  type UserBlock,
  type InjectedBlock,
  type InjectedSegment,
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
    { kind: "injected", id: "b", wrapper: "system-reminder", label: "system reminder", raw: "<system-reminder>x</system-reminder>" },
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

  it("returns the 5 expected detail-view kinds and NO others", () => {
    const labelled = samples.filter((b) => expandLabelForBlock(b) != null).map((b) => b.kind)
    // CAPP-118 — `injected` joins the detail-view kinds (its raw wrapper text opens).
    expect(new Set(labelled)).toEqual(new Set(["assistant", "tool", "result", "raw", "injected"]))
  })

  // Exhaustiveness tie to the union (CAPP-111 review nit): a Record keyed by the
  // FULL TranscriptBlock["kind"] union — the compiler errors if a kind is missing or
  // unknown, so a newly added 10th kind can't silently dodge the drift-pin. The test
  // then forces that kind into `samples` too.
  const KIND_COVERAGE: Record<TranscriptBlock["kind"], true> = {
    user: true, assistant: true, thinking: true, tool: true, error: true,
    result: true, model_error: true, needs_auth: true, injected: true, raw: true,
  }
  it("samples cover EVERY TranscriptBlock kind (so no kind dodges the drift-pin)", () => {
    const sampled = new Set(samples.map((b) => b.kind))
    for (const kind of Object.keys(KIND_COVERAGE) as Array<TranscriptBlock["kind"]>) {
      expect(sampled.has(kind), `kind ${kind} missing from drift-pin samples`).toBe(true)
    }
  })

  it("marks every block's expand button compact (icon-only ⤢; CAPP-111 review)", () => {
    expect(expandLabelForBlock({ kind: "tool", id: "b", toolUseId: "t", name: "Bash", input: {}, status: "done" })?.compact).toBe(true)
    expect(expandLabelForBlock({ kind: "raw", id: "b", raw: {} })?.compact).toBe(true)
    expect(expandLabelForBlock({ kind: "assistant", id: "b", text: "" })?.compact).toBe(true)
    expect(expandLabelForBlock({ kind: "result", id: "b", isError: false })?.compact).toBe(true)
    expect(expandLabelForBlock({ kind: "injected", id: "b", wrapper: "system-reminder", label: "system reminder", raw: "<system-reminder>x</system-reminder>" })?.compact).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// CAPP-118 — the injected-content classifier: harness user-role wrappers become
// system chips, genuine prose stays a user bubble. Fixtures below are VERBATIM
// shapes captured from a live Claude Code session (review finding 3 — not authored
// approximations), plus the negative controls (a mid-sentence mention / an
// unterminated tag must NEVER be reclassified).
//
// History-path note: the PLAIN-PROSE caveat variant ("Caveat: the messages below
// were generated…" with NO tags) arrives as an `isMeta:true` transcript line and is
// dropped UPSTREAM by transcriptHistory.parseTranscriptLine — it never reaches this
// classifier. If a prose caveat ever did arrive as a live user_message, it matches
// no tag and (acceptably) stays a user bubble.
// ---------------------------------------------------------------------------
describe("classifyInjectedUserContent — harness-injected user-role content (CAPP-118)", () => {
  // CAPTURED: a real background-task notice, byte-for-byte (task-id / tool-use-id /
  // output-file / status / summary), as Claude Code injects when a task finishes.
  const TASK_NOTIFICATION = [
    "<task-notification>",
    "<task-id>byz6q6f7j</task-id>",
    "<tool-use-id>toolu_01RzhTKnV4qyGgCh5SzbaXnQ</tool-use-id>",
    "<output-file>C:\\Users\\ryguy\\AppData\\Local\\Temp\\claude\\C--Users-ryguy-projects-claude-tui-app\\6559fd4d-3334-431a-b95a-816c64c4abe0\\tasks\\byz6q6f7j.output</output-file>",
    "<status>completed</status>",
    '<summary>Background command "Repackage the desktop build" completed (exit code 0)</summary>',
    "</task-notification>",
  ].join("\n")

  // CAPTURED variant: with an additional multi-line <note> and a <result> element
  // spanning many lines that carries markdown/code fences.
  const TASK_NOTIFICATION_WITH_RESULT = [
    "<task-notification>",
    "<task-id>byz6q6f7j</task-id>",
    "<tool-use-id>toolu_01RzhTKnV4qyGgCh5SzbaXnQ</tool-use-id>",
    "<output-file>C:\\Users\\ryguy\\AppData\\Local\\Temp\\claude\\tasks\\byz6q6f7j.output</output-file>",
    "<status>completed</status>",
    '<summary>Background command "npm test" completed (exit code 0)</summary>',
    "<note>The full output is available in the output file.",
    "Use Read to inspect it if needed.</note>",
    "<result>",
    "Test run finished:",
    "```",
    "Test Files  85 passed (88)",
    "```",
    "</result>",
    "</task-notification>",
  ].join("\n")

  // Real shape: `<system-reminder>` + free text + `</system-reminder>` (standalone
  // or appended after real user text in the same message — both covered below).
  const SYSTEM_REMINDER =
    "<system-reminder>\nAs you answer, remember the codebase instructions.\n</system-reminder>"

  // CAPTURED: the real caveat prose, followed IN THE SAME MESSAGE by the
  // slash-command echo triple (the /model shape).
  const CAVEAT_TEXT =
    "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>"
  const LOCAL_COMMAND_MODEL = [
    CAVEAT_TEXT,
    "<command-name>/model</command-name>",
    "<command-message>model</command-message>",
    "<command-args>opus</command-args>",
  ].join("\n")

  // CAPTURED: the caveat followed by the `!`-bash echo — note bash-stdout and the
  // (empty) bash-stderr sit ADJACENT on one line, exactly as captured.
  const LOCAL_COMMAND_BASH = [
    CAVEAT_TEXT,
    "<bash-input>pwd</bash-input>",
    "<bash-stdout>C:\\Users\\ryguy\\projects\\claude-tui-app</bash-stdout><bash-stderr></bash-stderr>",
  ].join("\n")

  it("a lone task-notification → ONE injected chip carrying the summary, no user bubble", () => {
    const segs = classifyInjectedUserContent(TASK_NOTIFICATION)
    expect(segs).toHaveLength(1)
    expect(segs[0].kind).toBe("injected")
    const inj = segs[0] as InjectedSegment
    expect(inj.wrapper).toBe("task-notification")
    expect(inj.label).toBe('background task — Background command "Repackage the desktop build" completed (exit code 0)')
    // The RAW wrapper text is preserved verbatim (inspectable behind the ⤢).
    expect(inj.raw).toBe(TASK_NOTIFICATION)
  })

  it("the note+result variant (multi-line, fenced code inside) → still ONE chip, raw verbatim", () => {
    const segs = classifyInjectedUserContent(TASK_NOTIFICATION_WITH_RESULT)
    expect(segs).toHaveLength(1)
    const inj = segs[0] as InjectedSegment
    expect(inj.wrapper).toBe("task-notification")
    expect(inj.label).toBe('background task — Background command "npm test" completed (exit code 0)')
    // The many-line <result> (with its ``` fence) rides inside the chip's raw whole.
    expect(inj.raw).toBe(TASK_NOTIFICATION_WITH_RESULT)
  })

  it("a task-notification with NO summary falls back to a generic label", () => {
    const raw = "<task-notification><status>running</status></task-notification>"
    const inj = classifyInjectedUserContent(raw)[0] as InjectedSegment
    expect(inj.kind).toBe("injected")
    expect(inj.label).toBe("background task")
  })

  it("a system-reminder → ONE injected chip labelled 'system reminder'", () => {
    const segs = classifyInjectedUserContent(SYSTEM_REMINDER)
    expect(segs).toHaveLength(1)
    const inj = segs[0] as InjectedSegment
    expect(inj.wrapper).toBe("system-reminder")
    expect(inj.label).toBe("system reminder")
  })

  it("caveat + /model command triple (same message) → ONE local-command chip labelled '/model'", () => {
    const segs = classifyInjectedUserContent(LOCAL_COMMAND_MODEL)
    expect(segs).toHaveLength(1)
    const inj = segs[0] as InjectedSegment
    expect(inj.wrapper).toBe("local-command")
    expect(inj.label).toBe("/model")
    // Sticky caveat: the whole echo (caveat + triple) folds into one chip's raw.
    expect(inj.raw).toBe(LOCAL_COMMAND_MODEL)
  })

  it("caveat + bash echo (adjacent bash-stdout/bash-stderr) → ONE 'local command output' chip", () => {
    const segs = classifyInjectedUserContent(LOCAL_COMMAND_BASH)
    expect(segs).toHaveLength(1)
    const inj = segs[0] as InjectedSegment
    expect(inj.wrapper).toBe("local-command")
    expect(inj.label).toBe("local command output")
    expect(inj.raw).toContain("<bash-input>pwd</bash-input>")
    expect(inj.raw).toContain("<bash-stdout>C:\\Users\\ryguy\\projects\\claude-tui-app</bash-stdout><bash-stderr></bash-stderr>")
  })

  it("a later stdout-only message (the /model result arrives separately) → its own chip", () => {
    const segs = classifyInjectedUserContent("<local-command-stdout>Set model to opus</local-command-stdout>")
    expect(segs).toHaveLength(1)
    const inj = segs[0] as InjectedSegment
    expect(inj.wrapper).toBe("local-command")
    expect(inj.label).toBe("local command output")
  })

  it("a standalone bash echo WITHOUT the caveat still folds into one chip (bash-* recognized)", () => {
    const text = "<bash-input>pwd</bash-input>\n<bash-stdout>out</bash-stdout><bash-stderr></bash-stderr>"
    const segs = classifyInjectedUserContent(text)
    expect(segs).toHaveLength(1)
    expect((segs[0] as InjectedSegment).wrapper).toBe("local-command")
    expect((segs[0] as InjectedSegment).raw).toBe(text)
  })

  it("MIXED: real user prose then a trailing system-reminder appendix → bubble + chip", () => {
    const text = `Please refactor the parser.\n\n${SYSTEM_REMINDER}`
    const segs = classifyInjectedUserContent(text)
    expect(segs.map((s) => s.kind)).toEqual(["user", "injected"])
    expect((segs[0] as PlainUserSegmentT).text).toBe("Please refactor the parser.")
    expect((segs[1] as InjectedSegment).wrapper).toBe("system-reminder")
  })

  it("MIXED: an injected block PRECEDING user prose → chip + bubble", () => {
    const text = `${SYSTEM_REMINDER}\nNow do the actual work.`
    const segs = classifyInjectedUserContent(text)
    expect(segs.map((s) => s.kind)).toEqual(["injected", "user"])
    expect((segs[1] as PlainUserSegmentT).text).toBe("Now do the actual work.")
  })

  it("NEGATIVE CONTROL: a mid-sentence MENTION of a tag stays a single user bubble", () => {
    const text = "The <task-notification> element is what Claude Code injects — see the docs."
    const segs = classifyInjectedUserContent(text)
    expect(segs).toHaveLength(1)
    expect(segs[0].kind).toBe("user")
    // Byte-for-byte unchanged (never mangled).
    expect((segs[0] as PlainUserSegmentT).text).toBe(text)
  })

  it("NEGATIVE CONTROL: an UNTERMINATED leading tag (user quoting it) stays a user bubble", () => {
    const text = "<system-reminder> is an XML-ish tag I was asking about"
    const segs = classifyInjectedUserContent(text)
    expect(segs).toHaveLength(1)
    expect(segs[0].kind).toBe("user")
    expect((segs[0] as PlainUserSegmentT).text).toBe(text)
  })

  it("a plain user message is returned as ONE unchanged user segment (byte-identical)", () => {
    const text = "fix the flaky test in transcriptWindow.test.ts"
    const segs = classifyInjectedUserContent(text)
    expect(segs).toEqual([{ kind: "user", text }])
  })

  // Review finding 1 — the classifier's WORST case is bounded (it runs synchronously
  // in reduceTranscript, incl. rehydration replay). The wall clock is not asserted
  // (flaky under CI load); the named caps + the fallback SHAPE are.
  it("ADVERSARIAL: a huge message of unterminated wrapper-opens skips classification (size bound)", () => {
    // 50k lines each opening (never closing) a wrapper — the pre-fix O(K·n) freezer.
    const text = Array.from({ length: 50_000 }, () => "<system-reminder> x").join("\n")
    expect(text.length).toBeGreaterThan(INJECTED_CLASSIFY_MAX_CHARS) // takes bound (a)'s fast path
    expect(classifyInjectedUserContent(text)).toEqual([{ kind: "user", text }])
  })

  it("ADVERSARIAL: a close tag beyond the scan window reads as unterminated → plain text (window bound)", () => {
    // Under the size bound, but the close sits past INJECTED_CLOSE_SCAN_WINDOW —
    // closeTagEnd's bounded slice must not find it, so the open stays user prose.
    const text = "<system-reminder>" + "x".repeat(INJECTED_CLOSE_SCAN_WINDOW) + "</system-reminder>"
    expect(text.length).toBeLessThanOrEqual(INJECTED_CLASSIFY_MAX_CHARS)
    expect(classifyInjectedUserContent(text)).toEqual([{ kind: "user", text }])
  })

  it("control: a close WITHIN the scan window still classifies (the bound only bites adversarial input)", () => {
    const text = "<system-reminder>" + "x".repeat(1000) + "</system-reminder>"
    const segs = classifyInjectedUserContent(text)
    expect(segs).toHaveLength(1)
    expect(segs[0].kind).toBe("injected")
  })
})

// The classifier's PlainUserSegment type, aliased so the assertions read clearly.
type PlainUserSegmentT = { kind: "user"; text: string }

describe("reduceTranscript — user_message classification (CAPP-118)", () => {
  it("folds a task-notification user_message into an injected block, NOT a user block", () => {
    const blocks = foldTranscript([
      { kind: "user_message", text: "<task-notification><summary>done</summary></task-notification>" },
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe("injected")
    expect((blocks[0] as InjectedBlock).label).toBe("background task — done")
  })

  it("a MIXED user_message folds into an ordered user block THEN an injected block", () => {
    const blocks = foldTranscript([
      { kind: "user_message", text: "ship it\n<system-reminder>be careful</system-reminder>" },
    ])
    expect(blocks.map((b) => b.kind)).toEqual(["user", "injected"])
    expect((blocks[0] as UserBlock).text).toBe("ship it")
    // Distinct, stable, creation-ordered ids for the two blocks.
    expect(blocks[0].id).not.toBe(blocks[1].id)
  })

  it("a normal user_message still folds into ONE user block (byte-identical)", () => {
    const blocks = foldTranscript([{ kind: "user_message", text: "remember the number 42" }])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe("user")
    expect((blocks[0] as UserBlock).text).toBe("remember the number 42")
  })

  // Review finding 2 — the "open raw" must be ACTUALLY verbatim: the read-only CODE
  // panel, byte-for-byte. The earlier markdown-fence wrapper broke on an inner ```.
  it("panelForBlock opens an injected block VERBATIM in the code panel", () => {
    const raw = "<system-reminder>x</system-reminder>"
    const req = panelForBlock({ kind: "injected", id: "b", wrapper: "system-reminder", label: "system reminder", raw })
    expect(req?.type).toBe("code")
    expect((req?.props as { code: string }).code).toBe(raw) // byte-identical, no wrapper
    expect((req?.props as { wrap?: boolean }).wrap).toBe(true)
  })

  it("a ``` run INSIDE the raw cannot break the verbatim view (the markdown-fence regression)", () => {
    const raw = [
      "<task-notification>",
      "<summary>npm test finished</summary>",
      "<result>",
      "```",
      "Test Files  85 passed (88)",
      "```",
      "**not bold** and `not code` after the inner fence",
      "</result>",
      "</task-notification>",
    ].join("\n")
    const req = panelForBlock({ kind: "injected", id: "b", wrapper: "task-notification", label: "background task", raw })
    // Code panel: the payload is the raw string itself — the inner ``` is DATA, not
    // markup, so nothing after it can render as interpreted markdown.
    expect(req?.type).toBe("code")
    expect((req?.props as { code: string }).code).toBe(raw)
  })
})

// ---------------------------------------------------------------------------
// CAPP-119 review (finding 4) — the e2e ↔ fixture LINKING PIN. The CAPP-111 spec
// (e2e/structured.spec.ts, "CAPP-111 / S4: each block has a STATICALLY-VISIBLE
// top-right expand button…") drives a fakeStream turn and CLICKS the settled
// assistant block's `.agent-block-expand` — a button that only renders because the
// canned REPLY_TEXT passes the CAPP-119 usefulness gate (it carries a fenced code
// block). If the fixture or the gate ever drift apart, this pin fails FIRST in the
// fast unit suite instead of as an opaque e2e timeout. (fakeStream is import-safe
// from src tests: its only ./terminals import is type-only, erased at build.)
// ---------------------------------------------------------------------------
describe("fakeStream ↔ usefulness-gate linking pin (CAPP-119 review)", () => {
  it("the canned fake reply passes assistantExpandUseful (the CAPP-111 e2e depends on it)", () => {
    expect(assistantExpandUseful(REPLY_TEXT)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// CAPP-119 — the assistant expand-button USEFULNESS gate: short prose gets NO icon;
// long / code / table prose does. Pure string gate, tested as a table.
// ---------------------------------------------------------------------------
describe("assistantExpandUseful — the CAPP-119 usefulness gate", () => {
  it("a short plain paragraph is NOT useful to expand (no icon)", () => {
    expect(assistantExpandUseful("Sure, done.")).toBe(false)
    expect(assistantExpandUseful("The build passed and all 280 tests are green.")).toBe(false)
  })

  it("long prose (over the threshold) IS useful to expand", () => {
    expect(assistantExpandUseful("x".repeat(ASSISTANT_EXPAND_MIN_CHARS))).toBe(true)
    expect(assistantExpandUseful("x".repeat(ASSISTANT_EXPAND_MIN_CHARS - 1))).toBe(false)
  })

  it("prose containing a fenced code block IS useful (even if short)", () => {
    expect(assistantExpandUseful("Here:\n```js\nconst x = 1\n```")).toBe(true)
    // A fence must be at a line start — an inline triple-backtick mention is not enough.
    expect(assistantExpandUseful("we write ``` to open a fence")).toBe(false)
  })

  it("prose containing a markdown table IS useful (even if short)", () => {
    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |"
    expect(assistantExpandUseful(table)).toBe(true)
  })

  it("a bare '---' thematic break is NOT mistaken for a table", () => {
    expect(assistantExpandUseful("above\n\n---\n\nbelow")).toBe(false)
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
