import { describe, it, expect, afterEach } from "vitest"
import { homedir } from "os"
import { join } from "path"
import { tuiHome, tuiPath } from "./paths"

const ORIGINAL = process.env.CLAUDE_TUI_HOME

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CLAUDE_TUI_HOME
  else process.env.CLAUDE_TUI_HOME = ORIGINAL
})

describe("tuiHome", () => {
  it("defaults to ~/.claude-tui (byte-identical to the literal it replaced)", () => {
    delete process.env.CLAUDE_TUI_HOME
    expect(tuiHome()).toBe(join(homedir(), ".claude-tui"))
  })

  it("re-roots the whole instance when CLAUDE_TUI_HOME is set", () => {
    process.env.CLAUDE_TUI_HOME = join(homedir(), ".claude-tui-dev")
    expect(tuiHome()).toBe(join(homedir(), ".claude-tui-dev"))
  })

  it("trims surrounding whitespace", () => {
    process.env.CLAUDE_TUI_HOME = "  C:\\tmp\\tui-dev  "
    expect(tuiHome()).toBe("C:\\tmp\\tui-dev")
  })

  it("IGNORES a blank value — must never redirect state to the process cwd", () => {
    const fallback = join(homedir(), ".claude-tui")
    for (const blank of ["", "   ", "\t"]) {
      process.env.CLAUDE_TUI_HOME = blank
      expect(tuiHome()).toBe(fallback)
    }
  })

  it("is read per-call, so an in-process change takes effect", () => {
    process.env.CLAUDE_TUI_HOME = "C:\\a"
    expect(tuiHome()).toBe("C:\\a")
    process.env.CLAUDE_TUI_HOME = "C:\\b"
    expect(tuiHome()).toBe("C:\\b")
  })
})

describe("tuiPath", () => {
  it("joins segments under the instance root", () => {
    process.env.CLAUDE_TUI_HOME = join(homedir(), ".claude-tui-dev")
    expect(tuiPath("sessions")).toBe(join(homedir(), ".claude-tui-dev", "sessions"))
    expect(tuiPath("stt", "models")).toBe(join(homedir(), ".claude-tui-dev", "stt", "models"))
  })

  it("returns the root itself with no segments", () => {
    delete process.env.CLAUDE_TUI_HOME
    expect(tuiPath()).toBe(tuiHome())
  })

  it("isolates every state file two instances would otherwise share", () => {
    // The concrete regression this guards: a dev instance must not resolve ANY
    // of these to the same path as the packaged app.
    const files = ["config.json", "workspaces.json", "model-catalog.json", "sessions", "schedules", "logs"]
    delete process.env.CLAUDE_TUI_HOME
    const real = files.map((f) => tuiPath(f))
    process.env.CLAUDE_TUI_HOME = join(homedir(), ".claude-tui-dev")
    const dev = files.map((f) => tuiPath(f))
    for (let i = 0; i < files.length; i++) expect(dev[i]).not.toBe(real[i])
  })
})
