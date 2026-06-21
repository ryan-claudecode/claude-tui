# BO-4a — Engine switch + go-live punch-list (LIVE verification)

Base commit: `030c132` (main). Branch: `bo4a-engine-switch`.

BO-4a flips the structured stream-json engine ON for real and closes the dormant
punch-list. This is the **first time BO-1 → BO-2 → BO-3 run together live**.

## What shipped

- **Config flag** `rendering.engine: "xterm" | "structured"` (`electron/config.ts`)
  — additive/optional, no schema bump (mirrors `AttentionConfig`). Added to the
  `TuiConfig` interface **and** `loadConfig()`'s projected keys, so it surfaces via
  `get_config` / `preload.getConfig`. `resolveRenderingEngine()` is the single
  default — **as of CAPP-39 gate ④ the default is "structured"** (the headless
  stream-json engine), and only an explicit `engine: "xterm"` selects the legacy PTY
  globally. (At BO-4a the default was "xterm"; the flip is documented below.)
- **Engine switch** in `TerminalService.create()`: `engine === "structured"` →
  `createHeadless`; else the legacy xterm path, byte-behavior-unchanged. Wired from
  config in `ipc.ts` (`setEngine(resolveRenderingEngine(config))`). create()/
  createHeadless dedup reconciled via the shared `mintTerminal()` +
  `bindConversation()` helpers (the BO-5 review item) — the xterm branch is
  identical.
- **Renderer fork** is config-driven (`src/lib/renderingEngine.ts` replaces the
  retired `agentViewFlag.ts`): structured → `AgentView` + `AgentComposer` +
  `PermissionPrompt` (now mounted **inside** the gate); xterm → `TerminalPane`.
- **`list()` + `getActivity()` include headless terminals** — so `broadcast_input`,
  companion panel input, `get_session_activity`, and `MissionService.reapStalledWorkers`
  all see structured terminals. Verified a healthy headless worker is **not reaped**.
- **Punch-list closed** (a) requestPermission liveness guard + TOCTOU test;
  (b) `persistAllowRule` writes `.claude/.gitignore`; (c) `trigger_handoff` routes
  structured terminals to the durable retire-&-continue; (d) boot-race: reset the
  active burst at `init` so a slow cold boot never enqueues a spurious "finished";
  (e) post-kill buffer-resurrection guard on `onStructuredEvent`/`captureOutput`;
  (f) cost surface totals ALL billed token classes (input + output + cache_creation
  + cache_read); (g) a permission requested while idle always surfaces a tier-2 "asked".

## LIVE end-to-end result — `rendering.engine: "structured"`, real `claude -p` 2.1.170

Harness: `electron/services/bo4aLive.test.ts` (gated `describe.runIf(BO4A_LIVE)` — the
normal `npm test` SKIPS it, staying hermetic). It wires the **real** `TerminalService`
+ **real** MCP server like `ipc.ts`, flips the engine on, and drives a from-scratch
headless session. Run with:

```
BO4A_LIVE=1 npx vitest run electron/services/bo4aLive.test.ts
```

| Link | Result |
|------|--------|
| (a) spawn headless `claude -p` from a from-scratch new session | ✅ via the engine switch (`create()` → `createHeadless`) |
| (b) render AgentView from the live stream (assistant text + result/cost) | ✅ stream kinds `init,assistant_delta,assistant_delta,unknown,result`; `result:"READY"`, `is_error:false`, `total_cost_usd 0.0785` |
| (c) composer input reaches the agent | ✅ `sendAgentMessage` → stdin sink → the agent answered "READY" |
| (d) REAL permission prompt — Allow runs the tool | ✅ real `claude` called `Write`; gate fired; **Allow** wrote `allowed.txt`=READY |
| (d) Deny blocks the tool | ✅ real `claude` called `Bash`; **Deny** → the command never ran |
| (d) "Always allow" persists + skips next time | ✅ `.claude/settings.local.json` `permissions.allow` = `["Write"]`, and `.claude/.gitignore` written |
| (e) active/idle + NEEDS YOU | ✅ structured idle on the `state` seam; a tier-2 "asked" surfaced in `AttentionService` while the gate was pending |

Real usage payload from the live `result` (confirms the punch-list-f cost fix):
`input_tokens 11091 + output_tokens 4 + cache_creation 2048 + cache_read 20222` →
**total 33365** billed tokens (the old `in+out` total of 11095 under-reported by ~3×;
cache tokens dwarf raw input on a warm turn).

### One integration nuance found live (not a bug; noted for BO-4b)

`claude -p --input-format stream-json` emits its `init`/system event only **after**
it receives the first stdin message — the boot rides the first turn, not the bare
spawn. So a freshly spawned structured terminal is quiet ("Waiting for the agent…")
and stays in its initial `active` state until the user sends their first composer
message. This is cosmetic (the sidebar dot reads active-not-idle pre-first-input) and
out of scope for BO-4a; a future polish could park a no-input structured terminal idle
on spawn. The boot-race guard (punch-list d) still applies once the first turn's `init`
lands.

## Gates

- `npm test` — 416 passed, live harness skipped (hermetic).
- `npm run build` — green.
- `npm run e2e` — green.

At BO-4a the default engine stayed **xterm** while the structured switch was proven.
**CAPP-39 gate ④ flipped the default to "structured"** — `resolveRenderingEngine` /
`resolveEngine` / `TerminalService`'s engine field now resolve to structured unless
config explicitly says `engine: "xterm"`. A hard cutover (solo-dev project, low risk);
the per-terminal raw-view escape hatch (`setTerminalEngine` / the AgentView "Raw view"
button) remains the per-terminal way back to xterm, and a command-palette rollback
write-path ("Default new terminals to raw terminal (xterm)") flips the default back.
