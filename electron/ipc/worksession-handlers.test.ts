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
    registerWorkSessionHandlers({ workSessionService: fake })

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
    registerWorkSessionHandlers({ workSessionService: fake })

    const out = call("worksession:restore-conversation", "C:\\proj\\foo", "conv-9")
    expect((fake.openConversationInFolder as any)).toHaveBeenCalledWith("C:\\proj\\foo", "conv-9")
    expect(out).toBe(result)
  })
})
