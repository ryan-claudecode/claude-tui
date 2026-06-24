import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  getThemeMode,
  setThemeMode,
  setRenderingEngine,
  setAgentRailOpen,
  loadConfig,
  resolveRenderingEngine,
  resolveRenderingModel,
  resolveRenderingEffort,
  resolveSkipApproval,
  resolveAgentRailOpen,
  resolvePrimerRecall,
  resolveInjectMaxBytes,
  DEFAULT_INJECT_MAX_BYTES,
  claudeDefaultModel,
  claudeDefaultEffort,
  type ThemeMode,
} from "./config"
import * as fs from "node:fs"

vi.mock("node:fs")

describe("theme mode config", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetAllMocks()
  })

  it("getThemeMode returns 'light' when config file is missing", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT")
    })
    expect(getThemeMode()).toBe("light")
  })

  it("getThemeMode returns stored theme.mode from a versioned file", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ schemaVersion: 1, data: { theme: { mode: "dark" } } })
    )
    expect(getThemeMode()).toBe("dark")
  })

  it("getThemeMode reads a LEGACY (envelope-less) config for backward compat", () => {
    // pre-versioning config: raw object, no { schemaVersion, data } envelope.
    // Stub the write side too so read-repair doesn't leak onto later specs.
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ theme: { mode: "cold-dark" } })
    )
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {})
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as any)
    vi.spyOn(fs, "renameSync").mockImplementation(() => {})
    expect(getThemeMode()).toBe("cold-dark")
  })

  it("getThemeMode returns 'light' when theme.mode is missing", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ schemaVersion: 1, data: { theme: { fontSize: 14 } } })
    )
    expect(getThemeMode()).toBe("light")
  })

  it("setThemeMode writes theme.mode in the versioned envelope, preserving other fields", () => {
    // already-versioned file on disk (so no read-repair rewrite fires first)
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ schemaVersion: 1, data: { theme: { fontSize: 14 } } })
    )
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {})
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as any)
    vi.spyOn(fs, "renameSync").mockImplementation(() => {})

    setThemeMode("cold-dark")

    // saveVersioned writes once (to the .tmp path, then renames)
    expect(writeSpy).toHaveBeenCalledTimes(1)
    const written = JSON.parse(writeSpy.mock.calls[0][1] as string)
    expect(written.schemaVersion).toBe(1)
    expect(written.data.theme.mode).toBe("cold-dark")
    expect(written.data.theme.fontSize).toBe(14)
  })
})

describe("rendering.engine config (BO-4a)", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetAllMocks()
  })

  it("loadConfig PROJECTS rendering (not interface-only) so get_config/preload surface it", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ schemaVersion: 1, data: { rendering: { engine: "structured" } } }),
    )
    expect(loadConfig().rendering).toEqual({ engine: "structured" })
  })

  it("loadConfig leaves rendering undefined when absent (default behavior)", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ schemaVersion: 1, data: {} }),
    )
    expect(loadConfig().rendering).toBeUndefined()
  })

  // CAPP-39 gate ④ — the default flipped: absent/unknown now resolves to "structured";
  // ONLY an explicit `engine: "xterm"` selects the legacy interactive PTY.
  it("resolveRenderingEngine defaults to structured when absent/unknown, xterm only when explicitly set", () => {
    expect(resolveRenderingEngine(undefined)).toBe("structured")
    expect(resolveRenderingEngine(null)).toBe("structured")
    expect(resolveRenderingEngine({})).toBe("structured")
    expect(resolveRenderingEngine({ rendering: {} })).toBe("structured")
    expect(resolveRenderingEngine({ rendering: { engine: "bogus" as never } })).toBe("structured")
    expect(resolveRenderingEngine({ rendering: { engine: "xterm" } })).toBe("xterm")
    expect(resolveRenderingEngine({ rendering: { engine: "structured" } })).toBe("structured")
  })

  // CAPP-39 gate ④ — the rollback write-path. Mirrors the setThemeMode test:
  // read-modify-save through the versioned envelope, preserving other rendering
  // fields (model/effort). Both directions are exercised.
  it("setRenderingEngine writes rendering.engine in the versioned envelope, preserving other rendering fields", () => {
    // already-versioned file on disk (so no read-repair rewrite fires first)
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ schemaVersion: 1, data: { rendering: { model: "sonnet", effort: "high" } } }),
    )
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {})
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as any)
    vi.spyOn(fs, "renameSync").mockImplementation(() => {})

    setRenderingEngine("xterm")

    expect(writeSpy).toHaveBeenCalledTimes(1)
    const written = JSON.parse(writeSpy.mock.calls[0][1] as string)
    expect(written.schemaVersion).toBe(1)
    expect(written.data.rendering.engine).toBe("xterm")
    // other rendering fields survive the write
    expect(written.data.rendering.model).toBe("sonnet")
    expect(written.data.rendering.effort).toBe("high")
  })

  it("setRenderingEngine creates the rendering object when absent and writes structured", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ schemaVersion: 1, data: { theme: { mode: "dark" } } }),
    )
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {})
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as any)
    vi.spyOn(fs, "renameSync").mockImplementation(() => {})

    setRenderingEngine("structured")

    expect(writeSpy).toHaveBeenCalledTimes(1)
    const written = JSON.parse(writeSpy.mock.calls[0][1] as string)
    expect(written.data.rendering.engine).toBe("structured")
    // unrelated fields are untouched
    expect(written.data.theme.mode).toBe("dark")
  })
})

describe("agentRail config (Agent Rail v1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetAllMocks()
  })

  it("resolveAgentRailOpen defaults to open (true) when absent", () => {
    expect(resolveAgentRailOpen(undefined)).toBe(true)
    expect(resolveAgentRailOpen(null)).toBe(true)
    expect(resolveAgentRailOpen({})).toBe(true)
    expect(resolveAgentRailOpen({ agentRail: {} })).toBe(true)
  })

  it("resolveAgentRailOpen returns false only when explicitly false", () => {
    expect(resolveAgentRailOpen({ agentRail: { open: false } })).toBe(false)
    expect(resolveAgentRailOpen({ agentRail: { open: true } })).toBe(true)
  })
})

describe("context.primerRecall config (CAPP-86 — The Lexicon)", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetAllMocks()
  })

  it("resolvePrimerRecall defaults to OFF (false) when absent — byte-identical default primer", () => {
    expect(resolvePrimerRecall(undefined)).toBe(false)
    expect(resolvePrimerRecall(null)).toBe(false)
    expect(resolvePrimerRecall({})).toBe(false)
    expect(resolvePrimerRecall({ context: {} })).toBe(false)
  })

  it("resolvePrimerRecall returns true ONLY when explicitly true", () => {
    expect(resolvePrimerRecall({ context: { primerRecall: true } })).toBe(true)
    expect(resolvePrimerRecall({ context: { primerRecall: false } })).toBe(false)
  })

  it("loadConfig surfaces context so getConfig carries the override", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ schemaVersion: 1, data: { context: { primerRecall: true } } }),
    )
    expect(loadConfig().context?.primerRecall).toBe(true)
  })

  it("setAgentRailOpen writes agentRail.open in the versioned envelope, preserving other fields", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ schemaVersion: 1, data: { theme: { mode: "dark" } } }),
    )
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {})
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as any)
    vi.spyOn(fs, "renameSync").mockImplementation(() => {})

    setAgentRailOpen(false)

    expect(writeSpy).toHaveBeenCalledTimes(1)
    const written = JSON.parse(writeSpy.mock.calls[0][1] as string)
    expect(written.schemaVersion).toBe(1)
    expect(written.data.agentRail.open).toBe(false)
    // unrelated fields are untouched
    expect(written.data.theme.mode).toBe("dark")
  })

  it("loadConfig surfaces agentRail so getConfig carries it to the renderer", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ schemaVersion: 1, data: { agentRail: { open: false } } }),
    )
    expect(loadConfig().agentRail).toEqual({ open: false })
  })
})

describe("rendering.model config (BO-6)", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetAllMocks()
  })

  it("resolveRenderingModel defaults to the opus alias when absent/blank", () => {
    expect(resolveRenderingModel(undefined)).toBe("opus")
    expect(resolveRenderingModel(null)).toBe("opus")
    expect(resolveRenderingModel({})).toBe("opus")
    expect(resolveRenderingModel({ rendering: {} })).toBe("opus")
    expect(resolveRenderingModel({ rendering: { model: "   " } })).toBe("opus")
  })

  it("resolveRenderingModel returns the configured model (trimmed) when set", () => {
    expect(resolveRenderingModel({ rendering: { model: "sonnet" } })).toBe("sonnet")
    expect(resolveRenderingModel({ rendering: { model: "  opus[1m] " } })).toBe("opus[1m]")
  })

  it("resolveRenderingModel honors an explicit fallback only when the config is unset", () => {
    expect(resolveRenderingModel(undefined, "haiku")).toBe("haiku")
    expect(resolveRenderingModel({ rendering: { model: "sonnet" } }, "haiku")).toBe("sonnet")
  })

  it("loadConfig PROJECTS rendering.model so get_config/preload surface it", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ schemaVersion: 1, data: { rendering: { engine: "structured", model: "sonnet" } } }),
    )
    expect(loadConfig().rendering).toEqual({ engine: "structured", model: "sonnet" })
  })

  it("claudeDefaultModel reads ~/.claude/settings.json model (best-effort)", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ model: "claude-opus-4-8" }))
    expect(claudeDefaultModel()).toBe("claude-opus-4-8")
  })

  it("claudeDefaultModel returns undefined when the file is missing or has no model", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT")
    })
    expect(claudeDefaultModel()).toBeUndefined()
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ theme: "dark" }))
    expect(claudeDefaultModel()).toBeUndefined()
  })
})

describe("rendering.effort config (CAPP-46)", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetAllMocks()
  })

  it("resolveRenderingEffort returns undefined when absent/blank (so --effort is OMITTED — byte-unchanged default)", () => {
    expect(resolveRenderingEffort(undefined)).toBeUndefined()
    expect(resolveRenderingEffort(null)).toBeUndefined()
    expect(resolveRenderingEffort({})).toBeUndefined()
    expect(resolveRenderingEffort({ rendering: {} })).toBeUndefined()
    expect(resolveRenderingEffort({ rendering: { effort: "   " } })).toBeUndefined()
  })

  it("resolveRenderingEffort returns the configured effort (trimmed) when set", () => {
    expect(resolveRenderingEffort({ rendering: { effort: "high" } })).toBe("high")
    expect(resolveRenderingEffort({ rendering: { effort: "  max " } })).toBe("max")
  })

  it("resolveRenderingEffort honors an explicit fallback only when the config is unset", () => {
    expect(resolveRenderingEffort(undefined, "medium")).toBe("medium")
    expect(resolveRenderingEffort({ rendering: { effort: "high" } }, "medium")).toBe("high")
    // No fallback + unset = undefined (the key difference from resolveRenderingModel).
    expect(resolveRenderingEffort({ rendering: {} })).toBeUndefined()
  })

  it("loadConfig PROJECTS rendering.effort so get_config/preload surface it", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ schemaVersion: 1, data: { rendering: { engine: "structured", effort: "high" } } }),
    )
    expect(loadConfig().rendering).toEqual({ engine: "structured", effort: "high" })
  })

  it("claudeDefaultEffort reads ~/.claude/settings.json effortLevel (best-effort)", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ effortLevel: "xhigh" }))
    expect(claudeDefaultEffort()).toBe("xhigh")
  })

  it("claudeDefaultEffort returns undefined when the file is missing or has no effortLevel", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT")
    })
    expect(claudeDefaultEffort()).toBeUndefined()
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ model: "opus" }))
    expect(claudeDefaultEffort()).toBeUndefined()
  })
})

// DEV-skip-permissions (RELEASE BLOCKER): the structured permission posture.
// Default is SKIP (true); only an explicit `permissions.skipApproval: false`
// re-arms the preserved BO-3 gate. See PermissionsConfig in config.ts.
describe("resolveSkipApproval (DEV permission posture)", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetAllMocks()
  })

  it("defaults to true (skip) when absent/partial — the dev posture", () => {
    expect(resolveSkipApproval(undefined)).toBe(true)
    expect(resolveSkipApproval(null)).toBe(true)
    expect(resolveSkipApproval({})).toBe(true)
    expect(resolveSkipApproval({ permissions: {} })).toBe(true)
    expect(resolveSkipApproval({ permissions: { skipApproval: true } })).toBe(true)
  })

  it("is false ONLY when permissions.skipApproval is explicitly false (re-arms BO-3)", () => {
    expect(resolveSkipApproval({ permissions: { skipApproval: false } })).toBe(false)
  })

  it("loadConfig PROJECTS permissions so get_config/preload surface it", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ schemaVersion: 1, data: { permissions: { skipApproval: false } } }),
    )
    expect(loadConfig().permissions).toEqual({ skipApproval: false })
  })
})

// CAPP-96 — the byte cap for the auto-loaded context payload. Pure over the config
// object; the default backstops any absent/garbage value so the builder always has a
// positive integer ceiling.
describe("resolveInjectMaxBytes (CAPP-96 auto-load byte cap)", () => {
  it("falls back to the default for absent/partial config", () => {
    expect(resolveInjectMaxBytes(undefined)).toBe(DEFAULT_INJECT_MAX_BYTES)
    expect(resolveInjectMaxBytes(null)).toBe(DEFAULT_INJECT_MAX_BYTES)
    expect(resolveInjectMaxBytes({})).toBe(DEFAULT_INJECT_MAX_BYTES)
    expect(resolveInjectMaxBytes({ context: {} })).toBe(DEFAULT_INJECT_MAX_BYTES)
  })

  it("honors a positive number and floors a fractional one", () => {
    expect(resolveInjectMaxBytes({ context: { injectMaxBytes: 4096 } })).toBe(4096)
    expect(resolveInjectMaxBytes({ context: { injectMaxBytes: 4096.9 } })).toBe(4096)
  })

  it("rejects non-positive / non-finite / wrong-type values → default", () => {
    expect(resolveInjectMaxBytes({ context: { injectMaxBytes: 0 } })).toBe(DEFAULT_INJECT_MAX_BYTES)
    expect(resolveInjectMaxBytes({ context: { injectMaxBytes: -1 } })).toBe(DEFAULT_INJECT_MAX_BYTES)
    expect(resolveInjectMaxBytes({ context: { injectMaxBytes: Number.NaN } })).toBe(DEFAULT_INJECT_MAX_BYTES)
    expect(resolveInjectMaxBytes({ context: { injectMaxBytes: Infinity } })).toBe(DEFAULT_INJECT_MAX_BYTES)
    expect(resolveInjectMaxBytes({ context: { injectMaxBytes: "8192" } as never })).toBe(DEFAULT_INJECT_MAX_BYTES)
    expect(resolveInjectMaxBytes({ context: { injectMaxBytes: null } as never })).toBe(DEFAULT_INJECT_MAX_BYTES)
  })
})
