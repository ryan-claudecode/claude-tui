import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ActionButtonService } from "../../services/actionButtons"
import { MAX_LABEL_LEN, UNTAGGED_STEM } from "../../services/actionButtons"
import type { SessionService } from "../../services/sessions"
import type { TerminalIdentity } from "./shared"

/**
 * CAPP-104 (AB-1) — the MCP surface for agent-generated rail action buttons. An agent
 * offers a BUTTON when the user repeats a request (or asks for one); the user clicks it
 * in the Agent Rail to re-dispatch the stored prompt. The action is ALWAYS a prompt to
 * a Claude session — never raw shell — so a button adds zero capability an agent didn't
 * already have.
 *
 * IDENTITY-BINDING (matches the workspace-memory / scheduler tools — NO `getActiveId`
 * fallback EVER):
 *   • session scope → the CALLER's OWNING session (`identity.sessionId`); rejected when
 *     the caller has no bound session (an anonymous connection can't own a session button).
 *   • workspace scope → that session's workspace
 *     (`workSessions.get(identity.sessionId)?.workspaceId`); `undefined` → the untagged
 *     "All" bucket.
 * A caller can only remove a button in its own session / workspace.
 */
export function registerActionButtonTools(
  server: McpServer,
  actionButtons: ActionButtonService,
  // The caller's bound work session resolves the workspace for a workspace-scoped button.
  workSessions: SessionService,
  identity: TerminalIdentity = {},
) {
  const json = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  })
  const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] })

  /** The caller's workspace as a STORED owner id (untagged sentinel when unscoped). */
  const callerWorkspaceOwner = (): string => {
    const wsId = workSessions.get(identity.sessionId ?? "")?.workspaceId ?? null
    return wsId == null ? UNTAGGED_STEM : wsId
  }

  server.tool(
    "add_action_button",
    `Add a durable ACTION BUTTON to the Agent Rail — a labelled button the user clicks to re-dispatch a stored prompt into a live agent terminal. Offer one whenever the user REPEATS a request ("run the tests again", "redeploy") or explicitly asks for a button, so the repeat becomes one click. The action is ALWAYS this prompt sent to a Claude session (never raw shell). scope 'session' pins it to YOUR work session (it disappears when the session is killed); scope 'workspace' pins it to your session's workspace (it outlives any session). Label is visible text — keep it under ${MAX_LABEL_LEN} characters, words over icons. Set confirm:true for a destructive action (the button then asks once before dispatching). Max 8 buttons per owner. Returns the created button, or an error to act on (e.g. at the cap, or an anonymous caller for a session button).`,
    {
      label: z.string().describe(`Visible button text (≤ ${MAX_LABEL_LEN} chars), e.g. 'Run e2e suite'`),
      prompt: z.string().describe("The prompt dispatched to your session when the button is clicked"),
      scope: z
        .enum(["session", "workspace"])
        .describe("'session' = this work session only (dies with it); 'workspace' = the whole workspace (outlives sessions)"),
      confirm: z.boolean().optional().describe("Ask for a one-click confirm before dispatching (for a destructive action)"),
    },
    async ({ label, prompt, scope, confirm }) => {
      if (scope === "session") {
        const owner = identity.sessionId
        if (!owner) {
          return text("Can't add a session button: this connection isn't bound to a work session. Use scope 'workspace', or run inside a session.")
        }
        const res = actionButtons.add("session", owner, { label, prompt, confirm, createdBy: "agent" })
        return res.ok ? json(res.button) : text(res.error)
      }
      // workspace scope — the caller's own session's workspace (never the active selection)
      const wsId = workSessions.get(identity.sessionId ?? "")?.workspaceId ?? null
      const res = actionButtons.add("workspace", wsId, { label, prompt, confirm, createdBy: "agent" })
      return res.ok ? json(res.button) : text(res.error)
    },
  )

  server.tool(
    "list_action_buttons",
    "List the action buttons visible to you — your session's buttons plus your workspace's buttons. Each carries its id (for remove_action_button), label, prompt, scope, and confirm flag.",
    {},
    async () => {
      const wsId = workSessions.get(identity.sessionId ?? "")?.workspaceId ?? null
      return json(actionButtons.listForCaller(identity.sessionId, wsId))
    },
  )

  server.tool(
    "remove_action_button",
    "Remove an action button by its id (from list_action_buttons). You can only remove a button in your own session or your own workspace. Returns whether one was removed.",
    {
      id: z.string().describe("The action button id from list_action_buttons"),
    },
    async ({ id }) => {
      const button = actionButtons.findById(id)
      if (!button) return text(`Action button not found: ${id}`)

      if (button.scope === "session") {
        if (button.ownerId !== identity.sessionId) {
          return text("Refusing to remove a button that belongs to a different session.")
        }
        const ok = actionButtons.remove("session", button.ownerId, id)
        return text(ok ? "Button removed" : `Action button not found: ${id}`)
      }
      // workspace scope — must match the caller's own workspace
      if (button.ownerId !== callerWorkspaceOwner()) {
        return text("Refusing to remove a button that belongs to a different workspace.")
      }
      const ok = actionButtons.remove("workspace", button.ownerId, id)
      return text(ok ? "Button removed" : `Action button not found: ${id}`)
    },
  )
}
