import { describe, it, expect } from "vitest"
import { registerWorkSessionTools } from "./worksessions"
import type { SessionService } from "../../services/sessions"
import type { PanelService } from "../../services/panels"
import type { RecallService } from "../../services/recall"

/** A no-op fake RecallService for the CAPP-75 round-trip tests (recall not exercised here). */
const fakeRecall = {
  recall: () => [],
  summary: () => ({ sessions: 0, findings: 0, ruledOut: 0 }),
  workspaceIdOf: () => undefined,
} as unknown as RecallService

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
    registerWorkSessionTools(server as any, ws, {} as unknown as PanelService, fakeRecall, {})

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
    registerWorkSessionTools(server as any, ws, {} as unknown as PanelService, fakeRecall, {})

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
    registerWorkSessionTools(server as any, ws, {} as unknown as PanelService, fakeRecall, {})

    const res = await handlers["restore_conversation"]({ folder: "/x", conversation_id: "bad" })
    expect(res.content[0].text).toMatch(/could not restore/i)
  })
})
