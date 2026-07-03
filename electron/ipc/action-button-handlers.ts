import { ipcMain } from "electron"
import type { ActionButtonService, ButtonScope } from "../services/actionButtons"
import { dispatchActionButton } from "../services/actionButtons"
import type { SessionService } from "../services/sessions"
import type { TerminalService } from "../services/terminals"
import { userMessage } from "../services/streamProtocol"

/**
 * CAPP-104 (AB-1) — thin wrappers over ActionButtonService for the main-window rail.
 * The `actionbuttons:updated` push is wired in ipc.ts off `onChanged` (like
 * `schedule:updated`); session-kill cleanup (`deleteForSession`) is hooked off the
 * `worksession:removed` seam there too.
 *
 * `actionbuttons:dispatch` is the click path: it resolves the target session's most
 * recent LIVE structured terminal (or spawns a fresh one) and delivers the button's
 * prompt over the stdin sink — the SAME `sendAgentMessage` seam the composer + scheduler
 * use. All the live-vs-spawn resolution lives in the pure `dispatchActionButton`
 * (deps-injected here), so it's unit-tested without Electron.
 */
export function registerActionButtonHandlers(deps: {
  actionButtonService: ActionButtonService
  workSessionService: SessionService
  terminalService: TerminalService
}) {
  const { actionButtonService, workSessionService, terminalService } = deps

  // The flat list across all owners — the renderer seed (the rail derives its subset).
  ipcMain.handle("actionbuttons:list", () => actionButtonService.list())

  ipcMain.handle(
    "actionbuttons:remove",
    (_e, scope: ButtonScope, ownerId: string | null, id: string) =>
      actionButtonService.remove(scope, ownerId, id),
  )

  // Click dispatch — resolve a live structured terminal (or spawn fresh), send the prompt.
  ipcMain.handle("actionbuttons:dispatch", (_e, buttonId: string, targetSessionId: string) => {
    const aliveIds = new Set(
      terminalService.getActivity().filter((a) => a.state !== "dead").map((a) => a.id),
    )
    return dispatchActionButton(
      {
        findButton: (id) => actionButtonService.findById(id),
        getSession: (id) => {
          const s = workSessionService.get(id)
          return s ? { name: s.name, terminals: s.terminals } : undefined
        },
        isAlive: (terminalId) => aliveIds.has(terminalId),
        spawnTerminal: (sessionId) => workSessionService.addTerminalToSession(sessionId)?.terminalId,
        sendPrompt: (terminalId, prompt) =>
          terminalService.sendAgentMessage(terminalId, userMessage(prompt)),
        // The failed-delivery reaper — only ever invoked on a terminal THIS dispatch
        // spawned (the resolver guards on `spawned`; e.g. the xterm legacy engine,
        // where sendAgentMessage always returns false). The scheduler's kill seam.
        killTerminal: (terminalId) => {
          terminalService.kill(terminalId)
        },
      },
      buttonId,
      targetSessionId,
    )
  })
}
