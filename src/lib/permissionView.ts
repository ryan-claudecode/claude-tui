/**
 * BO-3 — pure view-model for a tool-permission request's input. Keeps
 * PermissionPrompt presentational (and this logic node-testable). Maps a
 * tool name + its raw `input` (the live wire `input` object) to a tagged
 * descriptor the component renders: a Bash command, a Write content preview, an
 * Edit old→new diff, or a generic JSON summary.
 */

export type PermissionView =
  | { kind: "bash"; command: string; description?: string }
  | { kind: "write"; filePath: string; content: string }
  | { kind: "edit"; filePath: string; oldText: string; newText: string }
  | { kind: "generic"; summary: string }

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** Compact, never-throwing JSON for the generic fallback. */
export function genericSummary(input: unknown): string {
  if (input == null) return ""
  if (typeof input !== "object") return String(input)
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

export function describePermission(toolName: string, input: unknown): PermissionView {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  const name = (toolName || "").toLowerCase()

  if (name === "bash" || name === "powershell") {
    const command = str(o.command)
    if (command != null) return { kind: "bash", command, description: str(o.description) }
  }

  if (name === "write") {
    const filePath = str(o.file_path) ?? str(o.path)
    if (filePath != null) return { kind: "write", filePath, content: str(o.content) ?? "" }
  }

  if (name === "edit") {
    const filePath = str(o.file_path) ?? str(o.path)
    const oldText = str(o.old_string)
    const newText = str(o.new_string)
    if (filePath != null && (oldText != null || newText != null)) {
      return { kind: "edit", filePath, oldText: oldText ?? "", newText: newText ?? "" }
    }
  }

  return { kind: "generic", summary: genericSummary(input) }
}
