import { describe, it, expect, vi } from "vitest"
import { registerPermissionTools } from "./permissions"
import {
  TerminalService,
  type ProcLike,
  type SpawnProc,
} from "../../services/terminals"

// Keep headless stderr warnings out of the real log dir.
vi.mock("../../log", () => ({ logWarn: vi.fn(), logError: vi.fn() }))

/** A minimal ProcLike with no OS process — enough to createHeadless a terminal. */
function fakeProc(): ProcLike {
  return {
    pid: 1234,
    onStdout: () => {},
    onStderr: () => {},
    onExit: () => {},
    write: () => {},
    kill: () => {},
  }
}

const spawnProc: SpawnProc = () => fakeProc()

/** A fake McpServer that just captures registered tool handlers by name. */
function fakeServer() {
  const handlers: Record<
    string,
    (args: any) => Promise<{ content: Array<{ type: string; text: string }> }>
  > = {}
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: (a: any) => any) => {
      handlers[name] = handler
    },
  }
  return { server, handlers }
}

/** Wire a real TerminalService + a fake main window that records pushes, so a
 *  test can recover the generated requestId and resolve it out-of-band. */
function setup(identity: { terminalId?: string; sessionId?: string }) {
  const svc = new TerminalService({ spawnProc })
  const sent: Array<{ channel: string; args: unknown[] }> = []
  ;(svc as unknown as { mainWin: unknown }).mainWin = {
    isDestroyed: () => false,
    webContents: { send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }) },
  }
  const { server, handlers } = fakeServer()
  // identity.terminalId must reference a real headless terminal for the gate to attribute.
  registerPermissionTools(server as any, svc, identity)
  return { svc, sent, handlers }
}

const pushedRequest = (sent: Array<{ channel: string; args: unknown[] }>) =>
  sent.find((s) => s.channel === "permission:request")?.args[0] as
    | { id: string; toolName: string; terminalId?: string }
    | undefined

describe("approve_tool MCP gate — registration + round-trip", () => {
  it("registers a tool named approve_tool", () => {
    const { handlers } = setup({})
    expect(typeof handlers["approve_tool"]).toBe("function")
  })

  it("attributes to the caller's terminal, blocks on the decision, and returns the ALLOW wire JSON (updatedInput echoed)", async () => {
    const svcWrap = new TerminalService({ spawnProc })
    const info = svcWrap.createHeadless("t", process.cwd())
    // Build the gate bound to THIS terminal's identity.
    const sent: Array<{ channel: string; args: unknown[] }> = []
    ;(svcWrap as unknown as { mainWin: unknown }).mainWin = {
      isDestroyed: () => false,
      webContents: { send: (c: string, ...a: unknown[]) => sent.push({ channel: c, args: a }) },
    }
    const { server, handlers } = fakeServer()
    registerPermissionTools(server as any, svcWrap, { terminalId: info.id, sessionId: "s1" })

    const input = { file_path: "a.txt", content: "hi" }
    const resultPromise = handlers["approve_tool"]({ tool_name: "Write", input, tool_use_id: "tu-9" })

    // The push attributes to the caller's terminal.
    const req = pushedRequest(sent)!
    expect(req.terminalId).toBe(info.id)
    expect(req.toolName).toBe("Write")

    // User allows (unedited) → wire result echoes updatedInput (live-proven requirement).
    svcWrap.resolvePermission(req.id, { id: req.id, behavior: "allow" })
    const result = await resultPromise
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toEqual({ behavior: "allow", updatedInput: input })
  })

  it("returns the DENY wire JSON with the message", async () => {
    const svc = new TerminalService({ spawnProc })
    const info = svc.createHeadless("t", process.cwd())
    const sent: Array<{ channel: string; args: unknown[] }> = []
    ;(svc as unknown as { mainWin: unknown }).mainWin = {
      isDestroyed: () => false,
      webContents: { send: (c: string, ...a: unknown[]) => sent.push({ channel: c, args: a }) },
    }
    const { server, handlers } = fakeServer()
    registerPermissionTools(server as any, svc, { terminalId: info.id })

    const resultPromise = handlers["approve_tool"]({ tool_name: "Bash", input: { command: "rm -rf /" } })
    const req = pushedRequest(sent)!
    svc.resolvePermission(req.id, { id: req.id, behavior: "deny", message: "blocked by user" })
    const result = await resultPromise
    expect(JSON.parse(result.content[0].text)).toEqual({ behavior: "deny", message: "blocked by user" })
  })

  it("fails safe (deny) when no terminal identity is bound — cannot prompt anyone", async () => {
    const { handlers } = setup({}) // no terminalId
    const result = await handlers["approve_tool"]({ tool_name: "Write", input: {} })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.behavior).toBe("deny")
    expect(parsed.message).toMatch(/no terminal/i)
  })

  it("BO-10 — an unattributable permission raises a VISIBLE notify, not just a silent deny", async () => {
    const svc = new TerminalService({ spawnProc })
    const { server, handlers } = fakeServer()
    const notify = vi.fn()
    registerPermissionTools(server as any, svc, {} /* no terminalId */, notify)

    const result = await handlers["approve_tool"]({ tool_name: "Bash", input: { command: "ls" } })
    expect(JSON.parse(result.content[0].text).behavior).toBe("deny")
    // The user sees a warning toast — the failed attribution is observable, not a
    // mystery hang (the dogfooding bug).
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][1]).toBe("warning")
    expect(String(notify.mock.calls[0][0])).toMatch(/Bash/)
  })
})
