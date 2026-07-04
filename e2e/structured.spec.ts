import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * BO-4b — hermetic STRUCTURED-engine smoke (the regression test that would have
 * caught the "structured first session is blank + can't type" bug).
 *
 * Same hermetic-by-USERPROFILE harness as smoke.spec.ts, plus two seams:
 *   1. a seeded `~/.claude-tui/config.json` with `rendering.engine: "structured"`
 *      so the app boots the structured renderer (AgentView + AgentComposer +
 *      programmatic permission gate), exactly as the dogfooding user has it.
 *   2. `CLAUDETUI_FAKE_STREAM=1` so the headless transport drives a CANNED stream
 *      (electron/services/fakeStream.ts) instead of spawning a real `claude` —
 *      keeping the e2e hermetic invariant (no real claude.exe, no auth, no net).
 *
 * Asserts the structured surface is USABLE: the composer textarea is present,
 * enabled, and focusable from the moment a session opens; a typed first message
 * reaches the (fake) agent and its streamed reply renders a block in AgentView;
 * and no uncaught renderer error fires.
 */

let app: ElectronApplication | undefined
let tempHome: string | undefined

async function seedStructuredConfig(home: string): Promise<void> {
  const dir = join(home, ".claude-tui")
  await mkdir(dir, { recursive: true })
  // An envelope-less file is read as v0 and read-repaired to v1 by loadVersioned,
  // so a plain object is the simplest valid seed.
  await writeFile(
    join(dir, "config.json"),
    JSON.stringify({ rendering: { engine: "structured" } }, null, 2),
    "utf-8",
  )
}

/** Mirror SessionService.encodeProjectDir: CC replaces `:` `/` `\` with `-`. */
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[:/\\]/g, "-")
}

/**
 * BO-12 — seed a persisted (dead) structured session bound to an on-disk Claude
 * Code transcript, so an app launch auto-restores it and the AgentView must
 * REHYDRATE the prior turns from disk (the "after restart, show prior transcript"
 * acceptance). The fake stream stays silent on a restore (no first message), so the
 * ONLY content that can appear is the rehydrated history — a clean signal.
 */
async function seedRestorableSession(
  home: string,
  ccId: string,
  cwd: string,
): Promise<void> {
  // The persisted work-session (envelope-less v0; read-repaired on load). One
  // structured terminal carrying the convo id — reopenTerminal re-passes it.
  const sessionsDir = join(home, ".claude-tui", "sessions")
  await mkdir(sessionsDir, { recursive: true })
  const session = {
    id: "session-bo12-restore",
    name: "Restored",
    status: "active",
    summary: "",
    notes: [],
    provisionalFindings: [],
    terminals: [
      {
        id: "term-bo12-old",
        name: "Restored term",
        cwd,
        ccConversationId: ccId,
        lastState: "idle",
        engine: "structured",
        model: "opus",
      },
    ],
    createdAt: 1,
    updatedAt: 2,
  }
  await writeFile(join(sessionsDir, `${session.id}.json`), JSON.stringify(session), "utf-8")

  // The on-disk transcript (real CC on-disk shapes: a user text line + an
  // assistant text line, each its own line) the reader folds into user+assistant.
  const projDir = join(home, ".claude", "projects", encodeProjectDir(cwd))
  await mkdir(projDir, { recursive: true })
  const transcript =
    JSON.stringify({
      type: "user",
      isSidechain: false,
      message: { role: "user", content: [{ type: "text", text: "remember the number 42" }] },
    }) +
    "\n" +
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      message: { role: "assistant", content: [{ type: "text", text: "Got it, I will remember 42." }] },
    }) +
    "\n"
  await writeFile(join(projDir, `${ccId}.jsonl`), transcript, "utf-8")
}

/**
 * Shared setup for the split-pane tests: launch a hermetic structured app, open a
 * session, add a second structured terminal, and engage the split. Returns the page
 * (and the pageErrors sink the caller asserts empty at the end). Mirrors the engage
 * pattern from the BO-4b split test (Ctrl+\ toggles; poll-press only while not split).
 */
async function launchSplit(prefix: string): Promise<{ win: Page; pageErrors: string[] }> {
  tempHome = await mkdtemp(join(tmpdir(), prefix))
  await seedStructuredConfig(tempHome)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CLAUDETUI_FAKE_STREAM: "1", CI: "1" },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })

  await win.locator(".sidebar-action", { hasText: "+ New session" }).click()
  await expect(win.locator(".agent-composer textarea")).toHaveCount(1, { timeout: 15_000 })
  await win.keyboard.press("Control+t")
  await expect(win.locator(".agent-composer textarea")).toHaveCount(2, { timeout: 15_000 })

  await expect(async () => {
    if ((await win.locator(".split-pane").count()) === 0) {
      await win.keyboard.press("Control+\\")
    }
    await expect(win.locator(".split-pane")).toHaveCount(2, { timeout: 1_500 })
  }).toPass({ timeout: 20_000 })

  // CAPP-55 — the two panes exist; their composers mount a frame later. Give the
  // count assertion a generous timeout (auto-retry) so a slow render under load
  // doesn't fail the shared setup before the composers paint.
  await expect(win.locator(".split-pane .agent-composer textarea")).toHaveCount(2, {
    timeout: 15_000,
  })
  return { win, pageErrors }
}

test.afterEach(async () => {
  if (app) {
    await app.close().catch(() => {})
    app = undefined
  }
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true }).catch(() => {})
    tempHome = undefined
  }
})

test("CAPP-39 gate ④: with NO seeded config, a new session DEFAULTS to the structured surface", async () => {
  // The negative control proving the DEFAULT engine is now structured (CAPP-39 gate ④).
  // Unlike the other tests here, this seeds NO config.json, so resolveRenderingEngine
  // sees an absent rendering.engine and must resolve to "structured" (the new default).
  // CLAUDETUI_FAKE_STREAM=1 keeps it hermetic: opening a structured session would
  // otherwise spawn a real `claude -p` (the default routes create() → createHeadless).
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-default-engine-"))
  // NOTE: deliberately NO seedStructuredConfig — an empty ~/.claude-tui exercises the
  // default-resolution path, not an explicit opt-in.

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: {
      ...process.env,
      USERPROFILE: tempHome, // hermetic home → empty config → DEFAULT engine applies
      CLAUDETUI_FAKE_STREAM: "1", // structured spawn uses the canned stream, not real claude
      CI: "1",
    },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })

  // Open a session with no config seeded — the default engine decides the surface.
  await win.locator(".sidebar-action", { hasText: "+ New session" }).click()

  // The STRUCTURED surface mounts (AgentComposer textarea), proving the default is now
  // structured — and there is NO xterm canvas (the negative control).
  await expect(win.locator(".agent-composer textarea")).toHaveCount(1, { timeout: 15_000 })
  await expect(win.locator(".xterm")).toHaveCount(0)

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("structured engine: composer is usable and a streamed reply renders", async () => {
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-structured-"))
  await seedStructuredConfig(tempHome)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: {
      ...process.env,
      USERPROFILE: tempHome, // hermetic home → structured config + no restore
      CLAUDETUI_FAKE_STREAM: "1", // headless path uses the canned stream, not real claude
      CI: "1",
    },
  })

  const win: Page = await app.firstWindow()

  // Collect uncaught renderer errors — the bug manifested partly as a broken
  // render, so an uncaught error must fail the test.
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })

  // Open a structured session.
  await win.locator(".sidebar-action", { hasText: "+ New session" }).click()

  // The structured surface mounts: AgentView (NOT an xterm canvas) + the composer.
  const composer = win.locator(".agent-composer textarea")
  await expect(composer).toBeVisible({ timeout: 15_000 })
  await expect(composer).toBeEnabled()
  // A PTY/xterm surface must NOT be what rendered for a structured terminal.
  await expect(win.locator(".xterm")).toHaveCount(0)

  // Focusable from the moment the session opens (no first message required).
  await composer.focus()
  await expect(composer).toBeFocused()

  // Empty-state affordance, not an indefinite spinner.
  await expect(win.locator(".agent-view-empty")).toContainText(/type|message|start/i)

  // Typing the first message reaches the (fake) agent; its streamed reply renders.
  await composer.fill("hi")
  await composer.press("Enter")
  await expect(win.locator(".agent-assistant")).toContainText("fake agent", { timeout: 15_000 })

  // The user's OWN message is echoed as a chat bubble (a two-sided conversation,
  // not a one-sided log).
  await expect(win.locator(".agent-user")).toContainText("hi")

  // The agent's reply renders exactly ONCE — the turn-complete `result` event must
  // not re-render the same text it already streamed (the duplicated-output bug).
  // CAPP-55 — gate on the turn-complete `result` block FIRST (it lands after the
  // streamed deltas; the "fake agent" wait above can pass mid-stream before it).
  // Once that's rendered the duplicate-render negatives below are evaluated against
  // the fully-settled turn, not a transient frame.
  await expect(win.locator(".agent-result")).toContainText(/turn complete/i, { timeout: 15_000 })
  await expect(win.locator(".agent-assistant")).toHaveCount(1)
  await expect(win.locator(".agent-result-text")).toHaveCount(0)

  // BO-8 — the reply renders as FORMATTED markdown INLINE (matching the panel),
  // not raw text: a fenced code block, bold, a heading, a list, a table, and a
  // link all become real markup inside the single assistant block.
  const assistant = win.locator(".agent-assistant")
  await expect(assistant.locator("pre code")).toBeVisible()
  await expect(assistant.locator("strong")).toContainText("fake agent")
  await expect(assistant.locator("h1")).toBeVisible()
  await expect(assistant.locator("ul li")).toHaveCount(2)
  await expect(assistant.locator("table")).toBeVisible()
  await expect(assistant.locator("a", { hasText: "the docs" })).toHaveAttribute(
    "href",
    "https://example.com",
  )
  // The raw markdown source must NOT be visible as literal text anymore.
  await expect(assistant).not.toContainText("```")
  await expect(assistant).not.toContainText("# Fake agent")
  // No throw/crash from the mid-stream partial markdown (unclosed bold + open
  // ``` fence between deltas) — the pageErrors assertion at the end enforces this.

  // UI tweak (header removal) — the OLD top header bar is gone, and the model picker +
  // effort picker + Raw-view button now live in the `.composer-controls-row` UNDER the
  // composer's send/stop buttons. Assert the header is absent and the controls relocated.
  await expect(win.locator(".agent-surface-header")).toHaveCount(0)
  const controlsRow = win.locator(".agent-composer .composer-controls-row")
  await expect(controlsRow).toBeVisible()
  await expect(controlsRow.locator(".agent-model-picker-select")).toBeVisible()
  await expect(controlsRow.locator(".agent-effort-picker-select")).toBeVisible()
  await expect(controlsRow.locator(".agent-raw-view-btn")).toBeVisible()

  // UI tweak (stick-to-bottom) — after sending, the transcript is scrolled to (near)
  // the bottom so the just-sent message + the streamed reply are in view (not below
  // the fold). Assert scrollTop + clientHeight is within a small threshold of
  // scrollHeight (the same ~24px stick threshold, with headroom for sub-pixel rounding).
  await expect(async () => {
    const atBottom = await win.locator(".agent-view").evaluate((el) => {
      const e = el as HTMLElement
      return e.scrollHeight - (e.scrollTop + e.clientHeight)
    })
    expect(atBottom).toBeLessThanOrEqual(32)
  }).toPass({ timeout: 10_000 })

  // BO-6 — the model picker is on the structured surface, showing the default model
  // (opus, since the seeded config sets no rendering.model and the temp home has no
  // ~/.claude/settings.json) with the alias options.
  const picker = win.locator(".agent-model-picker-select")
  await expect(picker).toBeVisible()
  await expect(picker).toHaveValue("opus")
  // CAPP-113 — the full documented alias set, in picker order, then the "Custom…" entry.
  await expect(picker.locator("option")).toContainText([
    "best",
    "fable",
    "opus",
    "opus[1m]",
    "sonnet",
    "sonnet[1m]",
    "haiku",
    "opusplan",
    "Custom…",
  ])

  // Choosing a different model respawns the terminal (resuming the conversation
  // with the new --model); the picker reflects the new choice on the replacement.
  await win.locator(".agent-model-picker-select").selectOption("sonnet")
  await expect(win.locator(".agent-model-picker-select")).toHaveValue("sonnet", { timeout: 15_000 })

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("Agent Rail (v1): renders, toggles open/closed, and the COST footer sums a turn", async () => {
  // Agent Rail Phase 1 — the right-edge agent-state column. Assert: it renders open
  // by default (no seeded agentRail pref → resolveAgentRailOpen defaults open), the
  // Ctrl+Alt+A shortcut collapses it to the spine + the command palette re-opens it,
  // and after a fakeStream turn the COST footer shows a NON-ZERO session total (the
  // fake result carries total_cost_usd + usage). All existing structured selectors
  // (.agent-composer etc.) stay intact — the rail is purely additive.
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-agentrail-"))
  await seedStructuredConfig(tempHome)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CLAUDETUI_FAKE_STREAM: "1", CI: "1" },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })

  // The rail renders open by default: the full column with its "Agent Rail" header +
  // the always-visible collapse control (no hover-reveal).
  const rail = win.locator(".agent-rail")
  await expect(rail).toBeVisible({ timeout: 15_000 })
  await expect(rail.locator(".agent-rail-title")).toHaveText("Agent Rail")
  await expect(rail.locator(".agent-rail-collapse")).toBeVisible()
  // Not yet collapsed (no spine).
  await expect(win.locator(".agent-rail.collapsed")).toHaveCount(0)

  // Ctrl+Alt+A collapses it to the 32px spine (the reopen control stays visible).
  await win.keyboard.press("Control+Alt+a")
  await expect(win.locator(".agent-rail.collapsed")).toBeVisible({ timeout: 10_000 })
  await expect(win.locator(".agent-rail-spine")).toBeVisible()
  await expect(win.locator(".agent-rail-header")).toHaveCount(0)

  // The command palette re-opens it (the bidirectional toggle entry).
  await win.keyboard.press("Control+Shift+P")
  await expect(win.locator(".cmdk-panel")).toBeVisible({ timeout: 10_000 })
  await win.locator(".cmdk-input").fill("agent rail")
  await win.locator(".cmdk-item .cmdk-label", { hasText: "Open Agent Rail" }).click()
  await expect(win.locator(".agent-rail.collapsed")).toHaveCount(0, { timeout: 10_000 })
  await expect(rail.locator(".agent-rail-header")).toBeVisible()

  // Open a structured session and drive a turn so a `result` (with cost) lands.
  await win.locator(".sidebar-action", { hasText: "+ New session" }).click()
  const composer = win.locator(".agent-composer textarea")
  await expect(composer).toBeVisible({ timeout: 15_000 })
  await composer.fill("hi")
  await composer.press("Enter")
  await expect(win.locator(".agent-result")).toContainText(/turn complete/i, { timeout: 15_000 })

  // The COST footer sums the turn to a non-zero session total ("$0.0123 · … tok · 1 turn").
  const cost = win.locator(".agent-rail-cost")
  await expect(async () => {
    const text = await cost.textContent()
    expect(text).toMatch(/\$0\.\d+/) // a real dollar amount, not the "—" resting dash
    expect(text).not.toBe("—")
  }).toPass({ timeout: 15_000 })
  await expect(cost).toContainText("tok")

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("structured engine: both split panes render a usable composer (not blank xterm)", async () => {
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-structured-split-"))
  await seedStructuredConfig(tempHome)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CLAUDETUI_FAKE_STREAM: "1", CI: "1" },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })

  // Open a session (terminal 1), add a second terminal, then split.
  await win.locator(".sidebar-action", { hasText: "+ New session" }).click()
  await expect(win.locator(".agent-composer textarea")).toHaveCount(1, { timeout: 15_000 })
  await win.keyboard.press("Control+t") // second structured terminal in the same session
  await expect(win.locator(".agent-composer textarea")).toHaveCount(2, { timeout: 15_000 })

  // Engage split. Ctrl+\ TOGGLES, and the window keydown handler closes over a
  // toggleSplit that needs activeTerminals.length >= 2 — a single press can land
  // before React re-registers that closure with the 2-terminal state. Poll, but
  // press ONLY while not yet split so a retry never toggles an engaged split back
  // off (once 2 panes show, the inner expect passes immediately and we stop).
  await expect(async () => {
    if ((await win.locator(".split-pane").count()) === 0) {
      await win.keyboard.press("Control+\\")
    }
    await expect(win.locator(".split-pane")).toHaveCount(2, { timeout: 1_500 })
  }).toPass({ timeout: 20_000 })

  // Before BO-4b, SplitView rendered TerminalPane unconditionally — both structured
  // panes were blank xterms with NO composer. Now each pane forks per-engine. The
  // composer render trails the split engage by a frame; give it auto-retry headroom.
  await expect(win.locator(".split-pane .agent-composer textarea")).toHaveCount(2, {
    timeout: 15_000,
  })
  await expect(win.locator(".split-pane .xterm")).toHaveCount(0)

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("structured engine: slash picker offers the BUILTIN FLOOR before the first turn (CAPP-126)", async () => {
  // CAPP-126 — the bug: on a fresh (or restored) structured terminal, `init` hasn't
  // arrived yet (a headless `claude -p` emits it only AFTER the first user message), so
  // the picker was DEAD — typing "/" showed nothing and "/compact" looked like it would
  // just be sent as a message. The fix: a static builtin floor (+ a staleness hint) so
  // the picker works IMMEDIATELY. The fakeStream stays silent until the first write, so
  // opening a session and typing "/" WITHOUT sending exercises the exact pre-init state.
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-slash-preinit-"))
  await seedStructuredConfig(tempHome)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CLAUDETUI_FAKE_STREAM: "1", CI: "1" },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })
  await win.locator(".sidebar-action", { hasText: "+ New session" }).click()

  const composer = win.locator(".agent-composer textarea")
  await expect(composer).toBeVisible({ timeout: 15_000 })

  // Type "/" WITHOUT sending anything — no init has streamed yet, so the ONLY source
  // is the builtin floor. The picker must still open and offer the core commands.
  const picker = win.locator(".slash-picker")
  await composer.fill("/")
  await expect(picker).toBeVisible({ timeout: 10_000 })
  await expect(picker).toContainText("/compact")
  await expect(picker).toContainText("/clear")
  await expect(picker).toContainText("/context")
  await expect(picker).toContainText("/config")
  await expect(picker).toContainText("/resume")

  // The muted staleness hint is visible TEXT (no hover/tooltip) — it tells the user
  // the list is from last session and refreshes after the first reply.
  await expect(picker.locator(".slash-picker-stale")).toContainText(
    /from last session — refreshes after the first reply/i,
  )

  // Drive the first turn so the (fake) init streams; the live catalog then lands and
  // the staleness hint clears (a fresh init was seen this process).
  await composer.fill("")
  await composer.fill("hi")
  await composer.press("Enter")
  await expect(win.locator(".agent-assistant")).toContainText("fake agent", { timeout: 15_000 })
  await expect(async () => {
    await composer.fill("")
    await composer.fill("/")
    await expect(picker).toBeVisible({ timeout: 2_000 })
    // Once a live init has been seen, the hint is gone (fresh catalog).
    await expect(picker.locator(".slash-picker-stale")).toHaveCount(0, { timeout: 2_000 })
  }).toPass({ timeout: 20_000 })

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("structured engine: slash picker reflects the LIVE init catalog and /config maps natively", async () => {
  // BO-7 — the `/`-command picker is sourced from the headless init event's
  // slash_commands + skills (fakeStream seeds a sample catalog), and native-mapped
  // built-ins (/config) fire an app affordance instead of being sent to the agent.
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-slash-"))
  await seedStructuredConfig(tempHome)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CLAUDETUI_FAKE_STREAM: "1", CI: "1" },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })
  await win.locator(".sidebar-action", { hasText: "+ New session" }).click()

  const composer = win.locator(".agent-composer textarea")
  await expect(composer).toBeVisible({ timeout: 15_000 })

  // Drive the first turn so the (fake) init streams — a headless `claude -p` emits
  // init after the first user message, and init is what populates the picker catalog.
  await composer.fill("hi")
  await composer.press("Enter")
  await expect(win.locator(".agent-assistant")).toContainText("fake agent", { timeout: 15_000 })

  // CAPP-55 — EXPLICIT readiness wait for the catalog, not an implicit one. The
  // headless `init` (which carries the picker catalog) arrives ASYNC over its own
  // IPC, independent of the assistant-text render we just awaited: under machine
  // contention the catalog can land in the useSlashPicker hook's state a beat AFTER
  // "fake agent" is visible — and if the live init event raced the hook's mount-time
  // subscription, only a fresh slash query re-derives `open` from the now-populated
  // catalog. So drive the open through `toPass`: clear + re-type "/" until the picker
  // actually renders its catalog-derived options. This re-types (a user-faithful
  // retry) instead of asserting once against a state that may not exist yet.
  const picker = win.locator(".slash-picker")
  await expect(async () => {
    await composer.fill("")
    await composer.fill("/")
    await expect(picker).toBeVisible({ timeout: 2_000 })
    // Gate on a catalog-DERIVED option, not just the container, so we never proceed
    // with a half-populated picker (the container can mount a frame before entries).
    await expect(picker.locator(".slash-picker-item", { hasText: "/clear" })).toBeVisible({
      timeout: 2_000,
    })
  }).toPass({ timeout: 20_000 })

  // The autocomplete lists the LIVE catalog (slash commands + skills from init — NOT
  // a hardcoded set). These auto-retry, so they settle as the catalog fully lands.
  await expect(picker).toContainText("/clear") // a built-in slash command
  await expect(picker).toContainText("/config") // a native-mapped built-in
  await expect(picker).toContainText("/chrome-live") // a skill from init.skills

  // Filtering narrows to the typed query, and selecting inserts `/name `. Wait for
  // the filtered set to settle to the single /config match (the catalog/render is
  // async) before clicking, so we never click a stale/again-filtering list.
  await composer.fill("/conf")
  await expect(picker.locator(".slash-picker-item")).toHaveCount(1, { timeout: 10_000 })
  await picker.locator(".slash-picker-item", { hasText: "/config" }).click()
  await expect(composer).toHaveValue("/config ", { timeout: 10_000 })

  // Sending /config is native-mapped → it cycles the theme (the theme/config
  // affordance) instead of being echoed to the agent as a literal user message.
  const themeBefore = await win.evaluate(() =>
    document.documentElement.getAttribute("data-theme"),
  )
  await composer.fill("/config")
  // CAPP-55 — `fill("/config")` re-opens the picker, but the open/render is async:
  // an Escape pressed before the picker has actually opened is a no-op (the hook's
  // keydown delegate only consumes Escape while `open` is true), leaving the picker
  // up so the subsequent Enter would be eaten by the picker (accept an entry) instead
  // of sending. Poll the dismiss: re-press Escape until the picker is genuinely hidden.
  await expect(async () => {
    await composer.press("Escape") // dismiss the re-opened picker so Enter sends
    await expect(picker).toBeHidden({ timeout: 1_000 })
  }).toPass({ timeout: 10_000 })
  await composer.press("Enter")

  await expect(async () => {
    const t = await win.evaluate(() => document.documentElement.getAttribute("data-theme"))
    expect(t).not.toBe(themeBefore)
  }).toPass({ timeout: 10_000 })

  // The native command was NOT forwarded to the agent as a user message.
  await expect(win.locator(".agent-user", { hasText: "/config" })).toHaveCount(0)

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("structured engine: a restored session REHYDRATES its prior transcript (BO-12)", async () => {
  // BO-12 (CAPP-51) — the bug: Stop/respawn/restart BLANKS the structured chat
  // (looks like a fresh empty session) even though --resume preserves the
  // conversation. Fix: rehydrate the view from the on-disk transcript. Here we seed
  // a persisted structured session bound to a real transcript, launch the app
  // (which auto-restores it), and assert the prior turns RENDER without sending any
  // message — i.e. the view did NOT blank to "Ready when you are".
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-rehydrate-"))
  await seedStructuredConfig(tempHome)
  const ccId = "bo12cafe-0000-4000-8000-000000000abc"
  // The restored terminal's cwd; the transcript lives under its encoded project dir.
  const cwd = join(tempHome, "work")
  await seedRestorableSession(tempHome, ccId, cwd)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CLAUDETUI_FAKE_STREAM: "1", CI: "1" },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })

  // The persisted session auto-restores into a structured surface (NOT an xterm).
  await expect(win.locator(".agent-composer textarea")).toBeVisible({ timeout: 30_000 })
  await expect(win.locator(".xterm")).toHaveCount(0)

  // The PRIOR conversation is rehydrated from disk — both the user turn and the
  // assistant turn render, WITHOUT typing anything. The blank-out bug would show
  // the "Ready when you are" empty state here instead.
  await expect(win.locator(".agent-user")).toContainText("remember the number 42", {
    timeout: 20_000,
  })
  await expect(win.locator(".agent-assistant")).toContainText("Got it, I will remember 42.")
  await expect(win.locator(".agent-view-empty")).toHaveCount(0)

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("structured engine: an auth-failure stream renders the actionable Sign-in block (CAPP-39 gate ②)", async () => {
  // CAPP-39 gate ② — an UNAUTHENTICATED `claude -p` emits init FIRST (so the
  // exit-before-init synth never fires), then an assistant error + "Not logged in"
  // result. The parser must map that POST-init shape to needs_auth and the renderer
  // must show a distinct, actionable Sign-in block (NOT a generic red error / dead
  // turn). The fake replays the exact live shape on the __AUTH_FAIL__ sentinel.
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-authfail-"))
  await seedStructuredConfig(tempHome)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CLAUDETUI_FAKE_STREAM: "1", CI: "1" },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })
  await win.locator(".sidebar-action", { hasText: "+ New session" }).click()

  const composer = win.locator(".agent-composer textarea")
  await expect(composer).toBeVisible({ timeout: 15_000 })

  // Drive the auth-failure turn.
  await composer.fill("__AUTH_FAIL__")
  await composer.press("Enter")

  // The DISTINCT, actionable Sign-in block renders — not a bare red error block.
  const authBlock = win.locator(".agent-needs-auth")
  await expect(authBlock).toBeVisible({ timeout: 15_000 })
  await expect(authBlock).toContainText(/not signed in/i)
  await expect(authBlock.locator(".agent-needs-auth-btn")).toContainText(/sign in/i)
  // The failure is NOT rendered as the generic error block or a "Turn failed" result.
  await expect(win.locator(".agent-error")).toHaveCount(0)
  await expect(win.locator(".agent-result")).toHaveCount(0)

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("structured engine: a split pane threads per-terminal busy (Stop only on the busy pane) and Stop re-points it (CAPP-49/42)", async () => {
  // CAPP-49 — SplitView rendered AgentSurface WITHOUT a busy prop, so busy defaulted
  // false in split panes: no Stop button and the send-guard was bypassed. Thread the
  // per-terminal busy state and the BO-10 Stop button returns — PER PANE.
  const { win, pageErrors } = await launchSplit("claudetui-split-busy-")

  const leftPane = win.locator(".split-pane").nth(0)
  const rightPane = win.locator(".split-pane").nth(1)

  // Hold the LEFT pane's turn open (busy) by sending the hold sentinel to its OWN
  // composer (the composer sends to its own terminal id, not the active selection).
  await leftPane.locator(".agent-composer textarea").fill("__HOLD_TURN__")
  await leftPane.locator(".agent-composer textarea").press("Enter")

  // Per-pane busy threading: the Stop button appears on the BUSY pane only.
  await expect(leftPane.locator(".composer-stop")).toBeVisible({ timeout: 15_000 })
  // Exactly one Stop across both panes — give it auto-retry headroom so a lagging
  // right-pane re-render can't transiently read as 0 or 2.
  await expect(win.locator(".split-pane .composer-stop")).toHaveCount(1, { timeout: 15_000 })
  // The busy pane's Send is disabled with the "Agent is working" hint; the IDLE
  // pane's Send stays enabled (busy is per-terminal, not global).
  await expect(leftPane.locator(".composer-send")).toBeDisabled()
  // WS3 — the persistent hint strip switches to its busy copy on the busy pane.
  await expect(leftPane.locator(".composer-hint.busy")).toContainText(/working/i)
  await expect(rightPane.locator(".composer-stop")).toHaveCount(0)

  // CAPP-42 — Stop (interrupt) respawns the LEFT terminal with a NEW id; the split
  // slot must re-point to it (NOT fall through to a blank/xterm pane). After the
  // respawn the new terminal is idle, so its Stop button is gone.
  await leftPane.locator(".composer-stop").click()
  await expect(win.locator(".split-pane .composer-stop")).toHaveCount(0, { timeout: 15_000 })
  // Both panes are still usable STRUCTURED surfaces — re-pointed, not blanked. The
  // re-point + composer re-render after the respawn can trail the Stop-button removal,
  // so let the count auto-retry instead of sampling a single mid-reconcile frame.
  await expect(win.locator(".split-pane .agent-composer textarea")).toHaveCount(2, {
    timeout: 15_000,
  })
  await expect(win.locator(".split-pane .xterm")).toHaveCount(0)

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("structured engine: a split pane re-points to the respawned terminal on model-switch (CAPP-42)", async () => {
  // CAPP-42 — a model switch respawns the terminal under a NEW id. Before the fix the
  // captured split slot kept pointing at the dead old id, so the pane fell through to
  // a blank TerminalPane (xterm). The reconcile must re-point the slot to the new
  // structured terminal so the pane shows the picker reflecting the chosen model.
  const { win, pageErrors } = await launchSplit("claudetui-split-respawn-")

  const leftPane = win.locator(".split-pane").nth(0)
  // Both panes default to opus (no rendering.model seeded, temp home has no settings).
  await expect(leftPane.locator(".agent-model-picker-select")).toHaveValue("opus", { timeout: 15_000 })

  // Switch the LEFT pane's model → respawn (kill + --resume with the new --model).
  await leftPane.locator(".agent-model-picker-select").selectOption("sonnet")

  // The slot re-points to the respawned terminal: the pane stays a structured surface
  // (picker present, NOT collapsed to an xterm) and reflects the new model.
  await expect(leftPane.locator(".agent-model-picker-select")).toHaveValue("sonnet", { timeout: 15_000 })
  // Both panes stay structured surfaces after the re-point; the respawned slot's
  // picker/composer can paint a frame behind the value change, so let the counts
  // auto-retry rather than sampling a single mid-reconcile frame.
  await expect(win.locator(".split-pane .agent-model-picker-select")).toHaveCount(2, {
    timeout: 15_000,
  })
  await expect(win.locator(".split-pane .agent-composer textarea")).toHaveCount(2, {
    timeout: 15_000,
  })
  await expect(win.locator(".split-pane .xterm")).toHaveCount(0)

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("structured engine: the raw-view escape hatch is surfaced (header button + palette entry) and busy-gated (CAPP-39 gate ③)", async () => {
  // CAPP-39 gate ③ — the per-terminal escape hatch lets the user toggle a single
  // terminal between the structured and xterm engines. We assert the TWO renderer
  // surfaces are present and correctly busy-gated. We deliberately do NOT click
  // through the actual structured→xterm switch here: an xterm spawn uses the REAL
  // node-pty seam (only the headless stream proc is faked under CLAUDETUI_FAKE_STREAM),
  // so completing the switch would launch a real claude.exe and break the e2e hermetic
  // invariant. The switch mechanism itself is covered by the SessionService unit tests.
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-escape-hatch-"))
  await seedStructuredConfig(tempHome)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CLAUDETUI_FAKE_STREAM: "1", CI: "1" },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })
  await win.locator(".sidebar-action", { hasText: "+ New session" }).click()

  const composer = win.locator(".agent-composer textarea")
  await expect(composer).toBeVisible({ timeout: 15_000 })

  // 1) The "Raw view" button is on the structured surface header (the structured→xterm
  //    direction), next to the model picker, and enabled while the terminal is idle.
  const rawBtn = win.locator(".agent-raw-view-btn")
  await expect(rawBtn).toBeVisible()
  await expect(rawBtn).toContainText(/raw view/i)
  await expect(rawBtn).toBeEnabled()

  // 2) BUSY-GATE: hold the turn open and the Raw view button disables (the switch would
  //    lose the live turn — Stop first). It re-enables once the held turn is stopped.
  await composer.fill("__HOLD_TURN__")
  await composer.press("Enter")
  await expect(win.locator(".composer-stop")).toBeVisible({ timeout: 15_000 })
  await expect(rawBtn).toBeDisabled()
  await win.locator(".composer-stop").click()
  // After Stop the terminal respawns idle (resuming the convo); the button re-enables.
  await expect(win.locator(".agent-raw-view-btn")).toBeEnabled({ timeout: 15_000 })

  // 3) The command palette carries the bidirectional toggle entry. With the active
  //    terminal structured, the entry reads "Switch to raw terminal (xterm)".
  await win.keyboard.press("Control+Shift+P")
  await expect(win.locator(".cmdk-panel")).toBeVisible({ timeout: 10_000 })
  await win.locator(".cmdk-input").fill("raw terminal")
  await expect(
    win.locator(".cmdk-item .cmdk-label", { hasText: "Switch to raw terminal (xterm)" }),
  ).toBeVisible({ timeout: 10_000 })
  await win.keyboard.press("Escape")

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("structured engine: a terminal tab rename accepts multi-character typing (no select-on-render trap) and persists (CAPP-81)", async () => {
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-rename-"))
  await seedStructuredConfig(tempHome)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CLAUDETUI_FAKE_STREAM: "1", CI: "1" },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })
  await win.locator(".sidebar-action", { hasText: "+ New session" }).click()
  await expect(win.locator(".agent-composer textarea")).toHaveCount(1, { timeout: 15_000 })

  // Enter rename on the single terminal tab (double-click the name span, not the dot).
  await win.locator(".tab span:not(.status-dot)").first().dblclick()
  const input = win.locator(".tab-rename-input")
  await expect(input).toBeVisible({ timeout: 10_000 })

  // Type CHARACTER BY CHARACTER. The regression was a select-all that re-fired on every
  // render, so each keystroke re-selected the field and the next char replaced it —
  // only the LAST character survived. fill() sets the value atomically and would NOT
  // catch it; pressSequentially reproduces real per-keystroke typing, which does.
  const newName = "Renamed Worker"
  await input.pressSequentially(newName, { delay: 20 })
  await expect(input).toHaveValue(newName)

  // Commit persists the full multi-char name onto the tab (also exercises the headless
  // terminal rename path — CAPP-81's service-layer fix — end to end).
  await input.press("Enter")
  await expect(win.locator(".tab")).toContainText(newName, { timeout: 10_000 })

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("CAPP-98 / I1: the always-visible 'Context' switcher button opens the READ-ONLY inspector with the honesty header", async () => {
  // The Context Inspector v1. With no workspace selected, the always-visible "Context"
  // switcher button (next to "Workspace memory", NO hover-reveal) opens the READ-ONLY
  // inspector in the companion window for the untagged "All" bucket (folderless). Assert:
  // the button is statically visible, it opens the .context-inspector-panel in the
  // companion window, the verbatim honesty header is present, the native tiers enumerate
  // (incl. a "none" placeholder for an absent tier), and the always-visible Refresh re-inspects.
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-ctx-inspect-"))
  await seedStructuredConfig(tempHome)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CLAUDETUI_FAKE_STREAM: "1", CI: "1" },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })

  // CAPP-123 — the context entry point is a compact TEXT button ("Context") in the
  // consolidated workspace control row (words over icons). It is ALWAYS VISIBLE in the
  // switcher (no hover-reveal), even in "All" mode — distinct from the adjacent
  // "Memory" button.
  const ctxBtn = win.locator(".wsctl-context")
  await expect(ctxBtn).toBeVisible({ timeout: 15_000 })
  await expect(ctxBtn).toContainText("Context")
  await expect(ctxBtn).toHaveAttribute("aria-label", /context inspector/i)

  // CAPP-109 / S2 — the READ-ONLY inspector now opens IN the main-window ModalHost.
  await ctxBtn.click()

  const panel = win.locator(".modal-host-panel .context-inspector-panel")
  await expect(panel).toBeVisible({ timeout: 15_000 })

  // The verbatim honesty header is present (v1 must NOT overclaim).
  await expect(panel.locator(".ctx-honesty")).toContainText(
    "Files Claude loads at launch, in precedence order. Imported files listed but not expanded. Full resolved view coming soon.",
  )

  // Folderless (the untagged "All" bucket): the folder reads as folderless/untagged.
  await expect(panel.locator(".ctx-meta")).toContainText(/folderless|untagged/i)

  // The native tiers (0–7) enumerate as collapsible sections — including a "none"
  // placeholder for an absent tier (the completeness claim depends on showing empties,
  // never omitting them). A hermetic empty home has no CLAUDE.md anywhere, so at least
  // one native tier renders its "none" placeholder.
  await expect(panel.locator(".ctx-source").first()).toBeVisible()
  await expect(panel.locator(".ctx-badge-none").first()).toBeVisible()

  // The always-visible Refresh button re-invokes the read-only inspection (no hover-reveal).
  const refresh = panel.locator(".ctx-refresh")
  await expect(refresh).toBeVisible()
  await refresh.click()
  // After a refresh the panel still renders its sections (the read was idempotent).
  await expect(panel.locator(".ctx-source").first()).toBeVisible({ timeout: 10_000 })

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("CAPP-111 / S4: each block has a STATICALLY-VISIBLE top-right expand button (no whole-block click); clicking it opens the modal; assistant button is settled-gated; tool rows are icon-only", async () => {
  // Item 2 — kill the whole-block click-to-open, add an explicit per-block button.
  // Assert: (1) after a settled turn the assistant block carries a statically-visible
  // (no-hover) expand button with its text label; (2) clicking it opens the panel in
  // the main-window ModalHost (S2); (3) the whole-block click is GONE (clicking the
  // prose body does NOT open a panel); (4) a multi-tool turn renders ICON-ONLY
  // (compact) buttons on the dense tool rows; (5) the assistant button is ABSENT
  // mid-stream (settled-gated, M2) and PRESENT once settled.
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-expandbtn-"))
  await seedStructuredConfig(tempHome)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CLAUDETUI_FAKE_STREAM: "1", CI: "1" },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })
  await win.locator(".sidebar-action", { hasText: "+ New session" }).click()

  const composer = win.locator(".agent-composer textarea")
  await expect(composer).toBeVisible({ timeout: 15_000 })

  // Drive a normal (settling) turn so the assistant block settles with its button.
  await composer.fill("hi")
  await composer.press("Enter")
  await expect(win.locator(".agent-result")).toContainText(/turn complete/i, { timeout: 15_000 })

  // (1) The SETTLED assistant block's expand button is STATICALLY visible (no hover) —
  //     an icon-only ⤢ whose label rides on aria-label/title (CAPP-111 review: all
  //     blocks are compact so the absolute prose button never overruns its first line).
  const assistantBtn = win.locator(".agent-assistant .agent-block-expand")
  await expect(assistantBtn).toBeVisible({ timeout: 15_000 })
  await expect(assistantBtn).toHaveAttribute("aria-label", /open in markdown/i)
  await expect(assistantBtn).toHaveClass(/compact/)
  await expect(assistantBtn.locator(".agent-block-expand-text")).toHaveCount(0)
  // NO hover-reveal (the HARD UI rule): the button is full-opacity AT REST, with no
  // prior hover. toBeVisible() ignores opacity, so read computed opacity directly —
  // this is the assertion that would catch an opacity:0 + :hover regression.
  const restOpacity = await assistantBtn.evaluate((el) => getComputedStyle(el).opacity)
  expect(restOpacity).toBe("1")
  // The result block also has an (icon-only) expand button.
  await expect(win.locator(".agent-result .agent-block-expand")).toBeVisible()

  // (3) The whole-block click is GONE: clicking the prose body does NOT open a modal.
  await win.locator(".agent-assistant .markdown-body").click()
  await expect(win.locator(".modal-host-overlay")).toHaveCount(0)

  // (2) Clicking the explicit button opens the markdown panel in the main-window ModalHost.
  await assistantBtn.click()
  await expect(win.locator(".modal-host-overlay")).toBeVisible({ timeout: 15_000 })
  await expect(win.locator(".modal-host-panel .markdown-body")).toBeVisible({ timeout: 15_000 })
  // Close the modal (Escape) so it doesn't shadow the next assertions.
  await win.locator(".modal-host-panel").press("Escape")
  await expect(win.locator(".modal-host-overlay")).toHaveCount(0, { timeout: 10_000 })

  // (4) Drive a multi-tool turn and assert the dense tool rows get ICON-ONLY (compact)
  //     buttons — statically visible, no text label span, with the title/aria-label.
  await composer.fill("__TOOLS_TURN__")
  await composer.press("Enter")
  // Two tool rows render (Edit + Bash). They settle to done.
  await expect(win.locator(".agent-tool")).toHaveCount(2, { timeout: 15_000 })
  const toolBtns = win.locator(".agent-tool .agent-block-expand")
  await expect(toolBtns).toHaveCount(2, { timeout: 15_000 })
  for (let i = 0; i < 2; i++) {
    await expect(toolBtns.nth(i)).toBeVisible()
    // Icon-only: compact class set, no visible text span.
    await expect(toolBtns.nth(i)).toHaveClass(/compact/)
    await expect(toolBtns.nth(i).locator(".agent-block-expand-text")).toHaveCount(0)
    await expect(toolBtns.nth(i)).toHaveAttribute("aria-label", /open (diff|tool)/i)
  }
  // The Edit tool's button opens the diff panel in the modal.
  await toolBtns.first().click()
  await expect(win.locator(".modal-host-overlay")).toBeVisible({ timeout: 15_000 })
  await win.locator(".modal-host-panel").press("Escape")
  await expect(win.locator(".modal-host-overlay")).toHaveCount(0, { timeout: 10_000 })

  // (5) M2 streaming-gate — drive a HELD turn: while the NEW (trailing) assistant block
  //     streams ("Working… " + heartbeats), it is NOT settled, so it must carry NO expand
  //     button (the button must never paint over the reveal-animated text / caret). The
  //     already-settled prior assistant block keeps its button — assert the STREAMING one
  //     specifically (`.agent-assistant.agent-streaming`) has none.
  await composer.fill("__HOLD_TURN__")
  await composer.press("Enter")
  const streamingBlock = win.locator(".agent-assistant.agent-streaming")
  await expect(streamingBlock).toHaveCount(1, { timeout: 15_000 })
  await expect(streamingBlock).toContainText("Working")
  await expect(streamingBlock.locator(".agent-block-expand")).toHaveCount(0)
  // Stop the held turn so the fake heartbeat stops before teardown.
  await expect(win.locator(".composer-stop")).toBeVisible({ timeout: 15_000 })
  await win.locator(".composer-stop").click()

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("CAPP-124: the mic sits in the INPUT ROW beside Send, and its download card renders FULLY on-screen (not clipped)", async () => {
  // Two owner-reported fixes: (1) the 🎤 moved from the footer controls row into the input
  // row immediately beside Send (2026 chat convention), and (2) the enable/download card was
  // rebuilt as a VIEWPORT-FIXED overlay — the old position:absolute card lived inside
  // .agent-composer (a z-index:4 stacking context) → .terminal-container { overflow: hidden }
  // and got truncated ("clipped behind the sidebar"). Assert the mic's new location AND that
  // the opened card's bounding box is fully inside the viewport (the clip-bug regression guard).
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-mic-"))
  await seedStructuredConfig(tempHome)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CLAUDETUI_FAKE_STREAM: "1", CI: "1" },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })
  await win.locator(".sidebar-action", { hasText: "+ New session" }).click()

  const composer = win.locator(".agent-composer")
  await expect(composer.locator("textarea")).toBeVisible({ timeout: 15_000 })

  // (1) The mic is in the INPUT ROW (.composer-row) beside Send — NOT the footer controls row.
  const micInRow = composer.locator(".composer-row .composer-mic")
  await expect(micInRow).toBeVisible({ timeout: 15_000 })
  await expect(composer.locator(".composer-controls-row .composer-mic")).toHaveCount(0)
  // Icon-only mic (universal glyph, conventional position) with a supplemental aria-label.
  await expect(micInRow).toContainText("🎤")
  await expect(micInRow).toHaveAttribute("aria-label", /dictate|set up voice dictation/i)

  // (2) Clicking it (status not-downloaded) opens the enable/download CONFIRM card + its scrim.
  await micInRow.click()
  const card = win.locator(".composer-mic-download")
  await expect(card).toBeVisible({ timeout: 10_000 })
  await expect(win.locator(".composer-mic-download-backdrop")).toBeVisible()

  // The initial CONFIRM step never auto-starts: an explicit "Download model" + "Cancel".
  await expect(card).toContainText(/download the dictation model/i)
  await expect(card.locator(".composer-mic-download-go")).toContainText(/download model/i)
  await expect(card.locator(".composer-mic-download-cancel")).toContainText(/cancel/i)

  // THE regression guard — the card's bounding box is FULLY inside the viewport (the clip
  // bug truncated it against .terminal-container's overflow:hidden). Uses a 1px tolerance
  // for sub-pixel rounding on the clamped edges.
  const box = await card.boundingBox()
  const vp = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  expect(box).not.toBeNull()
  if (box) {
    expect(box.x).toBeGreaterThanOrEqual(-1)
    expect(box.y).toBeGreaterThanOrEqual(-1)
    expect(box.x + box.width).toBeLessThanOrEqual(vp.w + 1)
    expect(box.y + box.height).toBeLessThanOrEqual(vp.h + 1)
    // It has real area on-screen (not collapsed to a clipped sliver).
    expect(box.width).toBeGreaterThan(200)
    expect(box.height).toBeGreaterThan(80)
  }

  // Cancel closes the card (non-destructive — no download was started).
  await card.locator(".composer-mic-download-cancel").click()
  await expect(card).toHaveCount(0, { timeout: 10_000 })

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("structured engine: switching sessions away and back KEEPS the transcript (the trust bug)", async () => {
  // THE TRUST BUG — a structured terminal renders via AgentView, which (before the
  // renderer transcript store) folded the stream into COMPONENT-LOCAL state and
  // subscribed to `onStreamEvent` in a useEffect. App.tsx only mounts AgentView for
  // the ACTIVE session's terminals, so switching to another session UNMOUNTED it,
  // killed its listener, and lost the whole transcript — the user's own message
  // bubble AND the assistant's reply. Seeding couldn't heal it: a FRESH fake session
  // never captures a ccConversationId (the fake writes no on-disk transcript), so the
  // BO-12 cache is never written and the disk seed never runs — remount blanked to
  // "Ready when you are". This test drives that exact user flow and asserts the
  // transcript SURVIVES a round-trip through another session.
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-switchaway-"))
  await seedStructuredConfig(tempHome)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CLAUDETUI_FAKE_STREAM: "1", CI: "1" },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })

  // Open session A and run one full turn so the transcript has real content.
  await win.locator(".sidebar-action", { hasText: "+ New session" }).click()
  const composer = win.locator(".agent-composer textarea")
  await expect(composer).toBeVisible({ timeout: 15_000 })
  await composer.fill("hi")
  await composer.press("Enter")
  // Both sides of the conversation render in A: the user's own bubble + the reply.
  await expect(win.locator(".agent-user")).toContainText("hi", { timeout: 15_000 })
  await expect(win.locator(".agent-assistant")).toContainText("fake agent", { timeout: 15_000 })
  // Settle on the turn-complete result so the reply is fully folded before we leave.
  await expect(win.locator(".agent-result")).toContainText(/turn complete/i, { timeout: 15_000 })

  // Switch AWAY: open session B. A's AgentView unmounts (activeTerminals renders only
  // the ACTIVE session's terminals) — this is where the away-period stream was lost.
  await win.locator(".sidebar-action", { hasText: "+ New session" }).click()
  await expect(win.locator(".session-item")).toHaveCount(2, { timeout: 15_000 })
  // Proof we actually switched: A's transcript is no longer in the DOM, and B shows
  // its empty "ready to type" state.
  await expect(win.locator(".agent-user", { hasText: "hi" })).toHaveCount(0, { timeout: 15_000 })
  await expect(win.locator(".agent-view-empty")).toBeVisible({ timeout: 15_000 })

  // Switch BACK to session A (the first sidebar session row).
  await win.locator(".session-item").first().click()

  // THE ASSERTION — A's transcript is intact: the user's own message bubble AND the
  // assistant reply both render again. Pre-fix, A remounted blank ("Ready when you
  // are") with no way to recover the lost stream; the store keeps folding while
  // unmounted so the return paints the full history.
  await expect(win.locator(".agent-user")).toContainText("hi", { timeout: 15_000 })
  await expect(win.locator(".agent-assistant")).toContainText("fake agent", { timeout: 15_000 })
  await expect(win.locator(".agent-result")).toContainText(/turn complete/i, { timeout: 15_000 })
  // Not the blank empty state.
  await expect(win.locator(".agent-view-empty")).toHaveCount(0)

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})
