import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { quotePosixArg, quotePowerShellArg } from "./terminals"

/**
 * CAPP-96 — argv-safety of the `shellWrap` PATH wrapper (the load-bearing blocker).
 *
 * `shellWrap` packs the whole command into ONE `-Command` / `-c` string the shell then
 * re-parses, so a payload-file path with a SPACE (a `C:\Users\John Doe\…` homedir) or a
 * shell metacharacter ($, backtick, ;, (, |, &) would be word-split / variable-expanded /
 * command-INJECTED (findings are partly agent-authored). The per-arg quoting must make any
 * value round-trip INTACT. These tests drive the REAL platform shell and assert the arg
 * comes back byte-for-byte — the live proof the design requires.
 */

// A tiny node program that prints its first real argv element verbatim, so the only thing
// under test is whether the SHELL delivered the arg intact (no echo/printf quirks).
const ECHO_JS = "process.stdout.write(process.argv[1] ?? '')"

// NOTE: a literal double-quote is intentionally NOT in this set. Our injected value is
// always a FILE PATH (`<contextDir>/<terminalId>.md`) — Windows forbids `"` in paths and
// the terminalId is `term-<ts>-<rand>`, so `"` can never appear. A `"` round-tripping
// through a SECOND exe's argv parser (powershell → node) is a Windows argv quirk of the
// downstream program, not of shellWrap's quoting (which correctly emits `'a"b'`).
const SPECIAL = [
  "plain",
  "C:\\Users\\John Doe\\.claude-tui\\context\\term-1.md", // the real motivating case: a space
  "/home/jane doe/ctx.md",
  "has$dollar",
  "has`backtick`",
  "semi;colon",
  "paren(s)",
  "pipe|and&amp",
  "quote'inside",
  "a b c   multiple spaces",
  "$(rm -rf nope)", // the injection vector — must arrive as a literal, never execute
]

function roundTripPosix(arg: string): string {
  // bash -c "node -e '<js>' <quoted-arg>"  — exactly how shellWrap assembles its -c string.
  const inner = `node -e ${quotePosixArg(ECHO_JS)} ${quotePosixArg(arg)}`
  return execFileSync("bash", ["-c", inner], { encoding: "utf8" })
}

function roundTripPowerShell(arg: string): string {
  const inner = `node -e ${quotePowerShellArg(ECHO_JS)} ${quotePowerShellArg(arg)}`
  return execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", inner], {
    encoding: "utf8",
  })
}

describe("shellWrap arg quoting — pure", () => {
  it("leaves plain flags/aliases bare (existing pinned-flag assertions stay valid)", () => {
    for (const bare of ["-p", "--output-format", "stream-json", "opus", "--model", "Read"]) {
      expect(quotePosixArg(bare)).toBe(bare)
      expect(quotePowerShellArg(bare)).toBe(bare)
    }
  })

  it("quotes anything with a space or a shell metacharacter", () => {
    expect(quotePosixArg("a b")).not.toBe("a b")
    expect(quotePowerShellArg("a b")).not.toBe("a b")
    expect(quotePosixArg("x;y")).toContain("'")
    expect(quotePowerShellArg("x$y")).toContain("'")
  })

  it("escapes interior single quotes (POSIX '\\'' / PowerShell '')", () => {
    expect(quotePosixArg("a'b")).toBe(`'a'\\''b'`)
    expect(quotePowerShellArg("a'b")).toBe(`'a''b'`)
  })
})

// The live round-trip — run only on the matching platform's real shell.
const onWindows = process.platform === "win32"

describe.runIf(onWindows)("shellWrap PowerShell round-trip (live)", () => {
  for (const arg of SPECIAL) {
    it(`round-trips ${JSON.stringify(arg)} intact through powershell.exe`, () => {
      expect(roundTripPowerShell(arg)).toBe(arg)
    })
  }
})

describe.runIf(!onWindows)("shellWrap bash round-trip (live)", () => {
  for (const arg of SPECIAL) {
    it(`round-trips ${JSON.stringify(arg)} intact through bash -c`, () => {
      expect(roundTripPosix(arg)).toBe(arg)
    })
  }
})
