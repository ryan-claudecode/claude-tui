import { describe, it, expect, beforeEach, vi } from "vitest"

/**
 * CAPP-75 — worksession IPC handler round-trip for the conversation
 * discovery/restore pair. We mock `electron` so `ipcMain.handle` captures handlers
 * into a map, then drive a FAKE SessionService through them and assert the call +
 * the returned public shape.
 */
const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}))

import { registerWorkSessionHandlers } from "./worksession-handlers"
import type { SessionService } from "../services/sessions"
import type { RecallService } from "../services/recall"
import type { WorkspaceMemoryService, PromoteEntry } from "../services/workspaceMemory"

/** A no-op fake RecallService for the CAPP-75 round-trip tests (recall not exercised here). */
const fakeRecall = {
  recall: vi.fn(() => []),
  summary: vi.fn(() => ({ sessions: 0, findings: 0, ruledOut: 0 })),
  workspaceIdOf: vi.fn(() => undefined),
} as unknown as RecallService

/** A no-op fake WorkspaceMemoryService for the CAPP-75 round-trip tests
 *  (promote not exercised there — the CAPP-87 tests below use their own fake). */
const fakeMemory = {
  promoteFindings: vi.fn(() => []),
} as unknown as WorkspaceMemoryService

function call<T = unknown>(channel: string, ...args: unknown[]): T {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler registered for ${channel}`)
  return fn({} as unknown, ...args) as T
}

beforeEach(() => handlers.clear())

describe("worksession-handlers — CAPP-75 conversation discovery/restore", () => {
  it("list-folder-conversations forwards the folder and returns the public list", () => {
    const convos = [{ id: "c1", updatedAt: 5, preview: "hi" }]
    const fake = {
      listFolderConversations: vi.fn(() => convos),
      openConversationInFolder: vi.fn(),
    } as unknown as SessionService
    registerWorkSessionHandlers({
      workSessionService: fake,
      recallService: fakeRecall,
      workspaceMemoryService: fakeMemory,
    })

    const out = call("worksession:list-folder-conversations", "C:\\proj\\foo")
    expect((fake.listFolderConversations as any)).toHaveBeenCalledWith("C:\\proj\\foo")
    expect(out).toBe(convos)
  })

  it("restore-conversation forwards folder + id and returns { session, terminalId }", () => {
    const result = { session: { id: "s1" }, terminalId: "t1" }
    const fake = {
      listFolderConversations: vi.fn(),
      openConversationInFolder: vi.fn(() => result),
    } as unknown as SessionService
    registerWorkSessionHandlers({
      workSessionService: fake,
      recallService: fakeRecall,
      workspaceMemoryService: fakeMemory,
    })

    const out = call("worksession:restore-conversation", "C:\\proj\\foo", "conv-9")
    expect((fake.openConversationInFolder as any)).toHaveBeenCalledWith("C:\\proj\\foo", "conv-9")
    expect(out).toBe(result)
  })
})

describe("worksession-handlers — CAPP-87 / U3 promote + kill-with-promote", () => {
  const entries: PromoteEntry[] = [{ text: "root cause", originSessionId: "s1", originNoteId: "n1" }]

  it("promotable-findings forwards the sessionId and returns the candidate list", () => {
    const fake = {
      getPromotableFindings: vi.fn(() => entries),
    } as unknown as SessionService
    registerWorkSessionHandlers({
      workSessionService: fake,
      recallService: fakeRecall,
      workspaceMemoryService: fakeMemory,
    })

    const out = call("worksession:promotable-findings", "s1")
    expect((fake.getPromotableFindings as any)).toHaveBeenCalledWith("s1")
    expect(out).toBe(entries)
  })

  it("kill-with-promote resolves the OWNING session's workspace, promotes-THEN-kills", () => {
    const order: string[] = []
    const fake = {
      get: vi.fn(() => ({ workspaceId: "ws-A" })),
      killSession: vi.fn(() => order.push("kill")),
    } as unknown as SessionService
    const mem = {
      promoteFindings: vi.fn(() => {
        order.push("promote")
        return []
      }),
    } as unknown as WorkspaceMemoryService
    registerWorkSessionHandlers({
      workSessionService: fake,
      recallService: fakeRecall,
      workspaceMemoryService: mem,
    })

    call("worksession:kill-with-promote", "s1", entries)
    // Promote into the OWNING session's workspace (ws-A) — NOT the active selection.
    expect((mem.promoteFindings as any)).toHaveBeenCalledWith("ws-A", entries)
    expect((fake.killSession as any)).toHaveBeenCalledWith("s1")
    // Promote runs FIRST, kill SECOND.
    expect(order).toEqual(["promote", "kill"])
  })

  it("kill-with-promote falls back to the untagged bucket (null) when the session has no workspace", () => {
    const fake = {
      get: vi.fn(() => ({})), // no workspaceId
      killSession: vi.fn(),
    } as unknown as SessionService
    const mem = { promoteFindings: vi.fn(() => []) } as unknown as WorkspaceMemoryService
    registerWorkSessionHandlers({
      workSessionService: fake,
      recallService: fakeRecall,
      workspaceMemoryService: mem,
    })

    call("worksession:kill-with-promote", "s1", entries)
    expect((mem.promoteFindings as any)).toHaveBeenCalledWith(null, entries)
  })

  it("kill-with-promote does NOT kill when promoteFindings throws (fail-safe)", () => {
    const fake = {
      get: vi.fn(() => ({ workspaceId: "ws-A" })),
      killSession: vi.fn(),
    } as unknown as SessionService
    const mem = {
      promoteFindings: vi.fn(() => {
        throw new Error("disk full")
      }),
    } as unknown as WorkspaceMemoryService
    registerWorkSessionHandlers({
      workSessionService: fake,
      recallService: fakeRecall,
      workspaceMemoryService: mem,
    })

    expect(() => call("worksession:kill-with-promote", "s1", entries)).toThrow("disk full")
    // The session survives — kill never ran.
    expect((fake.killSession as any)).not.toHaveBeenCalled()
  })
})
