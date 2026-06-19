import { describe, it, expect } from "vitest"
import { BroadcastService } from "./broadcast"
import type { TerminalService, TerminalInfo } from "./terminals"

/**
 * A minimal stub of the slice of TerminalService BroadcastService uses: `list()`
 * (the open terminals) and `write(id, data)` (the fan-out sink). No real PTYs —
 * hermetic.
 *
 * CAPP-54 gate ② (re-review BLOCKER de-mask): the stub holds full terminal records
 * but its `list()` REBUILDS the returned objects field-by-field, MIRRORING the real
 * TerminalService.list() (electron/services/terminals.ts). The previous stub returned
 * the constructed TerminalInfo[] verbatim, which preserved `isLogin` — a shape the
 * real list() (which rebuilds plain `{ id, name, cwd, state, engine }` objects) did
 * NOT produce. That masked the bug: the broadcast exclusion `filter(s => !s.isLogin)`
 * passed against the fake shape while it was a no-op in production. By rebuilding the
 * SAME way the real service does, this exclusion test now fails if list() ever drops
 * `isLogin` again — the regression is proven against a production-faithful shape.
 */
class StubTerminals {
  writes: Array<{ id: string; data: string }> = []
  constructor(private terminals: TerminalInfo[]) {}
  list(): TerminalInfo[] {
    // Faithful copy of TerminalService.list()'s rebuild: only the fields the real
    // service explicitly maps onto its return objects survive. `isLogin` is included
    // because — and only because — the real list() now copies it.
    return this.terminals.map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      state: s.state,
      engine: s.engine,
      model: s.model,
      isLogin: s.isLogin,
    }))
  }
  write(id: string, data: string): void {
    this.writes.push({ id, data })
  }
}

const info = (id: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id,
  name: id,
  cwd: "/repo",
  state: "idle",
  engine: "structured",
  ...extra,
})

describe("BroadcastService — login-terminal exclusion (CAPP-39 gate ②)", () => {
  it("fans input to every NORMAL terminal but NEVER the login terminal", () => {
    const term = new StubTerminals([
      info("agent-1"),
      info("login-1", { engine: "xterm", isLogin: true }),
      info("agent-2"),
    ])
    const svc = new BroadcastService(term as unknown as TerminalService)

    const res = svc.broadcast("hello", undefined, true)

    // Both agents received the input (with the submit \r); the login terminal did not.
    expect(term.writes.map((w) => w.id).sort()).toEqual(["agent-1", "agent-2"])
    expect(term.writes.every((w) => w.data === "hello\r")).toBe(true)
    expect(res.sent.sort()).toEqual(["agent-1", "agent-2"])
    expect(res.submitted).toBe(true)
  })

  it("EXCLUDES the login terminal even when it is explicitly targeted in session_ids", () => {
    const term = new StubTerminals([
      info("agent-1"),
      info("login-1", { engine: "xterm", isLogin: true }),
    ])
    const svc = new BroadcastService(term as unknown as TerminalService)

    const res = svc.broadcast("text", ["agent-1", "login-1"], false)

    // The login id is treated as invalid (not in the filtered open set), so it is
    // skipped, never written to.
    expect(term.writes.map((w) => w.id)).toEqual(["agent-1"])
    expect(res.sent).toEqual(["agent-1"])
    expect(res.skipped).toEqual(["login-1"])
  })
})
