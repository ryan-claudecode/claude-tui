import { ipcMain } from "electron"
import type { AttentionService } from "../services/attention"

/**
 * Attention-queue IPC (AQ-2). Thin wrappers over the AttentionService (AQ-1):
 * the service owns the queue + policy; these just route the renderer's two
 * clearing actions. Snapshots flow the other way over `attention:updated`
 * (pushed by the service), and `attention:jump` (OS-notification click) is a
 * main→renderer event with no handler here.
 *
 * The service is constructed lazily in setupIpc (it needs the main window), so
 * it is passed as a getter rather than captured at registration time.
 */
export function registerAttentionHandlers(deps: { getAttention: () => AttentionService }) {
  const { getAttention } = deps

  // A terminal was focused — clear its tier-2/3 entries (blocked persists).
  ipcMain.handle("attention:seen", (_e, terminalId: string) => {
    getAttention().seen(terminalId)
  })

  // The mission dashboard was opened — clear that mission's tier-2/3 entry
  // (MS-2 wires the preload accessor + the renderer call site).
  ipcMain.handle("attention:seen-mission", (_e, missionId: string) => {
    getAttention().seenMission(missionId)
  })

  // Manual dismiss (the hover × in the sidebar row).
  ipcMain.handle("attention:dismiss", (_e, id: string) => getAttention().dismiss(id))
}
