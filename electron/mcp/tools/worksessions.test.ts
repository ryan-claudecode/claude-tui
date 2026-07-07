import { describe, it, expect } from "vitest"
import { registerWorkSessionTools } from "./worksessions"
import type { SessionService } from "../../services/sessions"
import type { PanelService } from "../../services/panels"

/**
 * CAPP-75 — MCP tool round-trip for list_folder_conversations + restore_conversation.
 * A fake McpServer captures each registered tool handler by name; a fake
 * SessionService records calls + returns canned data. Asserts the public JSON shape
 * comes back and the args flow through correctly.
 */
function fakeServer() {
  const handlers: Record<string, (a: any) => Promise<{ content: Array<{ type: string; text: string }> }>> = {}
  const server = {
    tool: (name: string, _d: string, _s: unknown, h: (a: any) => any) => {
      handlers[name] = h
    },
  }
  return { server, handlers }
}

describe("worksessions MCP tools — CAPP-75", () => {
  it("list_folder_conversations returns the discovered list as JSON", async () => {
    const convos = [{ id: "c1", updatedAt: 5, preview: "hi" }]
    const calls: string[] = []
    const ws = {
      listFolderConversations: (folder: string) => {
        calls.push(folder)
        return convos
      },
    } as unknown as SessionService
    const { server, handlers } = fakeServer()
    registerWorkSessionTools(server as any, ws, {} as unknown as PanelService, {} as any, {})

    const res = await handlers["list_folder_conversations"]({ folder: "C:\\proj\\foo" })
    expect(calls).toEqual(["C:\\proj\\foo"])
    expect(JSON.parse(res.content[0].text)).toEqual(convos)
  })

  it("restore_conversation returns the new { session, terminalId }", async () => {
    const ws = {
      openConversationInFolder: (folder: string, id: string) => ({
        session: { id: "s1", name: "Untitled session", folder, convo: id },
        terminalId: "t1",
      }),
    } as unknown as SessionService
    const { server, handlers } = fakeServer()
    registerWorkSessionTools(server as any, ws, {} as unknown as PanelService, {} as any, {})

    const res = await handlers["restore_conversation"]({
      folder: "C:\\proj\\foo",
      conversation_id: "conv-9",
    })
    const out = JSON.parse(res.content[0].text)
    expect(out.terminalId).toBe("t1")
    expect(out.session.id).toBe("s1")
  })

  it("restore_conversation returns a graceful error message when restore fails", async () => {
    const ws = {
      openConversationInFolder: () => undefined,
    } as unknown as SessionService
    const { server, handlers } = fakeServer()
    registerWorkSessionTools(server as any, ws, {} as unknown as PanelService, {} as any, {})

    const res = await handlers["restore_conversation"]({ folder: "/x", conversation_id: "bad" })
    expect(res.content[0].text).toMatch(/could not restore/i)
  })
})

describe("post_output MCP tool — CAPP-132 (identity-bound; per-kind validation)", () => {
  function setup(identity: { terminalId?: string } = { terminalId: "tid-1" }) {
    const posts: Array<{ tid: string; entry: any }> = []
    const terminals = {
      postExplicitOutput: (tid: string, entry: any) => {
        posts.push({ tid, entry })
        return true
      },
    }
    const { server, handlers } = fakeServer()
    registerWorkSessionTools(
      server as any,
      {} as unknown as SessionService,
      {} as unknown as PanelService,
      terminals as any,
      identity,
    )
    return { posts, post: handlers["post_output"] }
  }

  it("routes an explicit link to postExplicitOutput with the caller's bound terminal id + source:'agent'", async () => {
    const { posts, post } = setup({ terminalId: "tid-9" })
    const res = await post({ kind: "link", title: "PR #128", url: "https://github.com/x/y/pull/128" })
    expect(posts).toHaveLength(1)
    expect(posts[0].tid).toBe("tid-9")
    expect(posts[0].entry).toMatchObject({
      kind: "link",
      title: "PR #128",
      url: "https://github.com/x/y/pull/128",
      source: "agent",
    })
    expect(res.content[0].text).toMatch(/posted link/i)
  })

  it("a file post carries the path; a note post carries the text", async () => {
    const { posts, post } = setup()
    await post({ kind: "file", title: "report.md", path: "/repo/report.md" })
    await post({ kind: "note", title: "Findings", text: "3 bugs found" })
    expect(posts[0].entry).toMatchObject({ kind: "file", path: "/repo/report.md", source: "agent" })
    expect(posts[1].entry).toMatchObject({ kind: "note", text: "3 bugs found", source: "agent" })
  })

  it("enforces per-kind requirements (link→url, file→path, note→text) and does NOT post on a violation", async () => {
    const { posts, post } = setup()
    expect((await post({ kind: "link", title: "x" })).content[0].text).toMatch(/requires a url/i)
    expect((await post({ kind: "file", title: "x" })).content[0].text).toMatch(/requires a path/i)
    expect((await post({ kind: "note", title: "x" })).content[0].text).toMatch(/requires text/i)
    expect(posts).toHaveLength(0)
  })

  it("errors (does not post) when no terminal identity is bound and none is passed", async () => {
    const { posts, post } = setup({}) // no bound terminalId
    const res = await post({ kind: "link", title: "x", url: "https://a.b" })
    expect(res.content[0].text).toMatch(/no terminal identity/i)
    expect(posts).toHaveLength(0)
  })
})
