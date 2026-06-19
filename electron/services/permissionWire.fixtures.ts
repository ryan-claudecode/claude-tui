/**
 * BO-3 — VERBATIM wire shapes captured from a LIVE `claude -p` headless run
 * (v2.1.170, Windows) using `--permission-prompt-tool`. These are the ground
 * truth the PermissionRequest/PermissionDecision contracts and the approve_tool
 * MCP tool are built against. See docs/spikes/bo3-permission-prompt.md for the
 * full spike (commands, allow/deny round-trip, "always allow" persistence).
 *
 * KEY FINDINGS pinned here:
 *  1. The permission tool's `arguments` are snake_case: { tool_name, input,
 *     tool_use_id }. `_meta` separately carries `claudecode/toolUseId`.
 *  2. ALLOW must echo `updatedInput` — a bare {"behavior":"allow"} is rejected as
 *     invalid and the gated tool NEVER runs (proved: the file was not created).
 *  3. DENY is {"behavior":"deny","message":"…"}; the blocked call surfaces in the
 *     result event's `permission_denials[]`.
 */

/** The EXACT `arguments` object the `--permission-prompt-tool` MCP tool received
 *  for a `Write` call (captured verbatim; only the absolute path is trimmed). */
export const PERMISSION_TOOL_INPUT_WRITE = {
  tool_name: "Write",
  input: { file_path: "C:\\Users\\ryguy\\...\\foo.txt", content: "hi" },
  tool_use_id: "toolu_01MMx74aTGpKCuH9A6cniNaA",
} as const

/** A captured `Bash` permission request — different `input` shape (command). */
export const PERMISSION_TOOL_INPUT_BASH = {
  tool_name: "Bash",
  input: { command: "printf 'hi' > foo.txt && od -c foo.txt", description: "Create foo.txt" },
  tool_use_id: "toolu_019c8sFxDooRGAqhvxucDm3j",
} as const

/** The `_meta` sibling claude attaches to the tool call (NOT in `arguments`). */
export const PERMISSION_TOOL_META = {
  progressToken: 2,
  "claudecode/toolUseId": "toolu_01MMx74aTGpKCuH9A6cniNaA",
} as const

/** The ALLOW response that LET the gated tool run (file created). updatedInput
 *  echoes the original input when the user didn't edit it. */
export const PERMISSION_RESULT_ALLOW = {
  behavior: "allow",
  updatedInput: { file_path: "C:\\Users\\ryguy\\...\\foo.txt", content: "hi" },
} as const

/** The DENY response that BLOCKED the gated tool. */
export const PERMISSION_RESULT_DENY = {
  behavior: "deny",
  message: "spike: denied by host",
} as const

/** What a denied call looks like in the final `result` event (for reference;
 *  permissions do NOT ride the stdout StreamEvent union — this is just the audit
 *  trail the result carries). */
export const RESULT_PERMISSION_DENIALS = [
  {
    tool_name: "Write",
    tool_use_id: "toolu_01WNks71vLf3v3hSvtmyiaNw",
    tool_input: { file_path: "C:\\Users\\ryguy\\...\\foo.txt", content: "hi" },
  },
] as const
