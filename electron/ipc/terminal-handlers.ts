import { ipcMain } from "electron"
import type { BrowserWindow } from "electron"
import type { TerminalService } from "../services/terminals"
import {
  TERMINAL_STREAM_CHANNEL,
  type TerminalStreamPayload,
  type PermissionDecision,
} from "../services/streamProtocol"

export function registerTerminalHandlers(deps: {
  sessionService: TerminalService
  win: BrowserWindow
}) {
  const { sessionService, win } = deps

  // BO-2: bridge parsed HEADLESS stream events to the renderer. BO-1 emits them
  // only on the in-process TerminalService.onEvent seam; here we forward the
  // `stream` ones over IPC. The in-process event keys the terminal as `id`, but
  // the renderer contract (TerminalStreamPayload) uses `terminalId` — remap it.
  sessionService.onEvent((e) => {
    if (e.type !== "stream") return
    if (win.isDestroyed()) return
    const payload: TerminalStreamPayload = { terminalId: e.id, event: e.event }
    win.webContents.send(TERMINAL_STREAM_CHANNEL, payload)
  })

  // Session IPC -- thin wrappers around service
  ipcMain.handle("terminal:create", (_e, name: string, cwd: string) =>
    sessionService.create(name, cwd),
  )
  ipcMain.handle("terminal:kill", (_e, id: string) => sessionService.kill(id))
  ipcMain.handle("terminal:focus", (_e, id: string) => sessionService.focus(id))
  ipcMain.handle("terminal:list", () => sessionService.list())
  ipcMain.handle("terminal:activity", () => sessionService.getActivity())
  ipcMain.handle("terminal:rename", (_e, id: string, newName: string) =>
    sessionService.rename(id, newName),
  )
  ipcMain.handle("terminal:handoff", (_e, id: string) => sessionService.handoff(id))
  ipcMain.on("terminal:write", (_e, id: string, data: string) =>
    sessionService.write(id, data),
  )
  ipcMain.on("terminal:resize", (_e, id: string, cols: number, rows: number) =>
    sessionService.resize(id, cols, rows),
  )
  ipcMain.handle("terminal:get-output", (_e, id: string, maxChars?: number) =>
    sessionService.getOutput(id, maxChars),
  )
  ipcMain.handle(
    "terminal:search-output",
    (_e, query: string, sessionId?: string, limit?: number) =>
      sessionService.searchOutput(query, sessionId, limit),
  )

  // BO-3 / CAPP-130 — the AgentComposer's human→agent input. THE SERVICE DECIDES:
  // submitAgentInput queues the raw payload when the foreground turn is busy (or parked
  // on a permission), else submits it immediately through the shared path — which folds
  // { text, attachments } into a structured user message for the stdin sink OR fires a
  // native-mapped app affordance (/config, /resume) via the renderer ui:slash-command
  // event. Centralizing the queue/route decision in the service kills the renderer↔
  // service race (the turn ending between the renderer's busy check and this IPC
  // arriving) and lets the auto-flush reuse the EXACT same submit path a fresh send does.
  // This handler is now a thin wrapper; `send` (fire-and-forget) parity with terminal:write.
  ipcMain.on(
    "agent:send-input",
    (_e, terminalId: string, msg: { text?: string; attachments?: string[] }) => {
      sessionService.submitAgentInput(terminalId, msg ?? {})
    },
  )

  // CAPP-130 — the composer's queued-message accessors: pull the current queue (on
  // mount / terminal switch) and remove one item by its queued id (the chip's ✕).
  ipcMain.handle("terminal:get-agent-queue", (_e, id: string) => sessionService.getAgentQueue(id))
  ipcMain.handle("terminal:remove-queued-input", (_e, id: string, queuedId: string) =>
    sessionService.removeQueuedInput(id, queuedId),
  )

  // BO-7 — the structured composer's `/`-picker catalog (slash commands + skills),
  // captured per terminal off the headless `init` event. Returns null until init
  // arrives (a headless `claude -p` emits init after the first user message) or for
  // a non-headless terminal.
  ipcMain.handle("agent:catalog", (_e, id: string) => sessionService.getCatalog(id))

  // BO-12 (CAPP-51) — rehydrate a structured chat: return the prior turns of a
  // conversation (by its Claude Code id) read off the on-disk transcript, so a
  // respawned/restored AgentView re-seeds its history instead of blanking. Keyed by
  // ccConversationId (stable across --resume), NOT terminal id (which changes).
  ipcMain.handle("transcript:get-events", (_e, ccConversationId: string) =>
    sessionService.getTranscriptEvents(ccConversationId),
  )

  // BO-3 — the renderer's PermissionPrompt decision: resolve the blocked
  // approve_tool MCP call. Returns whether a pending request was actually
  // resolved (false = already resolved / unknown id — a safe no-op).
  ipcMain.handle(
    "permission:resolve",
    (_e, id: string, decision: PermissionDecision) =>
      sessionService.resolvePermission(id, decision),
  )
}
