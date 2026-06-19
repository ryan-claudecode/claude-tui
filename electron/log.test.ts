import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { logError, logWarn, setLogDir } from "./log"

let dir: string
const logPath = () => join(dir, "main.log")

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "log-test-"))
  setLogDir(dir)
  // Silence the console mirror so test output stays clean.
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe("log", () => {
  it("appends a timestamped warn line to main.log", () => {
    logWarn("config", "could not read config")
    const contents = readFileSync(logPath(), "utf-8")
    expect(contents).toMatch(/\[WARN\] config: could not read config/)
    // ISO-8601 timestamp prefix
    expect(contents).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(contents.endsWith("\n")).toBe(true)
  })

  it("appends, not overwrites, across multiple calls", () => {
    logWarn("a", "first")
    logWarn("b", "second")
    const lines = readFileSync(logPath(), "utf-8").trimEnd().split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("first")
    expect(lines[1]).toContain("second")
  })

  it("logs an Error's stack via logError", () => {
    const err = new Error("boom")
    logError("uncaughtException", err)
    const contents = readFileSync(logPath(), "utf-8")
    expect(contents).toContain("[ERROR] uncaughtException:")
    expect(contents).toContain("boom")
  })

  it("serializes non-Error rejection reasons", () => {
    logError("unhandledRejection", { code: "EBADF", detail: 42 })
    const contents = readFileSync(logPath(), "utf-8")
    expect(contents).toContain("EBADF")
  })

  it("creates the log dir on first use", () => {
    const nested = join(dir, "deeper", "logs")
    setLogDir(nested)
    expect(existsSync(nested)).toBe(false)
    logWarn("scope", "hi")
    expect(existsSync(join(nested, "main.log"))).toBe(true)
  })

  it("truncates the file when it exceeds 1 MB before appending", () => {
    // Seed a file just over 1 MB.
    writeFileSync(logPath(), "x".repeat(1024 * 1024 + 10))
    expect(statSync(logPath()).size).toBeGreaterThan(1024 * 1024)
    logWarn("scope", "after truncation")
    const contents = readFileSync(logPath(), "utf-8")
    // Old bulk content gone; only the new line remains.
    expect(contents).not.toContain("x".repeat(100))
    expect(contents).toContain("after truncation")
    expect(statSync(logPath()).size).toBeLessThan(1024)
  })

  it("never throws when the log dir is unwritable", () => {
    // Point at a path whose parent is a file, so mkdir/append both fail.
    const fileAsDir = join(dir, "not-a-dir")
    writeFileSync(fileAsDir, "i am a file")
    setLogDir(join(fileAsDir, "subdir"))
    expect(() => logWarn("scope", "should be swallowed")).not.toThrow()
    expect(() => logError("scope", new Error("also swallowed"))).not.toThrow()
  })
})
