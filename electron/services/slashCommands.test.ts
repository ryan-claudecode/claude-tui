import { describe, it, expect } from "vitest"
import {
  parseSlashCommand,
  classifySlashInput,
  NATIVE_SLASH_COMMANDS,
} from "./slashCommands"
import { agentMessageFromInput } from "./streamProtocol"

describe("parseSlashCommand — the command token", () => {
  it("extracts the lowercased command name after a leading slash", () => {
    expect(parseSlashCommand("/config")).toBe("config")
    expect(parseSlashCommand("/Config")).toBe("config")
  })

  it("ignores leading whitespace before the slash", () => {
    expect(parseSlashCommand("   /resume")).toBe("resume")
  })

  it("stops at the first space — args are not part of the command name", () => {
    expect(parseSlashCommand("/clear now please")).toBe("clear")
  })

  it("supports plugin/skill name punctuation (: . -)", () => {
    expect(parseSlashCommand("/plugin:skill")).toBe("plugin:skill")
    expect(parseSlashCommand("/skill-name")).toBe("skill-name")
  })

  it("returns null for non-command text", () => {
    expect(parseSlashCommand("hello world")).toBeNull()
    expect(parseSlashCommand("")).toBeNull()
    expect(parseSlashCommand("/")).toBeNull()
    expect(parseSlashCommand("// not a command")).toBeNull()
    expect(parseSlashCommand("/ spaced")).toBeNull()
  })
})

describe("classifySlashInput — the routing table", () => {
  it("routes native-mapped built-ins to the app affordance", () => {
    expect(classifySlashInput("/config")).toEqual({ kind: "native", command: "config" })
    expect(classifySlashInput("/resume")).toEqual({ kind: "native", command: "resume" })
    // case-insensitive, args tolerated
    expect(classifySlashInput("/Resume now")).toEqual({ kind: "native", command: "resume" })
  })

  it("passes Claude-owned built-ins through unchanged (forwarded to stdin)", () => {
    for (const cmd of ["/clear", "/compact", "/context"]) {
      expect(classifySlashInput(cmd)).toEqual({ kind: "send" })
    }
  })

  it("passes skills / plugin skills / custom + unrecognized commands through", () => {
    expect(classifySlashInput("/chrome-live")).toEqual({ kind: "send" })
    expect(classifySlashInput("/plugin:skill arg")).toEqual({ kind: "send" })
    expect(classifySlashInput("/some-custom-command")).toEqual({ kind: "send" })
  })

  it("passes plain (non-slash) text through", () => {
    expect(classifySlashInput("just a normal message")).toEqual({ kind: "send" })
    expect(classifySlashInput("")).toEqual({ kind: "send" })
  })

  it("leaves /model for BO-6 — NOT intercepted here, so it passes through today", () => {
    expect(classifySlashInput("/model opus")).toEqual({ kind: "send" })
    expect("model" in NATIVE_SLASH_COMMANDS).toBe(false)
  })
})

describe("intercept fidelity — pass-through never strips or mangles the slash", () => {
  it("forwards /clear and /compact verbatim into the structured user message", () => {
    // The intercept builds the stdin message with agentMessageFromInput for the
    // `send` route, exactly as the handler does — so this proves the slash and the
    // command survive intact end-to-end (acceptance: not stripped/mangled).
    for (const cmd of ["/clear", "/compact"]) {
      expect(classifySlashInput(cmd)).toEqual({ kind: "send" })
      const msg = agentMessageFromInput({ text: cmd })
      expect(msg.message.content[0]).toEqual({ type: "text", text: cmd })
    }
  })
})
