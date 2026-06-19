import { ipcMain } from "electron"
import type { BrowserWindow } from "electron"
import type { TerminalService } from "../services/terminals"
import {
  TERMINAL_STREAM_CHANNEL,
  agentMessageFromInput,
  type TerminalStreamPayload,
  type PermissionDecision,
} from "../services/streamProtocol"
import {
  classifySlashInput,
  UI_SLASH_COMMAND_CHANNEL,
  type UiSlashCommandPayload,
} from "../services/slashCommands"

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

  // BO-3 — the AgentComposer's human→agent input: fold { text, attachments } into
  // a structured user message and route it to the headless stdin sink (NOT a PTY
  // write). `send` (fire-and-forget) parity with terminal:write.
  //
  // BO-7 — intercept native-mapped built-in slash commands HERE, before folding for
  // stdin. A "native" route fires an existing app affordance (via the renderer
  // ui:slash-command event) instead of forwarding literal text to Claude; every
  // other input — Claude built-ins (/clear, /compact, /context), skills, plugin
  // skills, custom commands, and ordinary prose — forwards UNCHANGED (the slash is
  // preserved) so Claude expands it itself.
  //
  // BO-6 HOOK (CAPP-40): `/model` is deliberately NOT a native route (see
  // classifySlashInput) — the model picker + per-terminal --model is BO-6's. It
  // currently passes through to Claude; BO-6 adds its `model` branch in the
  // classifier and a matching arm in the renderer's ui:slash-command handler.
  ipcMain.on(
    "agent:send-input",
    (_e, terminalId: string, msg: { text?: string; attachments?: string[] }) => {
      const route = classifySlashInput(msg?.text ?? "")
      if (route.kind === "native") {
        if (!win.isDestroyed()) {
          const payload: UiSlashCommandPayload = { command: route.command, terminalId }
          win.webContents.send(UI_SLASH_COMMAND_CHANNEL, payload)
        }
        return
      }
      // BO-10 — never write to a stdin the agent can't read. While a permission
      // prompt blocks the turn (the synchronous approve_tool MCP call), stdin is
      // QUEUED unread — so a "sent" message would silently buffer and look lost
      // (the dogfooding bug). The renderer disables Send on the same busy signal
      // and keeps the text in the composer; this is the backend safety net. (Only
      // the COMPOSER path is gated — broadcast/mission/handoff inject via
      // TerminalService.write/sendAgentMessage directly and are unaffected.)
      if (sessionService.hasPendingPermission(terminalId)) return
      sessionService.sendAgentMessage(terminalId, agentMessageFromInput(msg ?? {}))
    },
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
