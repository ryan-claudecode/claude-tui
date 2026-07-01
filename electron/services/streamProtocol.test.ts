import { describe, it, expect } from "vitest"
import {
  buildPermissionResult,
  agentMessageFromInput,
  userMessage,
  resolveModelOptions,
  modelSupportsXhigh,
  MODEL_ALIASES,
  DEFAULT_MODEL,
  PERMISSION_PROMPT_TOOL,
  PERMISSION_TOOL_NAME,
} from "./streamProtocol"
import {
  PERMISSION_TOOL_INPUT_WRITE,
  PERMISSION_RESULT_ALLOW,
  PERMISSION_RESULT_DENY,
} from "./permissionWire.fixtures"

describe("BO-3 buildPermissionResult — the --permission-prompt-tool wire result", () => {
  it("ALLOW echoes the original input as updatedInput when unedited (live-proven requirement)", () => {
    const result = buildPermissionResult(
      { behavior: "allow" },
      PERMISSION_TOOL_INPUT_WRITE.input,
    )
    expect(result).toEqual({ behavior: "allow", updatedInput: PERMISSION_TOOL_INPUT_WRITE.input })
    // Matches the captured-live ALLOW shape.
    expect(result).toEqual(PERMISSION_RESULT_ALLOW)
  })

  it("ALLOW uses an edited updatedInput when supplied", () => {
    const edited = { file_path: "safe.txt", content: "hi" }
    const result = buildPermissionResult({ behavior: "allow", updatedInput: edited }, { file_path: "x" })
    expect(result).toEqual({ behavior: "allow", updatedInput: edited })
  })

  it("DENY carries the message and no updatedInput", () => {
    const result = buildPermissionResult({ behavior: "deny", message: "spike: denied by host" }, { a: 1 })
    expect(result).toEqual(PERMISSION_RESULT_DENY)
    expect("updatedInput" in result).toBe(false)
  })

  it("the prompt-tool constants match the MCP-prefixed name", () => {
    expect(PERMISSION_TOOL_NAME).toBe("approve_tool")
    expect(PERMISSION_PROMPT_TOOL).toBe("mcp__claudetui__approve_tool")
  })
})

describe("BO-3 agentMessageFromInput — composer { text, attachments } → AgentUserMessage", () => {
  it("plain text becomes a single text block", () => {
    expect(agentMessageFromInput({ text: "run the tests" })).toEqual(userMessage("run the tests"))
  })

  it("folds image attachments in as quoted paths after the text", () => {
    const msg = agentMessageFromInput({ text: "look at this", attachments: ["C:/tmp/a.png"] })
    expect(msg.message.content[0].text).toBe('look at this\n"C:/tmp/a.png"')
  })

  it("attachments-only (no text) still produces the quoted paths", () => {
    const msg = agentMessageFromInput({ attachments: ["a.png", "b.png"] })
    expect(msg.message.content[0].text).toBe('"a.png"\n"b.png"')
  })

  it("trims text and ignores blank attachments", () => {
    const msg = agentMessageFromInput({ text: "  hi  ", attachments: ["", "  "] })
    expect(msg.message.content[0].text).toBe("hi")
  })
})

// ---------------------------------------------------------------------------
// CAPP-113 — the never-stale model list: the documented alias set + the
// config-extensible derivation.
// ---------------------------------------------------------------------------

describe("CAPP-113 MODEL_ALIASES — the full documented alias set", () => {
  it("carries every documented alias (best/fable/opus/opus[1m]/sonnet/sonnet[1m]/haiku/opusplan)", () => {
    expect([...MODEL_ALIASES]).toEqual([
      "best",
      "fable",
      "opus",
      "opus[1m]",
      "sonnet",
      "sonnet[1m]",
      "haiku",
      "opusplan",
    ])
    expect(DEFAULT_MODEL).toBe("opus")
  })
})

describe("CAPP-113 resolveModelOptions — config-extensible picker list", () => {
  it("absent/empty models block → just the built-in aliases (order preserved)", () => {
    expect(resolveModelOptions(MODEL_ALIASES)).toEqual([...MODEL_ALIASES])
    expect(resolveModelOptions(MODEL_ALIASES, null)).toEqual([...MODEL_ALIASES])
    expect(resolveModelOptions(MODEL_ALIASES, {})).toEqual([...MODEL_ALIASES])
  })

  it("appends models.extra AFTER the aliases, preserving order", () => {
    const out = resolveModelOptions(MODEL_ALIASES, { extra: ["zeus", "claude-opus-5-1"] })
    expect(out.slice(0, MODEL_ALIASES.length)).toEqual([...MODEL_ALIASES])
    expect(out.slice(MODEL_ALIASES.length)).toEqual(["zeus", "claude-opus-5-1"])
  })

  it("removes models.hidden (hidden wins over an entry that's also in extra)", () => {
    const out = resolveModelOptions(MODEL_ALIASES, { extra: ["zeus"], hidden: ["haiku", "zeus"] })
    expect(out).not.toContain("haiku")
    expect(out).not.toContain("zeus")
    expect(out).toContain("opus")
  })

  it("de-dupes (an extra already among the aliases, or a repeated extra, appears once)", () => {
    const out = resolveModelOptions(MODEL_ALIASES, { extra: ["opus", "zeus", "zeus"] })
    expect(out.filter((m) => m === "opus")).toHaveLength(1)
    expect(out.filter((m) => m === "zeus")).toHaveLength(1)
  })

  it("tolerates malformed members (non-strings / blanks are dropped, never throws)", () => {
    const out = resolveModelOptions(MODEL_ALIASES, {
      extra: ["  spaced  ", "", "   ", 42, null, { x: 1 }] as unknown[],
      hidden: [7, "opus"] as unknown[],
    })
    expect(out).toContain("spaced") // trimmed
    expect(out).not.toContain("opus") // hidden honored despite the numeric member
    expect(out.every((m) => typeof m === "string" && m.trim().length > 0)).toBe(true)
  })

  it("a non-array extra/hidden is ignored (degrades to aliases)", () => {
    expect(resolveModelOptions(MODEL_ALIASES, { extra: "opus" as unknown as string[] })).toEqual([
      ...MODEL_ALIASES,
    ])
  })
})

// ---------------------------------------------------------------------------
// CAPP-113 — the xhigh matcher: aliases, pinned full ids, the config override,
// and the negative cases (Sonnet/Haiku families never pass).
// ---------------------------------------------------------------------------

describe("CAPP-113 modelSupportsXhigh — extended matcher table", () => {
  it("alias prefixes pass (opus / opus[1m] / fable / best / opusplan)", () => {
    for (const m of ["opus", "opus[1m]", "fable", "best", "opusplan"]) {
      expect(modelSupportsXhigh(m)).toBe(true)
    }
  })

  it("pinned full ids pass by family substring (claude-opus-4-8 / claude-fable-5-…)", () => {
    expect(modelSupportsXhigh("claude-opus-4-8")).toBe(true)
    expect(modelSupportsXhigh("claude-fable-5-20260101")).toBe(true)
    expect(modelSupportsXhigh("opus-4-8")).toBe(true)
  })

  it("negatives: sonnet / haiku aliases + their pinned ids never pass", () => {
    expect(modelSupportsXhigh("sonnet")).toBe(false)
    expect(modelSupportsXhigh("sonnet[1m]")).toBe(false)
    expect(modelSupportsXhigh("haiku")).toBe(false)
    expect(modelSupportsXhigh("claude-sonnet-5")).toBe(false)
    expect(modelSupportsXhigh("claude-haiku-4-5")).toBe(false)
  })

  it("the config models.xhigh override is ADDITIVE (a declared model passes; absent changes nothing)", () => {
    expect(modelSupportsXhigh("zeus")).toBe(false)
    expect(modelSupportsXhigh("zeus", ["zeus"])).toBe(true)
    // A pinned id under a declared family prefix passes too.
    expect(modelSupportsXhigh("claude-zeus-1", ["claude-zeus"])).toBe(true)
    // Empty/malformed override leaves the built-in behavior byte-identical.
    expect(modelSupportsXhigh("sonnet", [])).toBe(false)
    expect(modelSupportsXhigh("sonnet", ["", "   "])).toBe(false)
  })

  it("empty/undefined model defaults to opus (DEFAULT_MODEL) → true", () => {
    expect(modelSupportsXhigh(undefined)).toBe(true)
    expect(modelSupportsXhigh("")).toBe(true)
    expect(DEFAULT_MODEL).toBe("opus")
  })
})
