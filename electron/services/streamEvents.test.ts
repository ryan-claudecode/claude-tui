import { describe, it, expect, vi } from "vitest"
import { parseStreamLine, LineBuffer } from "./streamEvents"
import * as fx from "./streamEvents.fixtures"

// Mock the logger so a "garbage line dropped" warning can be asserted without
// touching the real ~/.claude-tui/logs.
vi.mock("../log", () => ({ logWarn: vi.fn(), logError: vi.fn() }))
import { logWarn } from "../log"

describe("parseStreamLine — captured-fixture happy paths", () => {
  it("parses a system/init event", () => {
    const events = parseStreamLine(fx.INIT)
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.kind).toBe("init")
    if (e.kind !== "init") throw new Error("narrow")
    expect(e.sessionId).toBe("5a8fdaf7-541d-4a23-b212-62d81175cc3b")
    expect(e.model).toBe("claude-opus-4-8[1m]")
    expect(e.cwd).toContain("bo1-derisk")
    expect(e.apiKeySource).toBe("none") // subscription login, no API key
    expect(e.mcpServers).toEqual([
      { name: "claudetui", status: "connected" },
      { name: "plugin:atlassian:atlassian", status: "needs-auth" },
    ])
    expect(e.raw).toBeTypeOf("object")
  })

  it("BO-7 — retains the init slash_commands + skills arrays (the picker catalog)", () => {
    const events = parseStreamLine(fx.INIT)
    const e = events[0]
    if (e.kind !== "init") throw new Error("narrow")
    expect(e.slashCommands).toEqual(["apiref-check", "chrome-live"])
    expect(e.skills).toEqual(["apiref-check", "chrome-live"])
  })

  it("parses a token-level assistant text delta", () => {
    const events = parseStreamLine(fx.ASSISTANT_TEXT_DELTA)
    expect(events).toEqual([{ kind: "assistant_delta", text: "I'll find the echo MCP tool first." }])
  })

  it("parses a thinking delta (extracts the `thinking` text)", () => {
    expect(parseStreamLine(fx.THINKING_DELTA_WITH_TEXT)).toEqual([
      { kind: "thinking_delta", text: "Let me find the echo MCP tool, then call it." },
    ])
  })

  it("parses an empty thinking delta without throwing", () => {
    expect(parseStreamLine(fx.THINKING_DELTA)).toEqual([{ kind: "thinking_delta", text: "" }])
  })

  it("parses a tool_use block out of an assistant message", () => {
    const events = parseStreamLine(fx.ASSISTANT_TOOL_USE)
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.kind).toBe("tool_use")
    if (e.kind !== "tool_use") throw new Error("narrow")
    expect(e.id).toBe("toolu_01Gq29CunqooAUkvro9BcfSC")
    expect(e.name).toBe("ToolSearch")
    expect(e.input).toEqual({ query: "echo", max_results: 5 })
  })

  it("parses a tool_result block out of a user message", () => {
    const events = parseStreamLine(fx.USER_TOOL_RESULT)
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.kind).toBe("tool_result")
    if (e.kind !== "tool_result") throw new Error("narrow")
    expect(e.toolUseId).toBe("toolu_01Gq29CunqooAUkvro9BcfSC")
    expect(e.content).toEqual([{ type: "tool_reference", tool_name: "Monitor" }])
    expect(e.isError).toBeUndefined()
  })

  // BACKGROUND WORK — a `run_in_background` launch's tool_result carries the task-id;
  // the parser emits the tool_result AND an additional background_task_started.
  it("emits background_task_started alongside a background-launch tool_result", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_bg",
            content: "Command running in background with ID: b5n527j84. Output is being written to: C:\\x",
          },
        ],
      },
    })
    const events = parseStreamLine(line)
    expect(events.map((e) => e.kind)).toEqual(["tool_result", "background_task_started"])
    const started = events[1]
    if (started.kind !== "background_task_started") throw new Error("narrow")
    expect(started.taskId).toBe("b5n527j84")
  })

  // BACKGROUND WORK — a <task-notification> user line surfaces as a user_message (→ the
  // CAPP-118 completion chip) PLUS a background_task_done draining the outstanding-set.
  it("emits user_message + background_task_done for a task-notification", () => {
    const text = "<task-notification> <task-id>b5n527j84</task-id> <tool-use-id>toolu_bg</tool-use-id> </task-notification>"
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    })
    const events = parseStreamLine(line)
    expect(events.map((e) => e.kind)).toEqual(["user_message", "background_task_done"])
    const done = events[1]
    if (done.kind !== "background_task_done") throw new Error("narrow")
    expect(done.taskId).toBe("b5n527j84")
  })

  it("does NOT surface an ordinary (non-task-notification) user text block", () => {
    // A non-injected user text line stays dropped live (unchanged behavior).
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello there" }] },
    })
    expect(parseStreamLine(line)).toEqual([])
  })

  it("parses a terminal result event", () => {
    const events = parseStreamLine(fx.RESULT)
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.kind).toBe("result")
    if (e.kind !== "result") throw new Error("narrow")
    expect(e.subtype).toBe("success")
    expect(e.isError).toBe(false)
    expect(e.result).toBe("hi")
  })

  it("emits one tool_use per block when an assistant message bundles several", () => {
    // Real CC bundles content blocks; the parser must fan out (=> StreamEvent[]).
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "doing two things" },
          { type: "tool_use", id: "a", name: "Read", input: { p: 1 } },
          { type: "tool_use", id: "b", name: "Bash", input: { cmd: "ls" } },
        ],
      },
    })
    const events = parseStreamLine(line)
    expect(events.map((e) => e.kind)).toEqual(["tool_use", "tool_use"])
    expect(events.map((e) => (e.kind === "tool_use" ? e.id : null))).toEqual(["a", "b"])
  })

  it("marks an errored tool_result", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "x", content: "boom", is_error: true }],
      },
    })
    expect(parseStreamLine(line)).toEqual([
      { kind: "tool_result", toolUseId: "x", content: "boom", isError: true },
    ])
  })
})

describe("parseStreamLine — auth-failure detection (CAPP-39 gate ②)", () => {
  it("maps an assistant with top-level error 'authentication_failed' to needs_auth", () => {
    const events = parseStreamLine(fx.AUTH_FAILURE_ASSISTANT)
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.kind).toBe("needs_auth")
    if (e.kind !== "needs_auth") throw new Error("narrow")
    // Surfaces the assistant's own "Not logged in" prose.
    expect(e.message).toContain("Not logged in")
  })

  it("does NOT classify a trailing is_error result by prose at the PARSER level (gating moved to the reducer)", () => {
    // The live auth failure emits the `authentication_failed` assistant FIRST (which
    // IS mapped to needs_auth above); the trailing is_error result is parsed as a
    // NORMAL `result` event here. Suppressing it into the banner is the reducer's
    // job (and only when a banner already exists) — so the parser must NOT swallow
    // a standalone errored result merely because its prose mentions login.
    const events = parseStreamLine(fx.AUTH_FAILURE_RESULT)
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.kind).toBe("result")
    if (e.kind !== "result") throw new Error("narrow")
    expect(e.isError).toBe(true)
    expect(e.result).toContain("Not logged in")
    expect(events.some((x) => x.kind === "needs_auth")).toBe(false)
  })

  it("NEGATIVE: a healthy init (apiKeySource:'none') is NOT flagged as auth failure", () => {
    // The CRITICAL false-positive guard: a NORMAL subscription login reports
    // apiKeySource:"none" too, so the healthy init must parse as a plain `init`.
    const events = parseStreamLine(fx.INIT)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("init")
    expect(events.some((e) => e.kind === "needs_auth")).toBe(false)
  })

  it("NEGATIVE: a successful (is_error:false) result is NOT flagged, even if it mentions login", () => {
    // The real success fixture (apiKeySource:"none" session) stays a `result`.
    expect(parseStreamLine(fx.RESULT)[0].kind).toBe("result")
    // Even prose that mentions /login on a SUCCESSFUL turn is not an auth failure —
    // detection requires is_error:true (the explicit failure shape).
    const okWithLoginText = JSON.stringify({
      type: "result",
      is_error: false,
      result: "I checked and you are not logged in to GitHub; run /login there.",
    })
    expect(parseStreamLine(okWithLoginText)[0].kind).toBe("result")
  })

  it("NEGATIVE: an errored result with UNRELATED text is a normal result (not auth)", () => {
    const generic = JSON.stringify({ type: "result", is_error: true, result: "Tool execution failed." })
    expect(parseStreamLine(generic)[0].kind).toBe("result")
  })

  it("REGRESSION: a healthy is_error result whose prose merely mentions auth is a normal result (no preceding auth assistant)", () => {
    // A genuine, AUTHENTICATED turn that errors for a non-auth reason
    // (error_max_turns / error_during_execution) whose prose happens to mention
    // login — the model debugging a 401, a failing auth test, a `gh` CLI message —
    // must NOT be converted to needs_auth and must NOT have its real error swallowed.
    const healthyErr = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "The gh CLI reports you are not logged in; tried /login but the test still fails.",
    })
    const events = parseStreamLine(healthyErr)
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.kind).toBe("result")
    if (e.kind !== "result") throw new Error("narrow")
    expect(e.isError).toBe(true)
    expect(e.subtype).toBe("error_during_execution")
    expect(e.result).toContain("not logged in")
    expect(events.some((x) => x.kind === "needs_auth")).toBe(false)
  })

  it("NEGATIVE: a normal assistant tool_use (no error field) still fans out tool_use", () => {
    expect(parseStreamLine(fx.ASSISTANT_TOOL_USE)[0].kind).toBe("tool_use")
  })
})

describe("parseStreamLine — tolerance / forward-compat (HARD requirement)", () => {
  it("maps an UNKNOWN top-level type to `unknown` (never throws)", () => {
    const line = JSON.stringify({ type: "brand_new_2027_event", foo: 1 })
    const events = parseStreamLine(line)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("unknown")
    if (events[0].kind !== "unknown") throw new Error("narrow")
    expect(events[0].raw).toEqual({ type: "brand_new_2027_event", foo: 1 })
  })

  it("maps a real-but-unmodeled top-level type (rate_limit_event) to `unknown`", () => {
    const events = parseStreamLine(fx.RATE_LIMIT)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("unknown")
  })

  it("IGNORES unknown fields on a known type (still parses)", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "s1",
      a_field_from_the_future: { nested: true },
    })
    const events = parseStreamLine(line)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("init")
  })

  it("DROPS an unmodeled stream_event sub-variant (message_start) without error", () => {
    expect(parseStreamLine(fx.STREAM_MESSAGE_START)).toEqual([])
  })

  it("DROPS a non-init system subtype (hook/status noise) without error", () => {
    const line = JSON.stringify({ type: "system", subtype: "status", status: "requesting" })
    expect(parseStreamLine(line)).toEqual([])
  })

  it("LOGS and DROPS a garbage / non-JSON line (never throws, never kills the stream)", () => {
    vi.mocked(logWarn).mockClear()
    expect(parseStreamLine("this is not json {oops")).toEqual([])
    expect(logWarn).toHaveBeenCalledOnce()
  })

  it("returns [] for a blank line", () => {
    expect(parseStreamLine("")).toEqual([])
    expect(parseStreamLine("   ")).toEqual([])
  })

  it("maps a bare JSON non-object to `unknown`", () => {
    expect(parseStreamLine("42")).toEqual([{ kind: "unknown", raw: 42 }])
  })
})

describe("LineBuffer — chunk reassembly", () => {
  it("reassembles an event split across two data chunks", () => {
    const buf = new LineBuffer()
    const line = fx.ASSISTANT_TEXT_DELTA
    const mid = Math.floor(line.length / 2)
    // First chunk has no newline → nothing complete yet.
    expect(buf.push(line.slice(0, mid))).toEqual([])
    // Second chunk completes the line.
    expect(buf.push(line.slice(mid) + "\n")).toEqual([line])
  })

  it("splits multiple events packed into one chunk", () => {
    const buf = new LineBuffer()
    const chunk = `${fx.INIT}\n${fx.ASSISTANT_TEXT_DELTA}\n${fx.RESULT}\n`
    const lines = buf.push(chunk)
    expect(lines).toEqual([fx.INIT, fx.ASSISTANT_TEXT_DELTA, fx.RESULT])
  })

  it("handles a mid-token chunk boundary: count + order preserved end-to-end", () => {
    const buf = new LineBuffer()
    const a = fx.ASSISTANT_TEXT_DELTA
    const b = fx.THINKING_DELTA_WITH_TEXT
    // chunk1: full a + newline + first half of b (b is left partial)
    const bMid = Math.floor(b.length / 2)
    const chunk1 = `${a}\n${b.slice(0, bMid)}`
    const chunk2 = `${b.slice(bMid)}\n`
    const emitted: string[] = []
    emitted.push(...buf.push(chunk1)) // only `a` is complete
    emitted.push(...buf.push(chunk2)) // now `b` completes
    expect(emitted).toEqual([a, b])
    // Parse the reassembled lines: exactly two typed events, in order.
    const events = emitted.flatMap((l) => parseStreamLine(l))
    expect(events.map((e) => e.kind)).toEqual(["assistant_delta", "thinking_delta"])
  })

  it("skips blank lines between events", () => {
    const buf = new LineBuffer()
    expect(buf.push(`${fx.RESULT}\n\n${fx.RATE_LIMIT}\n`)).toEqual([fx.RESULT, fx.RATE_LIMIT])
  })

  it("strips a trailing \\r so CRLF stdout parses identically", () => {
    const buf = new LineBuffer()
    expect(buf.push(`${fx.RESULT}\r\n`)).toEqual([fx.RESULT])
  })

  it("flush() returns a buffered newline-less final line", () => {
    const buf = new LineBuffer()
    expect(buf.push(fx.RESULT)).toEqual([]) // no newline yet
    expect(buf.flush()).toEqual([fx.RESULT])
    expect(buf.flush()).toEqual([]) // idempotent / empty after
  })
})
