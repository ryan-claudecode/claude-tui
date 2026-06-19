import type { PermissionRequest, PermissionDecision } from "../../electron/services/streamProtocol"
import { describePermission } from "../lib/permissionView"

interface Props {
  requests: PermissionRequest[]
  /** Send the decision for `req`. The caller also clears the attention entry. */
  onResolve: (req: PermissionRequest, decision: Omit<PermissionDecision, "id">) => void
}

/**
 * BO-3 — the human approval surface for a headless agent's tool-permission
 * request (the renderer half of the approve_tool gate). Renders the HEAD of the
 * pending queue (tool + rendered input, with a diff-ish preview for Edit/Write)
 * and Allow / Deny / "Always allow <tool>". A queue indicator shows when more are
 * waiting behind the current one.
 */
export default function PermissionPrompt({ requests, onResolve }: Props) {
  const req = requests[0]
  if (!req) return null

  const view = describePermission(req.toolName, req.toolInput)
  const extra = requests.length - 1

  return (
    <div className="permission-overlay" role="dialog" aria-modal="true" aria-label="Tool permission request">
      <div className="permission-card">
        <div className="permission-head">
          <span className="permission-badge">Permission</span>
          <span className="permission-tool">{req.toolName || "tool"}</span>
          {extra > 0 && (
            <span className="permission-queue" title={`${extra} more waiting`}>
              +{extra} more
            </span>
          )}
        </div>

        <div className="permission-body">
          <PermissionInput view={view} />
        </div>

        <div className="permission-actions">
          <button
            className="permission-btn permission-allow"
            onClick={() => onResolve(req, { behavior: "allow" })}
          >
            Allow
          </button>
          <button
            className="permission-btn permission-always"
            onClick={() => onResolve(req, { behavior: "allow", alwaysAllow: true })}
            title={`Always allow ${req.toolName} for this folder`}
          >
            Always allow {req.toolName}
          </button>
          <button
            className="permission-btn permission-deny"
            onClick={() => onResolve(req, { behavior: "deny", message: "Denied by user" })}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  )
}

function PermissionInput({ view }: { view: ReturnType<typeof describePermission> }) {
  switch (view.kind) {
    case "bash":
      return (
        <div className="permission-input">
          {view.description && <div className="permission-desc">{view.description}</div>}
          <pre className="permission-code permission-bash">{view.command}</pre>
        </div>
      )
    case "write":
      return (
        <div className="permission-input">
          <div className="permission-path">{view.filePath}</div>
          <pre className="permission-code permission-add">{view.content}</pre>
        </div>
      )
    case "edit":
      return (
        <div className="permission-input">
          <div className="permission-path">{view.filePath}</div>
          {view.oldText && <pre className="permission-code permission-del">{view.oldText}</pre>}
          {view.newText && <pre className="permission-code permission-add">{view.newText}</pre>}
        </div>
      )
    case "generic":
      return (
        <div className="permission-input">
          <pre className="permission-code">{view.summary}</pre>
        </div>
      )
  }
}
