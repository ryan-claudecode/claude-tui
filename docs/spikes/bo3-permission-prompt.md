# BO-3 spike — headless permission-prompt mechanism (LIVE-captured)

Ground-truth capture for the BO-3 input + permissions work. Run against the real
subscription `claude` binary, **v2.1.170**, on Windows. This supersedes the
CAPP-36 ticket body on the permission mechanism.

> The captured shapes are pinned as code in
> `electron/services/permissionWire.fixtures.ts`.

## Mechanism: `--permission-prompt-tool <mcpToolName>`

- The flag **is supported** in v2.1.170 even though it is **absent from
  `claude --help`** (hidden flag). Probing `claude --permission-prompt-tool foo
  --zzz-bogus -p hi` errored on `--zzz-bogus`, not on `--permission-prompt-tool`
  → the flag parsed fine.
- When a tool needs permission, Claude **synchronously calls** the named MCP tool
  and **blocks** on its return. Permissions do **NOT** appear on the stdout
  stream-json — there is no new `StreamEvent` kind and no parser branch.
- The tool name must be MCP-prefixed: for our server (`claudetui`) it is
  `mcp__claudetui__approve_tool`.
- Permission mode must allow prompting: default mode (`--permission-mode default`,
  also the implicit default) routes un-pre-approved tools to the prompt tool.

### Spike harness

A throwaway **stdio** MCP server registered one low-level `approve_tool` (so
`request.params.arguments` is captured verbatim — no Zod stripping), logged the
input, and returned allow/deny from `SPIKE_BEHAVIOR`. Invocation:

```
claude -p "<prompt>" --output-format stream-json --verbose \
  --mcp-config <throwaway> \
  --permission-prompt-tool mcp__spike__approve_tool \
  --permission-mode default
```

## 1. Input shape the tool receives (`arguments`) — snake_case

```json
{
  "tool_name": "Write",
  "input": { "file_path": "…\\foo.txt", "content": "hi" },
  "tool_use_id": "toolu_01MMx74aTGpKCuH9A6cniNaA"
}
```

Plus a sibling `_meta`: `{ "progressToken": 2, "claudecode/toolUseId": "toolu_…" }`.

Field names are **snake_case** (`tool_name`, `input`, `tool_use_id`) — NOT the
`toolName`/`toolInput` the ticket guessed. `input` is the full tool argument
object (`{command,…}` for Bash, `{file_path,content}` for Write, etc.).

## 2. ALLOW **requires** `updatedInput` (the critical correction)

Returning a bare `{"behavior":"allow"}` **did not let the tool run** — the file
was never created and Claude reported the response failed validation
("`updatedInput` is undefined"). The working ALLOW is:

```json
{ "behavior": "allow", "updatedInput": { "file_path": "…\\foo.txt", "content": "hi" } }
```

i.e. allow must **echo `updatedInput`** — the original `input` when the user
didn't edit it, or an edited object to run instead. With this, `foo.txt` was
created → allow round-trip confirmed.

## 3. DENY

```json
{ "behavior": "deny", "message": "spike: denied by host" }
```

The gated tool did not run; it surfaced in the result event's
`permission_denials[]` as `{ tool_name, tool_use_id, tool_input }`.

## 4. Pre-approval / "always allow" persistence (all confirmed live)

| Mechanism | Result |
|---|---|
| `--allowedTools Write` on spawn | prompt tool **never called**, tool ran. |
| `.claude/settings.json` `{"permissions":{"allow":["Write"]}}` + `--setting-sources project` | prompt tool **never called**, tool ran. |
| `.claude/settings.local.json` `{"permissions":{"allow":["Write"]}}`, **default** sources (no flag) | prompt tool **never called**, tool ran. |

The prompt tool itself **cannot** persist a rule mid-session (it only returns
allow/deny). "Always allow `<tool>`" is therefore implemented by writing the rule
into the terminal cwd's **`.claude/settings.local.json` → `permissions.allow`**,
which the **next** spawn honors by default (the `local` source loads without any
`--setting-sources` flag, and `settings.local.json` is conventionally gitignored
so it neither pollutes commits nor collides with sibling agents). `--allowedTools`
on the next spawn is the equivalent app-controlled alternative.

## What the corrected design got wrong vs. live reality

- Ticket guessed `{ toolName, toolInput }`; reality is `{ tool_name, input,
  tool_use_id }` (snake_case).
- Ticket said `{"behavior":"allow"}` is sufficient; reality: **allow must carry
  `updatedInput`** or the tool is blocked.
- `--permission-prompt-tool` is real and supported, just hidden from `--help`.
