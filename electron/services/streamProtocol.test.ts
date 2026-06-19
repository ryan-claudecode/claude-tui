import { describe, it, expect } from "vitest"
import {
  buildPermissionResult,
  agentMessageFromInput,
  userMessage,
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
