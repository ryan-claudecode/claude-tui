# claude-agent-kit — Phase 0 + 1: Scaffold and Pure-Module Move — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the private `ryanhartwig/claude-agent-kit` package and move ClaudeTUI's pure, dependency-free modules (stream protocol, STT protocol, slash routing, process types, transcript reducer and the rest of the agent `src/lib` set) into it, with the app consuming them through the package.

**Architecture:** One npm package, ESM, built by `tsc` only, with subpath exports (`/protocol`, `/core`, `/engine`). The app links it as a `file:` dev dependency to the sibling checkout and bundles it with electron-vite, so nothing about packaging changes. Every moved module is pure (no React, no `window`, no Electron, no `node:*`), so this phase is a pure relocation: files move, import specifiers change, the existing unit tests travel with the code and are the proof.

**Tech Stack:** TypeScript 6 (`module: NodeNext`), vitest 4, npm 9 `file:` links, `gh` CLI for the repo.

**Spec:** `docs/superpowers/specs/2026-10-23-claude-agent-kit-extraction-design.md` — this plan implements "Phase 0 — Scaffold" and "Phase 1 — Protocol + core". Phases 2, 3, 4 get their own plans after this one lands.

## Global Constraints

- Library repo: `ryanhartwig/claude-agent-kit`, **private**, under the `ryanhartwig` account (NOT the `ryan-claudecode` org). Local checkout `C:\Users\ryguy\projects\claude-agent-kit`, sibling of `C:\Users\ryguy\projects\claude-tui-app`.
- Package name `@ryanhartwig/claude-agent-kit`. `"type": "module"`. Runtime dependencies: **none**. Peer dependencies: none in this phase (nothing moved here needs one).
- App depends on it as `"file:../claude-agent-kit"` in **devDependencies** (it is bundled by electron-vite into `out/`; it must NOT land in `dependencies` or electron-builder will try to ship the symlink).
- No behavior change. Phase exit requires ALL of: app `npm run typecheck` exit 0; app `npm test` green with ≥ 1483 tests counting those that moved to the library; app `npm run package` succeeds; library `npm test` green; the `git grep` checks in Task 6 return nothing.
- Every moved module keeps its basename (e.g. `streamProtocol.ts` → `src/protocol/streamProtocol.ts`) so history and docs stay greppable. Each entry point is an `index.ts` barrel of `export *`.
- Library source uses explicit `.js` extensions on relative imports (required by `NodeNext`; the app's bundler resolution accepts them unchanged).
- Inside the library, cross-entry imports are RELATIVE (`../protocol/streamProtocol.js`), never the package's own specifier.
- Commit messages in both repos end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- The owner runs the packaged app daily. Never run `package:desktop`; the phase ends at `npm run package` and the owner deploys via the Desktop shortcut.

## Review Focus

1. **Stale library `dist/` after editing library source.** The app resolves `dist/*.js` through the symlink, so an edit to `../claude-agent-kit/src` that is not rebuilt silently runs old code in the app and in the app's tests. Task 2 chains `kit:build` into the app's `build` script and Task 6 extends `deploy-check.mjs` to scan the library's `src/`; Task 2's test proves the chained build sees a library change.
2. **Windows paths in `encodeProjectDir`.** Drive colons and backslashes must both become `-` (`C:\Users\x` → `C--Users-x`), and a forward-slash POSIX path must too. Task 4 pins both in the library's own unit test (today it is only tested indirectly via the context inspector).
3. **Barrel export collisions.** `export *` from two modules that export the same name is a compile error only when the name is used ambiguously, and a silent shadow otherwise. Verified today: no duplicate exported names across the protocol set or the core set; Task 3 and Task 5 re-run the duplicate check after the move.
4. **ESM-only package consumed by a CJS-bundled main process.** electron-vite emits `out/main/index.js` as CJS; rollup inlines the ESM library, so no `require()` of the package may remain anywhere. Task 2 greps for `require(` referencing the package after the first link.
5. **A stray deep import.** Importing `@ryanhartwig/claude-agent-kit/core/agentTranscript` bypasses the exports map and fails only at bundle time. Task 6's grep asserts every app import of the package targets exactly `/protocol`, `/core`, or `/engine`.

---

### Task 1: Scaffold the library repo with the first module (stream protocol)

**Files:**
- Create: `C:\Users\ryguy\projects\claude-agent-kit\package.json`
- Create: `C:\Users\ryguy\projects\claude-agent-kit\tsconfig.json`
- Create: `C:\Users\ryguy\projects\claude-agent-kit\tsconfig.build.json`
- Create: `C:\Users\ryguy\projects\claude-agent-kit\vitest.config.ts`
- Create: `C:\Users\ryguy\projects\claude-agent-kit\.gitignore`
- Create: `C:\Users\ryguy\projects\claude-agent-kit\README.md`
- Create: `C:\Users\ryguy\projects\claude-agent-kit\scripts\add-js-ext.mjs`
- Create: `C:\Users\ryguy\projects\claude-agent-kit\src\protocol\index.ts`
- Create (copied from app): `src\protocol\streamProtocol.ts`, `src\protocol\streamProtocol.test.ts`

**Interfaces:**
- Produces: package `@ryanhartwig/claude-agent-kit` with export `./protocol` re-exporting everything `electron/services/streamProtocol.ts` exports today (`HEADLESS_FLAGS`, `StreamEvent`, `AgentCatalog`, `PERMISSION_REQUEST_CHANNEL`, `buildPermissionResult`, `agentMessageFromInput`, `resolveModelOptions`, `MODEL_ALIASES`, `DEFAULT_MODEL`, …). Also the scripts `build`, `dev` (watch), `typecheck`, `test`, `prepare`.

- [ ] **Step 1: Create the directory and git repo**

```bash
mkdir -p /c/Users/ryguy/projects/claude-agent-kit/src/protocol /c/Users/ryguy/projects/claude-agent-kit/scripts
cd /c/Users/ryguy/projects/claude-agent-kit && git init -b main
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "@ryanhartwig/claude-agent-kit",
  "version": "0.0.0",
  "private": true,
  "description": "Reusable pieces of ClaudeTUI: headless `claude -p` stream protocol, transcript model, agent UI, STT. Requires Claude Code installed and signed in; never holds an API key.",
  "type": "module",
  "files": ["dist", "styles"],
  "exports": {
    "./protocol": {
      "types": "./dist/protocol/index.d.ts",
      "default": "./dist/protocol/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsc -p tsconfig.build.json --watch",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "prepare": "npm run build"
  },
  "devDependencies": {
    "@types/node": "^22.13.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.8"
  }
}
```

- [ ] **Step 3: Write the two tsconfigs**

`tsconfig.json` (editor + typecheck, includes tests):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "types": ["node"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

`tsconfig.build.json` (what `dist/` is built from, tests and fixtures excluded):

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["src/**/*.test.ts", "src/**/*.test.tsx", "src/**/*.fixtures.ts"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`, `.gitignore`, `README.md`**

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
  },
})
```

`.gitignore`:

```
node_modules/
dist/
*.log
```

`README.md`:

```markdown
# @ryanhartwig/claude-agent-kit

Reusable pieces of ClaudeTUI for building apps on top of Claude Code's headless mode.

## Precondition

The consuming machine must have the **Claude Code CLI installed and signed in**. Everything here drives `claude -p` over stream-json and rides on that login. The kit never holds an Anthropic API key.

## Entry points

| Import | What | Runs in |
|---|---|---|
| `@ryanhartwig/claude-agent-kit/protocol` | stream-json types, channel names, permission wire shapes, model/effort tables, process abstraction types, STT protocol, slash-command routing | anywhere |
| `@ryanhartwig/claude-agent-kit/core` | transcript reducer + store, cost math, context meter, tool grouping, smooth reveal, slash catalog, output derivation | anywhere |
| `@ryanhartwig/claude-agent-kit/engine` | headless engine (lands in a later phase); today: `encodeProjectDir` | Node |

## Developing against a sibling checkout

ClaudeTUI depends on this package via `file:../claude-agent-kit`. npm links the folder but does NOT build it, so after cloning or editing:

    npm run build        # one-shot
    npm run dev          # tsc --watch, keeps dist/ fresh while you edit

The app's `npm run build` runs this package's build first (`kit:build`), so a forgotten rebuild cannot ship stale code.

## Consuming from another app

    "@ryanhartwig/claude-agent-kit": "github:ryanhartwig/claude-agent-kit#v0.1.0"

npm installs the dev dependencies and runs `prepare`, which builds `dist/`. The repo is private; `gh auth login` on the machine is enough for https git access.
```

- [ ] **Step 5: Write `scripts/add-js-ext.mjs`** (adds the `.js` extension `NodeNext` requires to every relative import under `src/`; idempotent)

```js
// Appends ".js" to extensionless RELATIVE import/export specifiers under src/.
// NodeNext resolution requires it; vitest and bundlers map "./x.js" to "./x.ts".
// Idempotent: specifiers already ending in .js/.json/.css are left alone.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

const re = /(from\s+["'])(\.{1,2}\/[^"']+?)(?<!\.js)(?<!\.json)(?<!\.css)(["'])/g
let changed = 0
for (const file of walk("src")) {
  const src = readFileSync(file, "utf8")
  const next = src.replace(re, "$1$2.js$3")
  if (next !== src) {
    writeFileSync(file, next)
    changed++
    console.log("ext added:", file)
  }
}
console.log(`${changed} file(s) updated`)
```

- [ ] **Step 6: Copy the stream protocol module and its test from the app, write the barrel**

```bash
cp /c/Users/ryguy/projects/claude-tui-app/electron/services/streamProtocol.ts      src/protocol/streamProtocol.ts
cp /c/Users/ryguy/projects/claude-tui-app/electron/services/streamProtocol.test.ts src/protocol/streamProtocol.test.ts
```

`src/protocol/index.ts`:

```ts
export * from "./streamProtocol.js"
```

Then normalise extensions (the test imports `./streamProtocol`):

```bash
node scripts/add-js-ext.mjs
```

Expected: `ext added: src\protocol\streamProtocol.test.ts` and `1 file(s) updated`. `streamProtocol.ts` has no imports, so it is untouched.

- [ ] **Step 7: Install, typecheck, test, build**

```bash
npm install
npm run typecheck
npm test
npm run build
ls dist/protocol
```

Expected: typecheck exit 0; vitest reports `1 passed` test file (the streamProtocol suite, 10+ tests); `dist/protocol/` contains `index.js`, `index.d.ts`, `streamProtocol.js`, `streamProtocol.d.ts` and NO `*.test.*`.

- [ ] **Step 8: Commit and create the private GitHub repo**

```bash
git add -A
git commit -m "feat: scaffold @ryanhartwig/claude-agent-kit with the /protocol entry (streamProtocol)

Copied from claude-tui-app electron/services/streamProtocol.ts @ 5b78782.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh repo create ryanhartwig/claude-agent-kit --private --source=. --remote=origin --push
gh repo view ryanhartwig/claude-agent-kit --json visibility,url
```

Expected: `{"url":"https://github.com/ryanhartwig/claude-agent-kit","visibility":"PRIVATE"}`.

---

### Task 2: Link the package into the app and switch `streamProtocol` imports to it

**Files:**
- Modify: `C:\Users\ryguy\projects\claude-tui-app\package.json` (devDependencies + scripts)
- Create: `C:\Users\ryguy\projects\claude-tui-app\scripts\rewrite-kit-imports.mjs`
- Create: `C:\Users\ryguy\projects\claude-tui-app\scripts\kit-moves.phase1.json`
- Delete: `electron/services/streamProtocol.ts`, `electron/services/streamProtocol.test.ts`
- Modify (import specifiers only, via the script): `electron/config.ts`, `electron/ipc.ts`, `electron/ipc/terminal-handlers.ts`, `electron/preload.ts`, `electron/mcp/tools/permissions.ts`, `electron/mcp/tools/worksessions.ts`, `electron/services/terminals.ts`, `electron/services/sessions.ts`, `electron/services/streamEvents.ts`, `electron/services/outputDerivation.ts`, `electron/services/transcriptHistory.ts`, `electron/services/transcriptHistory.test.ts`, `src/App.tsx`, `src/components/AgentEffortPicker.tsx`, `src/components/AgentModelPicker.tsx`, `src/components/AgentRail.tsx`, `src/components/AgentUltracodeToggle.tsx`, `src/components/PermissionPrompt.tsx`, `src/components/QueuedMessages.tsx`, `src/hooks/useAgentQueue.ts`, `src/hooks/usePermissions.ts`, `src/hooks/usePermissions.test.ts`, `src/lib/agentTranscript.ts`, `src/lib/agentTranscript.test.ts`, `src/lib/transcriptStore.ts`, `src/lib/transcriptStore.test.ts`, `src/lib/slashCatalog.ts`, `src/lib/agentRailOutputs.ts`, `src/lib/resultCostSemantics.test.ts`, and any other file the script reports.

**Interfaces:**
- Consumes: `@ryanhartwig/claude-agent-kit/protocol` from Task 1.
- Produces: `scripts/rewrite-kit-imports.mjs <map.json>` — rewrites every relative import in `electron/`, `src/`, `e2e/` whose resolved target is a key of the map to the package specifier in its value. Reused by Tasks 3, 4, 5 and by the Phase 2–4 plans. App script `kit:build`.

- [ ] **Step 1: Add the dependency and scripts to the app's `package.json`**

In `devDependencies` add (keep alphabetical order):

```json
"@ryanhartwig/claude-agent-kit": "file:../claude-agent-kit",
```

In `scripts`, add `kit:build` and chain it into `build` and `dev`:

```json
"dev": "npm run kit:build && tsc -b && electron-vite build && electron .",
"build": "npm run kit:build && tsc -b && electron-vite build",
"kit:build": "npm --prefix ../claude-agent-kit run build",
"typecheck": "npm run kit:build && tsc -b",
```

- [ ] **Step 2: Install and confirm the link**

```bash
cd /c/Users/ryguy/projects/claude-tui-app && npm install
ls -la node_modules/@ryanhartwig/
node -e "import('@ryanhartwig/claude-agent-kit/protocol').then(m => console.log(Object.keys(m).length, 'exports; HEADLESS_FLAGS=', m.HEADLESS_FLAGS.join(' ')))"
```

Expected: `claude-agent-kit -> ../../../claude-agent-kit` (a symlink/junction) and a line like `NN exports; HEADLESS_FLAGS= -p --output-format stream-json --input-format stream-json --verbose ...` (the exact flag set is whatever `HEADLESS_FLAGS` is today; the point is that the ESM import resolves through the exports map).

- [ ] **Step 3: Write the import-rewrite script** at `scripts/rewrite-kit-imports.mjs`

```js
// Rewrites RELATIVE imports of modules that moved into @ryanhartwig/claude-agent-kit.
//
//   node scripts/rewrite-kit-imports.mjs scripts/kit-moves.phase1.json
//
// The map's keys are repo-relative module paths WITHOUT extension (the file that
// moved); values are the package specifier that now provides it. For every .ts/.tsx
// under electron/, src/, e2e/, each `from "./x"`, `import("./x")`, or `vi.mock("./x")`
// whose resolved target is a key is rewritten to the value. Nothing else is touched,
// so the diff is reviewable as "specifiers only".
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, dirname, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const mapPath = process.argv[2]
if (!mapPath) {
  console.error("usage: node scripts/rewrite-kit-imports.mjs <map.json>")
  process.exit(2)
}
const map = JSON.parse(readFileSync(resolve(root, mapPath), "utf8"))
const norm = (p) => p.replace(/\\/g, "/").toLowerCase()
const moved = new Map(Object.entries(map).map(([k, v]) => [norm(resolve(root, k)), v]))

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(p)
  }
  return out
}

const files = ["electron", "src", "e2e"].flatMap((d) => walk(join(root, d)))
const re = /(from\s+|import\s*\(\s*|vi\.mock\(\s*)(["'])(\.{1,2}\/[^"']+)\2/g
let changed = 0
for (const file of files) {
  const src = readFileSync(file, "utf8")
  const next = src.replace(re, (whole, lead, quote, spec) => {
    const target = norm(resolve(dirname(file), spec)).replace(/\.(ts|tsx|js)$/, "")
    const pkg = moved.get(target)
    return pkg ? `${lead}${quote}${pkg}${quote}` : whole
  })
  if (next !== src) {
    writeFileSync(file, next)
    changed++
    console.log("rewrote", relative(root, file))
  }
}
console.log(`${changed} file(s) rewritten`)
```

- [ ] **Step 4: Write the Phase 1 move map** at `scripts/kit-moves.phase1.json` (Tasks 3–5 append to it; this task uses only the first entry)

```json
{
  "electron/services/streamProtocol": "@ryanhartwig/claude-agent-kit/protocol"
}
```

- [ ] **Step 5: Delete the app copy and rewrite the importers**

```bash
git rm -q electron/services/streamProtocol.ts electron/services/streamProtocol.test.ts
node scripts/rewrite-kit-imports.mjs scripts/kit-moves.phase1.json
git grep -n "streamProtocol\"" -- electron src e2e
```

Expected: the script prints `rewrote …` for ~28 files; the final grep returns NOTHING (no relative `streamProtocol` specifier remains). If the grep finds a hit the script missed (e.g. a specifier using the `.ts` extension or a template string), fix that line by hand to `"@ryanhartwig/claude-agent-kit/protocol"`.

- [ ] **Step 6: Prove the build chain sees library changes (Review Focus 1)**

```bash
cd /c/Users/ryguy/projects/claude-agent-kit && printf '\n/** build-chain probe */\nexport const KIT_PROBE = 1\n' >> src/protocol/streamProtocol.ts
cd /c/Users/ryguy/projects/claude-tui-app && npm run typecheck && node -e "import('@ryanhartwig/claude-agent-kit/protocol').then(m => console.log('probe', m.KIT_PROBE))"
```

Expected: `probe 1` — `typecheck` rebuilt the library first. Then revert the probe:

```bash
cd /c/Users/ryguy/projects/claude-agent-kit && git checkout -- src/protocol/streamProtocol.ts && npm run build
```

- [ ] **Step 7: Run the gates (Review Focus 4 included)**

```bash
cd /c/Users/ryguy/projects/claude-tui-app
npm run typecheck
npm test
git grep -n "require(.*claude-agent-kit" -- electron src
```

Expected: typecheck exit 0; vitest `Test Files 89 passed | 3 skipped` and a passed-test count equal to 1483 minus the number of tests in the streamProtocol suite (about 20 `it(` blocks; read the library's vitest summary for the exact figure — app passed + library passed must equal 1483, 15 skipped unchanged); the `require` grep returns nothing.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json scripts/rewrite-kit-imports.mjs scripts/kit-moves.phase1.json
git add -A electron src
git commit -m "refactor(kit): consume streamProtocol from @ryanhartwig/claude-agent-kit/protocol

Links the sibling checkout as a file: devDependency, chains kit:build into
build/dev/typecheck, and adds scripts/rewrite-kit-imports.mjs for the phase moves.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Finish the `/protocol` entry — slash routing, STT protocol, process types

**Files:**
- Library create (copied): `src/protocol/slashCommands.ts`, `src/protocol/slashCommands.test.ts`, `src/protocol/sttProtocol.ts` (from `electron/stt/protocol.ts`)
- Library create (new): `src/protocol/proc.ts`
- Library modify: `src/protocol/index.ts`
- App delete: `electron/services/slashCommands.ts`, `electron/services/slashCommands.test.ts`, `electron/stt/protocol.ts`
- App modify: `electron/services/terminals.ts:383-455` (remove the `ProcLike`/`SpawnProcOptions`/`SpawnProc` declarations, import and re-export them instead), plus importers rewritten by the script: `electron/ipc/stt-handlers.ts`, `electron/ipc.ts`, `electron/preload.ts`, `electron/services/stt.ts`, `electron/services/stt.test.ts`, `electron/stt/runtime.ts`, `electron/stt/sttWorker.ts`, `src/App.tsx`, `src/components/AgentComposer.tsx`, `src/hooks/useDictation.ts`, `src/lib/micInteraction.ts`. NOT rewritten (they import the process types from `./terminals`, which keeps compiling through the re-export): `electron/mcp/tools/permissions.test.ts`, `electron/mcp/tools/sessions.test.ts`, `electron/services/fakeStream.ts`.
- App modify: `scripts/kit-moves.phase1.json`

**Interfaces:**
- Produces from `/protocol`: everything `slashCommands.ts` exports (`UI_SLASH_COMMAND_CHANNEL`, the routing table and classifier), everything `electron/stt/protocol.ts` exports (`SttStatus`, `SttStatusSnapshot`, `SttProgress`, `SttTranscription`, `SttToWorker`, `SttFromWorker`, `MODEL_DIRNAME`, `MODEL_FILES`, `HOTWORDS_DECODING`, …), and `ProcLike`, `SpawnProcOptions`, `SpawnProc` with the exact shapes below.

- [ ] **Step 1: Copy slash routing and STT protocol into the library**

```bash
cd /c/Users/ryguy/projects/claude-agent-kit
A=/c/Users/ryguy/projects/claude-tui-app
cp $A/electron/services/slashCommands.ts      src/protocol/slashCommands.ts
cp $A/electron/services/slashCommands.test.ts src/protocol/slashCommands.test.ts
cp $A/electron/stt/protocol.ts                src/protocol/sttProtocol.ts
```

- [ ] **Step 2: Write `src/protocol/proc.ts`** — the process abstraction, lifted verbatim from `terminals.ts` (doc comments preserved)

```ts
/**
 * The minimal slice of a `child_process.ChildProcess` the HEADLESS transport uses.
 * Distinct from a PTY surface on purpose: the headless stream-json protocol wants a
 * clean byte stream (piped stdio, no PTY echo / ANSI / terminal control), and stdin
 * is a structured-message sink rather than keystrokes. Declaring our own surface is
 * what makes the headless spawn path testable: a test injects a fake with no OS
 * process behind it.
 */
export interface ProcLike {
  readonly pid: number
  /** stdout `data` (decoded to a string). */
  onStdout(cb: (data: string) => void): void
  /** stderr `data` (decoded to a string). */
  onStderr(cb: (data: string) => void): void
  /** Process exit. `code` is null when the process was killed by a signal. */
  onExit(cb: (e: { code: number | null }) => void): void
  /**
   * Async spawn failure (e.g. an invalid `cwd` → ENOENT). OPTIONAL on the contract
   * so hermetic fakes need not implement it; a real spawn always wires it. When a
   * spawn fails `error` fires INSTEAD of `exit` (Node never emits `exit` for a
   * process that never started), so the consumer must tear down on `error` too —
   * otherwise an unhandled `error` on a ChildProcess crashes the host process.
   */
  onError?(cb: (err: Error) => void): void
  /** Write to the child's stdin (the structured user-message sink). */
  write(data: string): void
  kill(signal?: string): void
}

/** The subset of child_process spawn options the headless path passes. */
export interface SpawnProcOptions {
  cwd: string
  env: Record<string, string>
}

/**
 * The injectable HEADLESS spawn seam. Production passes a `child_process.spawn`
 * wrapper with piped stdio; tests pass a fake that records args and drives
 * stdout/stderr/exit by hand — so a unit suite never launches a real `claude`.
 */
export type SpawnProc = (file: string, args: string[], options: SpawnProcOptions) => ProcLike
```

- [ ] **Step 3: Update the barrel, add extensions, verify no duplicate export names (Review Focus 3)**

`src/protocol/index.ts`:

```ts
export * from "./streamProtocol.js"
export * from "./slashCommands.js"
export * from "./sttProtocol.js"
export * from "./proc.js"
```

```bash
node scripts/add-js-ext.mjs
grep -hoE "^export (const|function|type|interface|class|enum|let) [A-Za-z0-9_]+" src/protocol/*.ts | grep -v test | awk '{print $3}' | sort | uniq -d
npm run typecheck && npm test && npm run build
```

Expected: the duplicate grep prints nothing; typecheck 0; vitest 2 test files passed; build OK.

- [ ] **Step 4: Commit the library**

```bash
git add -A && git commit -m "feat(protocol): add slash routing, STT protocol, and the ProcLike/SpawnProc process types

Copied from claude-tui-app electron/services/slashCommands.ts, electron/stt/protocol.ts,
and the headless spawn types in electron/services/terminals.ts @ 5b78782.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 5: In the app, remove the process-type declarations from `terminals.ts` and import them**

Delete the three declarations `export interface ProcLike { … }`, `export interface SpawnProcOptions { … }`, `export type SpawnProc = …` (with their doc comments) from `electron/services/terminals.ts` (today at lines 383–455, between `realSpawnPty` and `realSpawnProc`). Replace them with a re-export so the app's existing `import { type ProcLike, type SpawnProc } from "../../services/terminals"` sites in `electron/mcp/tools/permissions.test.ts` and `electron/mcp/tools/sessions.test.ts` keep compiling:

```ts
import type { ProcLike, SpawnProc, SpawnProcOptions } from "@ryanhartwig/claude-agent-kit/protocol"
export type { ProcLike, SpawnProc, SpawnProcOptions }
```

Place the import with the other imports at the top of `terminals.ts` (it already imports from `@ryanhartwig/claude-agent-kit/protocol` after Task 2; merge into that import statement) and the `export type {…}` line where the declarations were.

- [ ] **Step 6: Extend the move map, delete the app copies, rewrite importers**

`scripts/kit-moves.phase1.json`:

```json
{
  "electron/services/streamProtocol": "@ryanhartwig/claude-agent-kit/protocol",
  "electron/services/slashCommands": "@ryanhartwig/claude-agent-kit/protocol",
  "electron/stt/protocol": "@ryanhartwig/claude-agent-kit/protocol"
}
```

```bash
cd /c/Users/ryguy/projects/claude-tui-app
git rm -q electron/services/slashCommands.ts electron/services/slashCommands.test.ts electron/stt/protocol.ts
node scripts/rewrite-kit-imports.mjs scripts/kit-moves.phase1.json
git grep -nE "(slashCommands|stt/protocol|\./protocol)\"" -- electron src e2e
```

Expected: rewrites reported for the ~13 importers; the grep returns nothing.

- [ ] **Step 7: Gates and commit**

```bash
npm run typecheck && npm test
git add -A electron src scripts
git commit -m "refactor(kit): consume slash routing, STT protocol, and ProcLike/SpawnProc from the kit

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: typecheck 0; app tests green with the slashCommands suite's tests now counted in the library.

---

### Task 4: `/engine` entry with `encodeProjectDir` (dissolves the transcripts↔terminals cycle)

**Files:**
- Library create: `src/engine/projectDir.ts`, `src/engine/projectDir.test.ts`, `src/engine/index.ts`
- Library modify: `package.json` (exports)
- App modify: `electron/services/terminals.ts:57-59` (remove the function; import it), `electron/services/transcripts.ts`, `electron/services/transcriptHistory.ts`, `electron/services/contextInspector.ts`, `electron/services/contextInspector.test.ts` (all four: import from the kit instead of `./terminals`)

**Interfaces:**
- Produces from `/engine`: `encodeProjectDir(cwd: string): string`.

- [ ] **Step 1: Write the failing test** `src/engine/projectDir.test.ts` (Review Focus 2)

```ts
import { describe, it, expect } from "vitest"
import { encodeProjectDir } from "./projectDir.js"

describe("encodeProjectDir — Claude Code's ~/.claude/projects/<key> encoding", () => {
  it("replaces the Windows drive colon and backslashes with dashes", () => {
    expect(encodeProjectDir("C:\\Users\\ryguy\\app")).toBe("C--Users-ryguy-app")
  })
  it("replaces POSIX forward slashes with dashes, including the leading one", () => {
    expect(encodeProjectDir("/home/ryan/app")).toBe("-home-ryan-app")
  })
  it("handles mixed separators the way Claude Code does (every separator → dash)", () => {
    expect(encodeProjectDir("C:/Users/ryguy\\app")).toBe("C--Users-ryguy-app")
  })
  it("leaves a path with no separators unchanged", () => {
    expect(encodeProjectDir("app")).toBe("app")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /c/Users/ryguy/projects/claude-agent-kit && npx vitest run src/engine/projectDir.test.ts
```

Expected: FAIL — `Cannot find module './projectDir.js'`.

- [ ] **Step 3: Write the implementation** `src/engine/projectDir.ts` (verbatim from `terminals.ts:57-59`) and the barrel

```ts
/**
 * Encode a working directory the way Claude Code keys `~/.claude/projects/`:
 * every path separator AND the drive colon becomes "-":
 * "C:\\Users\\ryguy\\app" -> "C--Users-ryguy-app".
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[:/\\]/g, "-")
}
```

`src/engine/index.ts`:

```ts
export * from "./projectDir.js"
```

Add to `package.json` `exports` (keep `./protocol`):

```json
"./engine": {
  "types": "./dist/engine/index.d.ts",
  "default": "./dist/engine/index.js"
}
```

- [ ] **Step 4: Run the test to verify it passes, build, commit**

```bash
npx vitest run src/engine/projectDir.test.ts && npm run typecheck && npm run build
git add -A && git commit -m "feat(engine): add encodeProjectDir (the ~/.claude/projects key encoding) with unit tests

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: 4 tests pass; `dist/engine/index.js` exists.

- [ ] **Step 5: Re-point the app**

In `electron/services/terminals.ts`: delete the `encodeProjectDir` function and its doc comment (lines 52–59 today, directly after the `} from "./slashCommands"` import that Task 3 already rewrote) and add to the imports:

```ts
import { encodeProjectDir } from "@ryanhartwig/claude-agent-kit/engine"
```

(`terminals.ts` still calls `encodeProjectDir` at three sites — `listTranscriptIds`, `resolveTranscriptId`, and the transcript-path builder; the import keeps them working.) Then in `electron/services/transcripts.ts:3`, `electron/services/transcriptHistory.ts:32`, `electron/services/contextInspector.ts:6`, and `electron/services/contextInspector.test.ts:14` replace exactly the line

```ts
import { encodeProjectDir } from "./terminals"
```

with

```ts
import { encodeProjectDir } from "@ryanhartwig/claude-agent-kit/engine"
```

`transcripts.ts` and `transcriptHistory.ts` then no longer import `./terminals` at all — that is the cycle dissolving. `contextInspector.test.ts:15` keeps its separate `import type { TerminalService, TerminalInfo } from "./terminals"` line untouched.

- [ ] **Step 6: Gates and commit**

```bash
cd /c/Users/ryguy/projects/claude-tui-app
git grep -n "encodeProjectDir } from \"./terminals\"" -- electron
npm run typecheck && npm test
git add -A electron && git commit -m "refactor(kit): encodeProjectDir from the kit's /engine entry; transcripts no longer import terminals

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: the grep returns nothing; typecheck 0; app tests green (count unchanged — nothing moved out of the app's suite in this task).

---

### Task 5: `/core` entry — the transcript model and the rest of the agent `src/lib` set

**Files:**
- Library create (copied, with tests/fixtures): `src/core/agentTranscript.ts`, `transcriptStore.ts`, `transcriptWindow.ts`, `smoothReveal.ts`, `scrollStick.ts`, `toolGroups.ts`, `contextMeter.ts`, `slashCatalog.ts`, `micInteraction.ts`, `agentRail.ts`, `agentRailOutputs.ts`, `questionSubmit.ts`, `permissionView.ts`, `insertAtCursor.ts`, `dictationEsc.ts`, `backgroundTasks.ts`, `outputDerivation.ts`, each `*.test.ts`, plus `resultCostSemantics.fixtures.ts` + `resultCostSemantics.test.ts`
- Library create: `src/core/index.ts`
- Library modify: `package.json` (exports), `src/core/agentTranscript.test.ts` (remove the fakeStream pin block)
- App create: `electron/services/fakeStream.test.ts` (the pin, kept app-side)
- App delete: the 36 `src/lib/*` files above and `electron/services/{backgroundTasks,outputDerivation}.{ts,test.ts}`
- App modify (specifiers only, by script): `electron/services/terminals.ts`, `electron/services/streamEvents.ts`, `electron/mcp/tools/panels.ts`, `src/App.tsx`, `src/components/AgentComposer.tsx`, `AgentComposer.test.tsx`, `AgentRail.tsx`, `AgentStreamingCaret.test.tsx`, `AgentSurface.tsx`, `AgentView.tsx`, `AgentView.test.tsx`, `AgentWorkingRow.test.tsx`, `ContextMeterBar.tsx`, `PermissionPrompt.tsx`, `SlashCommandPicker.tsx`, `SplitView.tsx`, `src/components/panels/FormPanel.tsx`, `src/hooks/useAgentRail.ts`, `useDictation.ts`, `useSessionOutputs.ts`, `useSlashPicker.ts`, `useSmoothReveal.ts`, `useSmoothReveal.test.ts`, and any other file the script reports
- App modify: `scripts/kit-moves.phase1.json`

**Interfaces:**
- Consumes: `/protocol` types (`StreamEvent`, `AgentCatalog`, `RailOutput`, `RailOutputDraft`, `SttStatus`) via relative imports inside the library.
- Produces from `/core`: every export of the 17 modules, unchanged names (e.g. `reduceTranscript`, `foldTranscript`, `assistantExpandUseful`, `extractCost`, `toPerTurnCost`, `TranscriptStore`, `contextMeterFromBlocks`, `groupToolRuns`, `buildPickerEntries`, `shouldStick`, `newTurnBuffer`, `flushTurn`, `backgroundStartId`, `isTaskNotification`, `taskNotificationIds`, `describePermission`, `spliceWithSpacing`, `registerDictationEscHandler`, `dispatchDictationEsc`, …).

- [ ] **Step 1: Copy the modules, tests, and fixtures**

```bash
cd /c/Users/ryguy/projects/claude-agent-kit && mkdir -p src/core
A=/c/Users/ryguy/projects/claude-tui-app
for m in agentTranscript transcriptStore transcriptWindow smoothReveal scrollStick toolGroups contextMeter slashCatalog micInteraction agentRail agentRailOutputs questionSubmit permissionView insertAtCursor dictationEsc; do
  cp $A/src/lib/$m.ts src/core/$m.ts; cp $A/src/lib/$m.test.ts src/core/$m.test.ts
done
cp $A/src/lib/resultCostSemantics.fixtures.ts src/core/
cp $A/src/lib/resultCostSemantics.test.ts     src/core/
for m in backgroundTasks outputDerivation; do
  cp $A/electron/services/$m.ts src/core/$m.ts; cp $A/electron/services/$m.test.ts src/core/$m.test.ts
done
ls src/core | wc -l
```

Expected: `36` files.

- [ ] **Step 2: Fix the cross-entry specifiers to relative library paths**

The copied files still point at app paths. Rewrite them (these are the only four patterns present — verified by grep before the move):

```bash
sed -i 's#"@ryanhartwig/claude-agent-kit/protocol"#"../protocol/index"#g' src/core/*.ts
sed -i 's#"\.\./\.\./electron/services/streamEvents\.fixtures"#"../engine/streamEvents.fixtures"#g' src/core/agentTranscript.test.ts
grep -ln "electron/\|@ryanhartwig" src/core/*.ts
```

The first `sed` handles every file Task 2/3 already rewrote in the app (`agentTranscript`, `transcriptStore`, `slashCatalog`, `agentRailOutputs`, `micInteraction`, `outputDerivation`, the tests). The second handles `agentTranscript.test.ts`'s stream-event fixtures import. Expected: the final grep prints ONLY `src/core/agentTranscript.test.ts` (its `fakeStream` import, handled in Step 4).

- [ ] **Step 3: Bring the stream-event fixtures into the library's engine folder**

`agentTranscript.test.ts` builds its inputs from `electron/services/streamEvents.fixtures.ts`, pure data that belongs with the engine (Phase 4 moves `streamEvents.ts` itself). Copy the fixtures now so the test is self-contained:

```bash
cp $A/electron/services/streamEvents.fixtures.ts src/engine/streamEvents.fixtures.ts
grep -c "^import" src/engine/streamEvents.fixtures.ts
```

Expected: `0` — the fixtures file is pure data with no imports (verified), so nothing to rewrite. The app keeps its own copy for its remaining `streamEvents.test.ts`; the two copies get reconciled when Phase 4 moves the parser.

- [ ] **Step 4: Move the fakeStream linking pin back to the app**

In `src/core/agentTranscript.test.ts` delete the import line

```ts
import { REPLY_TEXT } from "../../electron/services/fakeStream"
```

and its two comment lines above it, and delete the whole block from `// CAPP-119 review (finding 4) — the e2e ↔ fixture LINKING PIN.` through the closing `})` of `describe("fakeStream ↔ usefulness-gate linking pin (CAPP-119 review)", …)` (today lines 808–822 of the app file).

Create `electron/services/fakeStream.test.ts` in the APP:

```ts
import { describe, it, expect } from "vitest"
import { assistantExpandUseful } from "@ryanhartwig/claude-agent-kit/core"
import { REPLY_TEXT } from "./fakeStream"

// CAPP-119 review (finding 4) — the e2e ↔ fixture LINKING PIN. The CAPP-111 spec
// (e2e/structured.spec.ts, "CAPP-111 / S4") drives a fakeStream turn and CLICKS the
// settled assistant block's `.agent-block-expand` — a button that only renders because
// the canned REPLY_TEXT passes the usefulness gate (it carries a fenced code block).
// If the fixture or the gate ever drift apart, this pin fails FIRST in the fast unit
// suite instead of as an opaque e2e timeout. Lives app-side because fakeStream does.
describe("fakeStream ↔ usefulness-gate linking pin (CAPP-119 review)", () => {
  it("the canned fake reply passes assistantExpandUseful (the CAPP-111 e2e depends on it)", () => {
    expect(assistantExpandUseful(REPLY_TEXT)).toBe(true)
  })
})
```

- [ ] **Step 5: Barrel, exports, extensions, duplicate check, library gates**

`src/core/index.ts`:

```ts
export * from "./agentTranscript.js"
export * from "./transcriptStore.js"
export * from "./transcriptWindow.js"
export * from "./smoothReveal.js"
export * from "./scrollStick.js"
export * from "./toolGroups.js"
export * from "./contextMeter.js"
export * from "./slashCatalog.js"
export * from "./micInteraction.js"
export * from "./agentRail.js"
export * from "./agentRailOutputs.js"
export * from "./questionSubmit.js"
export * from "./permissionView.js"
export * from "./insertAtCursor.js"
export * from "./dictationEsc.js"
export * from "./backgroundTasks.js"
export * from "./outputDerivation.js"
```

`package.json` `exports`, add:

```json
"./core": {
  "types": "./dist/core/index.d.ts",
  "default": "./dist/core/index.js"
}
```

```bash
node scripts/add-js-ext.mjs
grep -hoE "^export (const|function|type|interface|class|enum|let) [A-Za-z0-9_]+" src/core/*.ts | grep -v "test\|fixtures" | awk '{print $3}' | sort | uniq -d
npm run typecheck && npm test && npm run build
```

Expected: duplicate grep prints nothing; typecheck 0; vitest passes every moved suite (18 core test files + 2 protocol + 1 engine = 21 files); `dist/core/index.js` exists and `dist/` contains no `*.test.*` or `*.fixtures.*`.

- [ ] **Step 6: Commit the library**

```bash
git add -A && git commit -m "feat(core): add the transcript model and agent lib set (17 modules) with their tests

Copied from claude-tui-app src/lib/* and electron/services/{backgroundTasks,outputDerivation}.ts
@ 5b78782. The fakeStream linking pin stays app-side with fakeStream.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 7: Extend the move map, delete the app copies, rewrite importers**

Append to `scripts/kit-moves.phase1.json` (full file shown):

```json
{
  "electron/services/streamProtocol": "@ryanhartwig/claude-agent-kit/protocol",
  "electron/services/slashCommands": "@ryanhartwig/claude-agent-kit/protocol",
  "electron/stt/protocol": "@ryanhartwig/claude-agent-kit/protocol",
  "electron/services/backgroundTasks": "@ryanhartwig/claude-agent-kit/core",
  "electron/services/outputDerivation": "@ryanhartwig/claude-agent-kit/core",
  "src/lib/agentTranscript": "@ryanhartwig/claude-agent-kit/core",
  "src/lib/transcriptStore": "@ryanhartwig/claude-agent-kit/core",
  "src/lib/transcriptWindow": "@ryanhartwig/claude-agent-kit/core",
  "src/lib/smoothReveal": "@ryanhartwig/claude-agent-kit/core",
  "src/lib/scrollStick": "@ryanhartwig/claude-agent-kit/core",
  "src/lib/toolGroups": "@ryanhartwig/claude-agent-kit/core",
  "src/lib/contextMeter": "@ryanhartwig/claude-agent-kit/core",
  "src/lib/slashCatalog": "@ryanhartwig/claude-agent-kit/core",
  "src/lib/micInteraction": "@ryanhartwig/claude-agent-kit/core",
  "src/lib/agentRail": "@ryanhartwig/claude-agent-kit/core",
  "src/lib/agentRailOutputs": "@ryanhartwig/claude-agent-kit/core",
  "src/lib/questionSubmit": "@ryanhartwig/claude-agent-kit/core",
  "src/lib/permissionView": "@ryanhartwig/claude-agent-kit/core",
  "src/lib/insertAtCursor": "@ryanhartwig/claude-agent-kit/core",
  "src/lib/dictationEsc": "@ryanhartwig/claude-agent-kit/core"
}
```

```bash
cd /c/Users/ryguy/projects/claude-tui-app
for m in agentTranscript transcriptStore transcriptWindow smoothReveal scrollStick toolGroups contextMeter slashCatalog micInteraction agentRail agentRailOutputs questionSubmit permissionView insertAtCursor dictationEsc; do git rm -q src/lib/$m.ts src/lib/$m.test.ts; done
git rm -q src/lib/resultCostSemantics.fixtures.ts src/lib/resultCostSemantics.test.ts
git rm -q electron/services/backgroundTasks.ts electron/services/backgroundTasks.test.ts electron/services/outputDerivation.ts electron/services/outputDerivation.test.ts
node scripts/rewrite-kit-imports.mjs scripts/kit-moves.phase1.json
git grep -nE "lib/(agentTranscript|transcriptStore|transcriptWindow|smoothReveal|scrollStick|toolGroups|contextMeter|slashCatalog|micInteraction|agentRail|agentRailOutputs|questionSubmit|permissionView|insertAtCursor|dictationEsc)\"|(backgroundTasks|outputDerivation)\"" -- electron src e2e
```

Expected: the script rewrites ~25 files; the grep returns nothing. Note `terminals.ts`'s former `../../src/lib/agentTranscript` cross-boundary import is now `@ryanhartwig/claude-agent-kit/core` — the main process no longer imports a renderer file.

- [ ] **Step 8: Gates and commit**

```bash
npm run typecheck && npm test
git add -A electron src scripts && git commit -m "refactor(kit): consume the transcript model and agent lib set from @ryanhartwig/claude-agent-kit/core

Removes the main→renderer import of src/lib/agentTranscript; the fakeStream
usefulness-gate pin moves to electron/services/fakeStream.test.ts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: typecheck 0; app vitest green, 15 skipped unchanged. App passed-test count + library passed-test count = 1483 + 4 (the new `encodeProjectDir` tests) = 1487; record the actual two numbers in the commit body. `dev:isolated` (`scripts/dev-isolated.mjs` → `electron-vite dev`) does NOT run `kit:build`; when iterating on the kit alongside it, run the kit's `npm run dev` watcher in a second shell (documented in Task 6's CLAUDE.md text).

---

### Task 6: Phase exit — docs, deploy-check, package, tag

**Files:**
- App modify: `CLAUDE.md` (new "claude-agent-kit" subsection under Architecture), `docs/reference/structured-engine.md` (one note), `scripts/deploy-check.mjs` (scan the kit's `src/`), `package.json` (version `0.1.7`)
- Library: tag `v0.0.1`

- [ ] **Step 1: Whole-phase greps (Review Focus 5 + spec exit criteria)**

```bash
cd /c/Users/ryguy/projects/claude-tui-app
git grep -n "claude-agent-kit/" -- electron src e2e | grep -vE "claude-agent-kit/(protocol|core|engine)\"" ; echo "deep-import check done (expect nothing above)"
git grep -n "../../src/lib/" -- electron ; echo "main→renderer check done (expect nothing above)"
ls src/lib | wc -l
```

Expected: both checks print nothing above their "done" line; `src/lib` still holds the app-only modules (panelApi, toast, scheduleRow, workspace*, etc.).

- [ ] **Step 2: Extend `scripts/deploy-check.mjs`** so a library edit also marks the packaged exe stale (Review Focus 1). Change the `SRC_DIRS` line:

```js
const SRC_DIRS = ["electron", "src", "../claude-agent-kit/src"]
```

`newestUnder` already swallows a missing directory (`readdirSync` throws → `continue`), so a clean clone without the sibling still works. Verify:

```bash
node scripts/deploy-check.mjs; echo "exit=$?"
```

Expected: `STALE …` with exit 1 (sources are newer than the last packaged exe) or `UNKNOWN` exit 2 if no build exists yet — either is fine here; what matters is it runs and includes the kit path when a kit file is the newest.

- [ ] **Step 3: Document in `CLAUDE.md`** — add this subsection directly under the "Architecture" diagram's bullet list, after the "MCP server" bullet:

```markdown
- **`@ryanhartwig/claude-agent-kit` (private, `C:\Users\ryguy\projects\claude-agent-kit`, sibling checkout, linked via `file:`):** the stream protocol (`/protocol`), the transcript model + agent lib set (`/core`), and `encodeProjectDir` (`/engine`) live THERE, not here. The app imports only those three entry points. The kit is bundled by electron-vite, so it is a devDependency and packaging is unchanged. **npm does NOT build a `file:` link** — `npm run build`/`dev`/`typecheck` run `kit:build` first; while editing the kit run its `npm run dev` (tsc --watch). To move more modules use `node scripts/rewrite-kit-imports.mjs <map.json>` (see `scripts/kit-moves.phase1.json`). Design + remaining phases: `docs/superpowers/specs/2026-10-23-claude-agent-kit-extraction-design.md`.
```

Also update the "Key Files" table rows that referenced moved files: in the Electron table there is no row for streamProtocol (it was described in prose) — add one line under the table: `Stream protocol, slash routing, STT protocol types: now in the kit's `/protocol` entry.` In `docs/reference/structured-engine.md`, in the "Headless engine" paragraph replace `` (`HEADLESS_FLAGS` in `electron/services/streamProtocol.ts`) `` with `` (`HEADLESS_FLAGS` from `@ryanhartwig/claude-agent-kit/protocol`) `` and in the "Init catalog" bullet replace `` the `AgentCatalog` type in `streamProtocol.ts` `` with `` the `AgentCatalog` type in the kit's `/protocol` ``; in the "Context meter" paragraph replace `` `src/lib/contextMeter.ts` `` with `` the kit's `/core` (`contextMeter`) ``.

- [ ] **Step 4: Bump the app version, package, commit**

Set `"version": "0.1.7"` in `package.json`, then:

```bash
npm run package
ls -la dist/win-unpacked/ClaudeTUI.exe
node scripts/deploy-check.mjs; echo "exit=$?"
git add -A && git commit -m "build: bump to 0.1.7 (claude-agent-kit phase 0+1 — protocol/core/engine entries consumed from the kit)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: `npm run package` succeeds (it runs `kit:build` → `tsc -b` → `electron-vite build` → electron-builder `--win dir`); deploy-check prints `FRESH …` exit 0.

- [ ] **Step 5: Tag and push the library**

```bash
cd /c/Users/ryguy/projects/claude-agent-kit
npm version 0.0.1 -m "chore: v%s — phase 0+1 (protocol, core, engine/encodeProjectDir)"
git push origin main --tags
gh release list --repo ryanhartwig/claude-agent-kit || true
git log --oneline -3
```

Expected: tag `v0.0.1` on origin. (No GitHub release needed; the tag is what a future `github:…#v0.0.1` dependency resolves.)

- [ ] **Step 6: Hand off to the owner**

Tell the owner: the packaged build is in `dist/win-unpacked`; close the app and double-click **ClaudeTUI - Deploy**. What to spot-check in daily use after deploy: a structured terminal renders a reply with tool blocks and cost; the slash picker opens on `/`; a permission prompt appears and Allow works; the context meter fills after the first result; dictation push-to-talk still transcribes. These are the five surfaces whose code now comes from the kit.
