import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { registerActionButtonTools } from "./actionButtons"
import { ActionButtonService, UNTAGGED_STEM } from "../../services/actionButtons"
import type { SessionService } from "../../services/sessions"
import type { TerminalIdentity } from "./shared"

/**
 * CAPP-104 (AB-1) — MCP action-button tool round-trip. A fake McpServer captures each
 * registered handler; a REAL ActionButtonService (temp dir) is driven through them.
 * Asserts identity binding: a session button lands in the CALLER's owning session; a
 * workspace button lands in that session's workspace (never a global active selection);
 * an anonymous caller can't create a session button; remove is scoped to the caller;
 * list unions the caller's session + workspace.
 */

function fakeServer() {
  const handlers: Record<string, (a: any) => Promise<{ content: Array<{ type: string; text: string }> }>> = {}
  const server = { tool: (name: string, _d: string, _s: unknown, h: (a: any) => any) => { handlers[name] = h } }
  return { server, handlers }
}

/** A fake SessionService whose only used method is `get(id) → { workspaceId }`. */
function fakeSessions(map: Record<string, { workspaceId?: string }>): SessionService {
  return { get: (id: string) => map[id] } as unknown as SessionService
}

function parse<T = any>(res: { content: Array<{ text: string }> }): T {
  return JSON.parse(res.content[0].text) as T
}

let dir: string
let svc: ActionButtonService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ab-mcp-test-"))
  svc = new ActionButtonService({ dir, now: () => Date.now() })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function register(sessions: SessionService, identity: TerminalIdentity) {
  const { server, handlers } = fakeServer()
  registerActionButtonTools(server as any, svc, sessions, identity)
  return handlers
}

describe("add_action_button — identity binding", () => {
  it("a session button lands in the CALLER's owning session", async () => {
    const h = register(fakeSessions({ "sess-1": { workspaceId: "ws-A" } }), { sessionId: "sess-1" })
    const btn = parse(await h.add_action_button({ label: "Run tests", prompt: "npm test", scope: "session" }))
    expect(btn.scope).toBe("session")
    expect(btn.ownerId).toBe("sess-1")
    expect(svc.listForOwner("session", "sess-1")).toHaveLength(1)
  })

  it("a workspace button lands in the caller's session's workspace (NOT a passed/active id)", async () => {
    const h = register(fakeSessions({ "sess-1": { workspaceId: "ws-A" } }), { sessionId: "sess-1" })
    const btn = parse(await h.add_action_button({ label: "Deploy", prompt: "deploy", scope: "workspace" }))
    expect(btn.scope).toBe("workspace")
    expect(btn.ownerId).toBe("ws-A")
  })

  it("a workspace button from an untagged session lands in the untagged bucket", async () => {
    const h = register(fakeSessions({ "sess-1": {} }), { sessionId: "sess-1" })
    const btn = parse(await h.add_action_button({ label: "Global", prompt: "x", scope: "workspace" }))
    expect(btn.ownerId).toBe(UNTAGGED_STEM)
  })

  it("refuses a session button from an anonymous caller (no bound session)", async () => {
    const h = register(fakeSessions({}), {})
    const res = await h.add_action_button({ label: "x", prompt: "p", scope: "session" })
    expect(res.content[0].text.toLowerCase()).toContain("session")
    expect(svc.list()).toHaveLength(0)
  })

  it("surfaces the cap error string", async () => {
    const h = register(fakeSessions({ "sess-1": {} }), { sessionId: "sess-1" })
    for (let i = 0; i < 8; i++) await h.add_action_button({ label: `b${i}`, prompt: "p", scope: "session" })
    const res = await h.add_action_button({ label: "over", prompt: "p", scope: "session" })
    expect(res.content[0].text).toContain("maximum")
  })
})

describe("list_action_buttons — the caller's union", () => {
  it("returns the caller's session ∪ workspace buttons", async () => {
    const h = register(fakeSessions({ "sess-1": { workspaceId: "ws-A" } }), { sessionId: "sess-1" })
    await h.add_action_button({ label: "sesbtn", prompt: "p", scope: "session" })
    await h.add_action_button({ label: "wsbtn", prompt: "p", scope: "workspace" })
    // A different session's button must NOT appear.
    svc.add("session", "sess-2", { label: "other", prompt: "p" })
    const list = parse<Array<{ label: string }>>(await h.list_action_buttons({}))
    expect(list.map((b) => b.label).sort()).toEqual(["sesbtn", "wsbtn"])
  })
})

describe("remove_action_button — scoped to the caller", () => {
  it("removes the caller's own session button", async () => {
    const h = register(fakeSessions({ "sess-1": {} }), { sessionId: "sess-1" })
    const btn = parse(await h.add_action_button({ label: "a", prompt: "p", scope: "session" }))
    const res = await h.remove_action_button({ id: btn.id })
    expect(res.content[0].text).toContain("removed")
    expect(svc.list()).toHaveLength(0)
  })

  it("refuses to remove a DIFFERENT session's button", async () => {
    svc.add("session", "sess-2", { label: "other", prompt: "p" })
    const otherId = svc.listForOwner("session", "sess-2")[0].id
    const h = register(fakeSessions({ "sess-1": {} }), { sessionId: "sess-1" })
    const res = await h.remove_action_button({ id: otherId })
    expect(res.content[0].text.toLowerCase()).toContain("different session")
    expect(svc.list()).toHaveLength(1) // untouched
  })

  it("refuses to remove a button in a DIFFERENT workspace", async () => {
    svc.add("workspace", "ws-B", { label: "other-ws", prompt: "p" })
    const otherId = svc.listForOwner("workspace", "ws-B")[0].id
    const h = register(fakeSessions({ "sess-1": { workspaceId: "ws-A" } }), { sessionId: "sess-1" })
    const res = await h.remove_action_button({ id: otherId })
    expect(res.content[0].text.toLowerCase()).toContain("different workspace")
    expect(svc.list()).toHaveLength(1)
  })

  it("removes the caller's own workspace button (incl. untagged)", async () => {
    const h = register(fakeSessions({ "sess-1": {} }), { sessionId: "sess-1" })
    const btn = parse(await h.add_action_button({ label: "g", prompt: "p", scope: "workspace" }))
    const res = await h.remove_action_button({ id: btn.id })
    expect(res.content[0].text).toContain("removed")
    expect(svc.listForOwner("workspace", null)).toHaveLength(0)
  })

  it("reports a not-found id", async () => {
    const h = register(fakeSessions({ "sess-1": {} }), { sessionId: "sess-1" })
    const res = await h.remove_action_button({ id: "ghost" })
    expect(res.content[0].text.toLowerCase()).toContain("not found")
  })
})
