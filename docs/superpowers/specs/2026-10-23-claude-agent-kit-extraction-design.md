# claude-agent-kit — Extracting ClaudeTUI's reusable core into a library

**Date:** 2026-10-23
**Status:** Design approved in conversation — spec awaiting review, then implementation plan
**Owner:** ryanhartwig (GitHub) — the library repo lives under this account, NOT under the `ryan-claudecode` org that hosts the app

## Goal

Pull the transportable parts of ClaudeTUI into a private, versioned npm package so a future app can get:

- Claude output rendering and user input over headless `claude -p` + stream-json, riding on the user's Claude Code login (no Anthropic API key).
- The permission gate (`approve_tool`) and its prompt UI.
- Push-to-talk speech-to-text (Parakeet via sherpa-onnx) with hotwords.
- The rendering views: agent transcript, composer, pickers, context meter, markdown, and the panel set (diff / code / table / image / form / git / markdown) with ModalHost.

ClaudeTUI itself becomes the first consumer. Copying the code out without migrating the app would produce two forks that drift within weeks, so **migration is in scope**: when this work is done, the app imports these modules from the package and has no private copy.

## Non-goals (out of scope)

- Model catalog (`electron/services/modelCatalog.ts`) — reads the Claude Code OAuth token off disk to call `GET /v1/models`; tighter coupling than the rest and not requested. Stays in the app.
- Sessions / work-session containers, attention queue, scheduler, workspaces, the xterm PTY path, the `claude /login` terminal, `SchedulePanel`, `SessionOverviewPanel`, `ContextInspectorPanel` — app-domain, stay.
- The Electron STT runtime binding (`electron/stt/runtime.ts`, the `utilityProcess` fork) and asar-unpack configuration — every consumer owns its own Electron binding.
- Publishing to a registry. Consumption is by git tag (see "Consumption").
- Any behavior change. Every phase is a pure move + seam; the app must look and act identically after each one.

## Classification and precondition

Architectural: new project + extraction from a working app. The library's one hard precondition, documented in its README: **Claude Code CLI installed and signed in** on the consuming machine. The engine spawns `claude -p` and never holds a token.

## Downstream consumer: a multi-agent orchestrator

The next app the owner plans is one where the user talks ONLY to an orchestrator agent, which spawns role-based agents (technical grounding, reviewer, QA, designer, architectural analysis, …). That app is out of scope here, but it is the reason the library exists, so it imposes three constraints on the engine and the React layer. None of them change behavior in ClaudeTUI.

1. **N agents, no privileged terminal.** `HeadlessAgentEngine` keeps per-agent state keyed by id (busy, queue, pending permission, catalog) and has no concept of "the foreground terminal" or of a renderer. `emit` is just a sink; a consumer may route one agent's events into another agent's stdin instead of a UI. Today's `TerminalService` already works this way for N headless terminals; the extraction must not fold any single-terminal assumption back in.
2. **Per-agent spawn options as an object, not positionals.** `engine.create(opts: SpawnAgentOptions)` where `SpawnAgentOptions = { name?, cwd?, sessionId?, resumeConversationId?, allowedTools?, model?, effort?, ultracode?, appendSystemPrompt?, extraArgs? }`. The first eight are today's `createHeadless` positionals. `appendSystemPrompt` maps to `--append-system-prompt` and `extraArgs` is passed through verbatim after the pinned flags; together they are what a role-based spawn needs and they cost nothing in ClaudeTUI (unused = flags omitted, spawn byte-identical). The `TerminalService` façade keeps its positional `createHeadless` signature and builds the object.
3. **UI components take an agent id, never a global.** Every `./react` component already renders one terminal id and reads its transcript through the injected store, so the orchestrator app can mount one `AgentSurface` for the orchestrator and, optionally, read-only `AgentView`s for the role agents. The host-API slices are the full contract a non-Electron host (or an Electron host with a different preload) must satisfy.

## Survey findings that shaped the design

| Area | State today | What it needs |
|---|---|---|
| `electron/services/streamProtocol.ts` | zero imports, already consumed by main, preload, AND renderer (20+ importers) | nothing — it IS the shared contract |
| `electron/stt/{protocol,download,hotwords}.ts`, `electron/services/stt.ts` | pure; `SttService` already takes an injected `SttDeps` | nothing |
| everything in `src/lib/` used by the agent UI | pure, no React, no `window`, only `import type` coupling; `agentTranscript.ts` is already imported by the MAIN process (`terminals.ts:20`) | nothing |
| `streamEvents.ts` | imports `logWarn` from the app's fs logger | inject a `warn` callback |
| `transcripts.ts`, `transcriptHistory.ts` | circular import with `terminals.ts` over the 3-line `encodeProjectDir` | move the helper into the library |
| `AgentModelPicker`, `AgentEffortPicker`, `AgentUltracodeToggle`, `AgentRail`, `AgentComposer`, `AgentSurface`, `AgentView`, `useDictation`, `usePermissions`, `useSlashPicker` | call `window.api` directly (1–5 methods each) | a host-API context |
| `FormPanel.tsx:40` | the one panel that calls `window.api.submitForm` instead of going through `PanelApi` | route through `PanelApi` |
| headless engine inside `terminals.ts` (3000 lines) | ~1000 lines are headless-only; touches Electron through ONE 5-line method (`sendToRenderer`); never references Session/Attention/Workspace services | extract a class with 3 injection points |
| `window.api` typing | a ~200-line ambient `declare global` in `src/App.tsx:65-267`, hand-synced with `preload.ts`; no named interface | the library owns `AgentHostApi`; preload is checked with `satisfies` |
| CSS | one 6582-line `src/App.css`; strict per-component class prefixes (`.agent-*`, `.panel-*`, `.markdown-body`); theme tokens (`--bg-*`, `--text-*`, `--accent*`, radii, spacing, motion) under `data-theme` | mechanical slice along the existing banner comments |

## Package design

### Repo

- GitHub: `ryanhartwig/claude-agent-kit`, **private**.
- Local checkout: `C:\Users\ryguy\projects\claude-agent-kit` (sibling of `claude-tui-app`; the `file:` link in the dev phases assumes this).
- Package name: `@ryanhartwig/claude-agent-kit`.
- Single package with subpath exports. **Not a monorepo** — one developer, one consumer; a monorepo adds tooling with nothing to justify it.

### Entry points

| Export | Contents | Runtime |
|---|---|---|
| `./protocol` | stream-json event + message types, `HEADLESS_FLAGS`, channel-name constants, permission wire shapes + `buildPermissionResult`, `AgentCatalog`, model/effort option tables, `ProcLike` / `SpawnProc` / `SpawnProcOptions`, STT protocol (`SttStatus`, `SttProgress`, `MODEL_FILES`, …), slash-command routing table + `UI_SLASH_COMMAND_CHANNEL` | any |
| `./core` | `agentTranscript` (reducer, cost math), `transcriptStore`, `transcriptWindow`, `smoothReveal`, `scrollStick`, `toolGroups`, `contextMeter`, `slashCatalog`, `micInteraction`, `agentRail`, `agentRailOutputs`, `questionSubmit`, `outputDerivation`, `backgroundTasks`, `permissionView`, `insertAtCursor`, `dictationEsc` | any |
| `./engine` | `HeadlessAgentEngine` (spawn, stdin sink, input queue + FIFO flush, permission gate, catalog capture/seed, foreground state, turn cost/outputs, background-task tracking), `LineBuffer` + `parseStreamLine`, `TranscriptAssigner`, `readTranscriptEvents`, `encodeProjectDir`, `fakeStream` (test double) | Node |
| `./stt` | `SttService`, `SttDeps`, model download (`download.ts`), `hotwords.ts`, the worker entry (`sttWorker`) | Node |
| `./mcp` | `registerPermissionTool(server, engine, identity)` — the `approve_tool` gate against a 3-method structural interface, not `TerminalService` | Node |
| `./react` | `AgentHostProvider` / `useAgentHost`, `AgentView`, `AgentSurface`, `AgentComposer`, `PermissionPrompt`, `SlashCommandPicker`, `QueuedMessages`, `AgentModelPicker`, `AgentEffortPicker`, `AgentUltracodeToggle`, `AgentRail`, `ContextMeterBar`, `MarkdownView`, `BlockExpandButton`, hooks `useDictation`, `usePermissions`, `useSlashPicker`, `useSmoothReveal`, `useAgentQueue`, `useFocusTrap`, `audioCapture`, `reducedMotion` | renderer |
| `./panels` | `PanelApi` (host-agnostic subset), `PanelContent`, `ModalHost`, `DiffPanel`, `CodePanel`, `TablePanel`, `ImagePanel`, `FormPanel`, `GitPanel`, `MarkdownPanel` | renderer |
| `./styles/tokens.css` | the three `data-theme` token sets (light / dark / cold-dark) | renderer |
| `./styles/agent.css` | the `.agent-*`, `.markdown-body`, context-meter, composer, picker, permission-prompt rules | renderer |
| `./styles/panels.css` | panel + ModalHost rules | renderer |

Fonts (`@font-face`, the `.woff2` assets) stay in the app. The token sheet references font-family variables with generic fallbacks.

### Dependencies

Peer (consumer installs; never bundled): `react`, `react-dom`, `react-markdown`, `remark-gfm`, `diff`, `@modelcontextprotocol/sdk`, `zod`, `sherpa-onnx-node` (optional peer), `tar-stream`, `unbzip2-stream`.
Dev: `typescript`, `vitest`, `@types/*`, `react`/`react-dom` (for tests).
Runtime deps: none.

### Build and layout

```
claude-agent-kit/
  package.json         exports map → dist/*, "prepare": "npm run build"
  tsconfig.json        strict, ES2022, moduleResolution bundler, jsx react-jsx, lib ES2022+DOM, types node
  vitest.config.ts     environment node (same as the app today); component tests already run in node
  src/protocol/  src/core/  src/engine/  src/stt/  src/mcp/  src/react/  src/panels/  styles/
  dist/                tsc output (ESM + .d.ts), styles copied — gitignored, built by prepare
```

`tsc` only, no bundler. The consumer's bundler (electron-vite in the app) bundles the library source into its own outputs, same as any dependency.

### The three seams

**1. Host API (renderer).** The library exports `AgentHostApi`, composed of sliced interfaces so a consumer can provide only what it mounts:

- `AgentStreamApi` — `onStreamEvent`, `getTranscriptEvents`, `onTerminalState`, `onSessionExit`
- `AgentInputApi` — `sendAgentInput`, `interruptAgent`, `restartTerminal`, `saveDroppedImage`, `getAgentQueue`, `removeQueuedInput`, `onAgentQueueChanged`, `getAgentCatalog`, `onUiSlashCommand`
- `AgentSettingsApi` — `setTerminalModel`, `addModelExtra`, `setTerminalEffort`, `setTerminalUltracode`, `setTerminalEngine`, `handoffTerminal`
- `PermissionApi` — `onPermissionRequest`, `onPermissionResolved`, `resolvePermission`
- `SttApi` — `sttStatus`, `sttTranscribe`, `sttAcquire`, `sttCancelAcquire`, `onSttProgress`
- `ShellApi` — `openExternalUrl`, `revealPath`, `showPanel`

Provided once via `<AgentHostProvider api={…}>`; components and hooks read it with `useAgentHost()`. **No library file references `window.api`.** The app wraps its root in the provider with `window.api`, and `electron/preload.ts` declares its agent slice with `satisfies AgentHostApi`, which replaces the hand-synced ambient global for those members.

The two app-specific things inside `AgentView` become props: the needs-auth / `startLogin` block is a `renderNeedsAuth?: () => ReactNode` render-prop (the app passes its login-terminal launcher), and `showPanel` goes through `ShellApi`.

**2. Engine (main).** `HeadlessAgentEngine` is constructed with:

```ts
interface EngineDeps {
  spawnProc: SpawnProc                                     // already injected today
  emit: (channel: string, ...args: unknown[]) => void      // replaces the one BrowserWindow call
  notify?: (level, title, body) => void                    // already optional today
  host: {
    mintId: () => string
    mcpConfigPath: (terminalId: string) => string | null   // null = no --mcp-config
    resumeArgs: (conversationId: string | null) => string[]
    projectsRoot: string                                   // ~/.claude/projects
    persistAllowRule: (cwd: string, tool: string) => void  // settings.local.json writer
    permissionGuardMs?: number
  }
}
```

It exposes the headless surface the app already calls — `create`, `teardown`, `sendMessage`, `submitInput`, queue ops, `requestPermission` / `resolvePermission` / `hasPendingPermission` / `denyPendingFor`, `getCatalog` / `seedCatalog`, `getTranscriptEvents`, `isBusy`, `waitForIdle`, `onEvent` — and emits the same `TerminalEvent` union. `TerminalService` keeps every public method name and becomes a façade that owns one engine and delegates, so `ipc.ts`, the MCP tools, and the e2e suite are untouched. The PTY half, `createLogin`, id/conversation bookkeeping shared with PTYs, and `kill`/`list`/`getActivity` stay in `TerminalService`.

**3. STT (main).** Already seamed by `SttDeps`. The library ships the service, download, hotwords, worker entry. The app's `electron/stt/runtime.ts` stays as the Electron `SttDeps` implementation; `electron/stt/sttWorker.ts` becomes a one-line re-export of the library's worker so `electron.vite.config.ts`'s second main entry still works.

### Consumption

- **During extraction (phases 1–4):** the app depends on `"@ryanhartwig/claude-agent-kit": "file:../claude-agent-kit"`. Both repos change together; a symlink avoids publish round-trips.
- **After phase 4:** switch the app to `"github:ryanhartwig/claude-agent-kit#v0.1.0"` so a clean clone builds without the sibling checkout. npm installs devDeps and runs `prepare` for git deps, so `dist/` never needs committing. The `gh` credential helper already authenticates https git operations on this machine.
- Tags: `v0.1.0` at the end of phase 4; `v0.0.x` after each earlier phase for traceability.

**Known gotcha, mitigated up front:** with a `file:` symlink, the library's own `node_modules/react` (a devDependency for its tests) can resolve as a second React copy and break hooks. The app's renderer Vite config gets `resolve.dedupe: ["react", "react-dom"]` in phase 2 before any component moves.

## Phasing

Every phase ends with ALL of: app `npm run typecheck` exit 0, app `npm test` green (baseline 90 files / 1483 tests), app `npm run package` succeeds, library `npm test` green, and a `git grep` proving the moved modules have no copy left in the app. Each phase is its own commit series in both repos and goes through the normal package → "ClaudeTUI - Deploy" loop so the owner can verify in daily use before the next phase starts.

### Phase 0 — Scaffold

Create the repo (private, under `ryanhartwig`), `package.json` with the exports map, tsconfig, vitest config, README stating the Claude Code precondition, empty entry files. App: add the `file:` dependency. Exit: `npm install` in the app links it; `import {} from "@ryanhartwig/claude-agent-kit/protocol"` typechecks.

### Phase 1 — Protocol + core (pure modules)

Move: `streamProtocol.ts`, `slashCommands.ts`, `backgroundTasks.ts`, `outputDerivation.ts`, `stt/protocol.ts`, the `ProcLike`/`SpawnProc`/`SpawnProcOptions` types (out of `terminals.ts:383-455`), `encodeProjectDir`, and the whole `src/lib` agent set listed under `./core`, each with its `.test.ts` and fixtures. App files that imported them switch to the package. Removes the main-process import of `src/lib/agentTranscript`. No seams needed.

### Phase 2 — Host API + presentational React + panels + CSS

Define `AgentHostApi` and the provider. Fix `FormPanel` to use `PanelApi`. Add `resolve.dedupe`. Move: `PermissionPrompt`, `SlashCommandPicker`, `ContextMeterBar`, `MarkdownView`, `BlockExpandButton`, `QueuedMessages`, `useSmoothReveal`, `useFocusTrap`, the seven panels, `PanelContent`, `ModalHost`, `PanelApi` (host-agnostic members; the app keeps a `ClaudeTuiPanelApi extends PanelApi` with the schedule/session/inspector members and its own `PanelContent` wrapper that handles those three app panels). Then the api-touching set: pickers, `AgentRail`, `AgentComposer`, `AgentSurface`, `AgentView` (with the render-prop), `useDictation`, `usePermissions`, `useSlashPicker`, `useAgentQueue`. Slice `App.css` into the three style sheets; the app imports them next to its remaining `App.css`. The companion window imports the same sheets.

### Phase 3 — STT + MCP permission tool

Move `stt.ts`, `download.ts`, `hotwords.ts`, `sttWorker.ts` (+ tests). App keeps `runtime.ts`, re-points its imports, `sttWorker.ts` becomes the re-export. Move `mcp/tools/permissions.ts` against the structural engine interface; `electron/mcp/tools.ts` calls the library's `registerPermissionTool`.

### Phase 4 — Engine

Extract `HeadlessAgentEngine` from `terminals.ts` (roughly lines 534-659, 1495-2026, 2028-2647, 2865-2895) plus `streamEvents.ts` (with the `warn` injection), `transcripts.ts`, `transcriptHistory.ts`, `fakeStream.ts`. `TerminalService` becomes the façade. Test rule: every test in `terminalsHeadless.test.ts` that exercises headless-only behavior moves to the library against the engine; tests that cross into PTY/session/kill/list behavior stay in the app against the façade. The headless `bo*Live.test.ts` live-verification tests stay in the app (they need a real `claude`). Tag `v0.1.0`, switch the app to the git-tag dependency, update `CLAUDE.md` + `docs/reference/structured-engine.md` to point at the package.

## Testing strategy

- Unit tests travel with their modules; the library's `npm test` must pass before the app is re-pointed.
- The app's test suite is the regression gate for each phase: it must stay at or above the baseline count, with the only deletions being tests that moved.
- The app's Playwright e2e suite (`npm run e2e`) runs at the end of phases 2 and 4 — the two phases that change what the renderer mounts.
- Phase 4 gets one live verification against real `claude -p` (the existing `bo4aLive` pattern) before tagging.

## Exit criteria (whole project)

1. `ryanhartwig/claude-agent-kit` exists, private, tagged `v0.1.0`, `npm test` green, README documents the precondition, each export, the `AgentHostApi` contract, `EngineDeps`, `SttDeps`, and the CSS token names as the theming API.
2. The app's `package.json` depends on the git tag; `rm -rf node_modules && npm install && npm run build && npm test && npm run package` succeeds from a clean clone.
3. `git grep -l "window.api" src/` returns no file that lives in the library; `git grep "../../electron/services/streamProtocol" src/` returns nothing.
4. `electron/services/terminals.ts` contains no stream-json parsing, queue, or permission-gate code — only the façade delegations and the PTY path.
5. The packaged app, deployed through the normal loop, behaves identically in daily use: structured terminals, permissions, queued messages, slash picker, dictation, panels, all three themes.

## Risks

- **Two-React duplication** via the symlink — mitigated by `dedupe` in phase 2 before any component moves.
- **Engine extraction scope creep** — `terminals.ts` has shared id/conversation bookkeeping; the façade keeps it, the engine receives `mintId`. If a shared concern can't be cleanly injected, it stays in the façade; the engine shrinks rather than the façade growing.
- **CSS slice misses a rule** — the e2e suite plus a manual theme pass at phase 2 catch it; the per-prefix convention makes the slice a grep, not a judgment.
- **Native addon in a library** — `sherpa-onnx-node` is an optional peer; the library never requires it at import time (the worker already lazy-`require`s it). Consumers own asar unpacking.
