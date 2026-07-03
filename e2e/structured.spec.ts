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
 * Agent Rail KNOWS (CAPP-84 Phase 3 × CAPP-86 v1.5) — seed a persisted structured
 * session that ALREADY carries accumulated context (a summary + two active findings +
 * one ruled-out/corrected finding), bound to an on-disk transcript so the app
 * auto-restores it as the active session. On restore the rail's KNOWS section has
 * real content to render (the per-session overview digest), and — since v1 recall
 * counts the workspace's sessions including this one — the cross-session recall
 * digest renders too. Hermetic: the fake stream stays silent on restore (no real
 * claude), so the ONLY KNOWS content is the seeded ledger.
 */
async function seedSessionWithContext(
  home: string,
  ccId: string,
  cwd: string,
): Promise<void> {
  const sessionsDir = join(home, ".claude-tui", "sessions")
  await mkdir(sessionsDir, { recursive: true })
  const session = {
    id: "session-knows-seed",
    name: "Engine migration",
    status: "active",
    summary: "Migrating the structured engine to the stream-json transport.",
    notes: [
      { id: "n1", text: "Headless loads skills by default", createdAt: 10, source: "self", status: "active" },
      { id: "n2", text: "init arrives after the first user message", createdAt: 20, source: "self", status: "active" },
      // A ruled-out note (n3) superseded by its correction (n4) — the `~~old~~ → new` pair.
      { id: "n3", text: "init carries the catalog immediately", createdAt: 30, source: "self", status: "superseded", supersededBy: "n4" },
      { id: "n4", text: "the catalog is empty until the first turn", createdAt: 40, source: "self", status: "active" },
    ],
    provisionalFindings: [],
    terminals: [
      {
        id: "term-knows-old",
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

  // A minimal on-disk transcript so reopenTerminal --resume has something to land on
  // (the same shape seedRestorableSession uses); the rail doesn't need it but the
  // restore path watches for it.
  const projDir = join(home, ".claude", "projects", encodeProjectDir(cwd))
  await mkdir(projDir, { recursive: true })
  await writeFile(
    join(projDir, `${ccId}.jsonl`),
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      message: { role: "assistant", content: [{ type: "text", text: "Resumed." }] },
    }) + "\n",
    "utf-8",
  )
}

/**
 * CAPP-88 — seed a SECOND restorable session in the SAME (untagged) workspace bucket
 * carrying its own active finding + one ruled-out/corrected finding, so the rail's
 * cross-session ("Across N sessions") recall digest has OTHER-session content to
 * aggregate (recall.summary() now EXCLUDES the caller's own session). The file is
 * named `…seed2` so it sorts AFTER `session-knows-seed.json` in `readdirSync` order —
 * keeping `session-knows-seed` the alphabetically-first → auto-restored ACTIVE session
 * (its "This session" digest counts stay deterministic). Untagged like the first seed,
 * so both share the default "All" workspace bucket and the cross-session scope spans
 * them. The fake stream stays silent on restore (hermetic — no real claude).
 */
async function seedSecondSessionWithFinding(
  home: string,
  ccId: string,
  cwd: string,
): Promise<void> {
  const sessionsDir = join(home, ".claude-tui", "sessions")
  await mkdir(sessionsDir, { recursive: true })
  const session = {
    id: "session-knows-seed2",
    name: "Permissions rework",
    status: "active",
    summary: "Re-approaching the structured permission gate.",
    notes: [
      { id: "m1", text: "approve_tool blocks until Allow or Deny", createdAt: 11, source: "self", status: "active" },
      // A ruled-out note (m2) superseded by its correction (m3).
      { id: "m2", text: "a bare allow is accepted", createdAt: 21, source: "self", status: "superseded", supersededBy: "m3" },
      { id: "m3", text: "allow MUST return updatedInput or it is rejected", createdAt: 22, source: "self", status: "active" },
    ],
    provisionalFindings: [],
    terminals: [
      {
        id: "term-knows-old2",
        name: "Restored term 2",
        cwd,
        ccConversationId: ccId,
        lastState: "idle",
        engine: "structured",
        model: "opus",
      },
    ],
    createdAt: 3,
    updatedAt: 4,
  }
  await writeFile(join(sessionsDir, `${session.id}.json`), JSON.stringify(session), "utf-8")

  // A minimal on-disk transcript so this session's restore --resume has something to
  // land on (same pattern as the other seeds; the rail doesn't need it).
  const projDir = join(home, ".claude", "projects", encodeProjectDir(cwd))
  await mkdir(projDir, { recursive: true })
  await writeFile(
    join(projDir, `${ccId}.jsonl`),
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      message: { role: "assistant", content: [{ type: "text", text: "Resumed two." }] },
    }) + "\n",
    "utf-8",
  )
}

/**
 * CAPP-93 / U5 — seed a single restorable structured session that carries promotable
 * findings (two active notes + one ruled-out/corrected note), bound to an on-disk
 * transcript so the app auto-restores it as the ACTIVE session. Killing it (Ctrl+K /
 * sidebar ✕) opens the KillSessionModal whose editable list is sourced from these
 * notes via getPromotableFindings. Untagged → its findings promote to the untagged
 * ("All") workspace-memory bucket (addressed by `null`), which the test reads back.
 */
async function seedSessionForKill(home: string, ccId: string, cwd: string): Promise<void> {
  const sessionsDir = join(home, ".claude-tui", "sessions")
  await mkdir(sessionsDir, { recursive: true })
  const session = {
    id: "session-kill-seed",
    name: "Doomed session",
    status: "active",
    summary: "A session about to be deleted.",
    notes: [
      { id: "k1", text: "the bug is a race in reopenTerminal", createdAt: 10, source: "self", status: "active" },
      { id: "k2", text: "structured engine is the default", createdAt: 20, source: "self", status: "active" },
      // A ruled-out note (k3) superseded by its correction (k4) — promotable too.
      { id: "k3", text: "init carries the catalog immediately", createdAt: 30, source: "self", status: "superseded", supersededBy: "k4" },
      { id: "k4", text: "the catalog is empty until the first turn", createdAt: 40, source: "self", status: "active" },
    ],
    provisionalFindings: [],
    terminals: [
      {
        id: "term-kill-old",
        name: "Doomed term",
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

  const projDir = join(home, ".claude", "projects", encodeProjectDir(cwd))
  await mkdir(projDir, { recursive: true })
  await writeFile(
    join(projDir, `${ccId}.jsonl`),
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      message: { role: "assistant", content: [{ type: "text", text: "Resumed." }] },
    }) + "\n",
    "utf-8",
  )
}

/**
 * CAPP-94 / U6 — seed a workspace-memory file for the UNTAGGED ("All") bucket so the
 * editor panel has standing instructions + a finding (with a resolvable corrector,
 * so the strikethrough/correction path renders) to display on open. The untagged
 * bucket lives at `~/.claude-tui/workspace-memory/__untagged__.json` and carries the
 * sentinel stem in its `workspaceId`. Envelope-less v0 is read-repaired to v1 on load.
 */
async function seedUntaggedWorkspaceMemory(home: string): Promise<void> {
  const dir = join(home, ".claude-tui", "workspace-memory")
  await mkdir(dir, { recursive: true })
  const record = {
    workspaceId: "__untagged__",
    instructions: "Prefer snake_case for all new modules.",
    findings: [
      {
        id: "wf-1",
        text: "the build externalizes node-pty",
        createdAt: 100,
        source: "agent",
        status: "active",
        promotedAt: 100,
      },
      // A ruled-out finding superseded by its corrector twin (renders the strike + arrow).
      {
        id: "wf-2",
        text: "init carries the catalog immediately",
        createdAt: 90,
        source: "self",
        status: "superseded",
        supersededBy: "wf-3",
        originSessionId: "s-old",
        originNoteId: "n-old",
        promotedAt: 95,
      },
      {
        id: "wf-3",
        text: "the catalog is empty until the first turn",
        createdAt: 96,
        source: "self",
        status: "active",
        promotedAt: 96,
      },
    ],
    createdAt: 100,
    updatedAt: 100,
  }
  await writeFile(join(dir, "__untagged__.json"), JSON.stringify(record), "utf-8")
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

test("Agent Rail KNOWS (Phase 3): renders both digests + always-visible Open controls; Open Recall opens the panel", async () => {
  // CAPP-84 Phase 3 × CAPP-86 v1.5 — the KNOWS context digest. Seed a restorable
  // session carrying real context (summary + 2 findings + 1 ruled-out/corrected),
  // so on auto-restore the rail's KNOWS section has content. Assert: the section +
  // its "This session" / "Across …" labels render, the count chips show the seeded
  // numbers, the ruled-out one-liner surfaces the `~~old~~ → new` correction, BOTH
  // "Open context →" and "Open Recall →" controls are always visible (no hover-
  // reveal), and clicking "Open Recall →" opens the companion RecallPanel.
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-knows-"))
  await seedStructuredConfig(tempHome)
  const ccId = "know5cafe-0000-4000-8000-000000000abc"
  const cwd = join(tempHome, "work")
  await seedSessionWithContext(tempHome, ccId, cwd)
  // CAPP-88 — seed a SECOND untagged session (its own findings) in the same workspace
  // bucket so the cross-session recall digest has OTHER-session content to aggregate.
  // recall.summary() now EXCLUDES the active session itself; a lone session would
  // (correctly) hide the cross-session group. Distinct ccId + cwd so its transcript
  // doesn't collide; the `…seed2` filename sorts after `session-knows-seed` so the
  // FIRST seed stays the auto-restored ACTIVE session (deterministic "This session").
  const ccId2 = "know5cafe-0000-4000-8000-000000000def"
  const cwd2 = join(tempHome, "work2")
  await seedSecondSessionWithFinding(tempHome, ccId2, cwd2)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CLAUDETUI_FAKE_STREAM: "1", CI: "1" },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })

  // The seeded session auto-restores into a structured surface (NOT an xterm).
  await expect(win.locator(".agent-composer textarea")).toBeVisible({ timeout: 30_000 })

  // The KNOWS section renders (it only appears when there's content) with its label.
  const knows = win.locator(".agent-rail-knows")
  await expect(knows).toBeVisible({ timeout: 20_000 })
  await expect(knows.locator(".agent-rail-section-label")).toHaveText("KNOWS")

  // "This session" digest: the scope label, the seeded counts, the summary, and the
  // most-recent ruled-out one-liner with its correction. Active findings = 3 (n1, n2,
  // AND n4 — the correction note is itself an active finding); ruled out = 1 (n3).
  await expect(knows).toContainText("This session")
  const sessionGroup = knows.locator(".agent-rail-knows-group").first()
  await expect(sessionGroup.locator(".agent-rail-knows-chip.findings")).toContainText("3 findings")
  await expect(sessionGroup.locator(".agent-rail-knows-chip.ruled-out")).toContainText("1 ruled out")
  await expect(sessionGroup.locator(".agent-rail-knows-summary")).toContainText(
    "Migrating the structured engine",
  )
  await expect(sessionGroup.locator(".agent-rail-knows-struck")).toContainText(
    "init carries the catalog immediately",
  )
  await expect(sessionGroup.locator(".agent-rail-knows-correction")).toContainText(
    "the catalog is empty until the first turn",
  )

  // BOTH Open controls are ALWAYS visible (no hover-reveal) and enabled.
  const openContext = knows.locator(".agent-rail-knows-open", { hasText: "Open context" })
  const openRecall = knows.locator(".agent-rail-knows-open", { hasText: "Open Recall" })
  await expect(openContext).toBeVisible()
  await expect(openContext).toBeEnabled()
  await expect(openRecall).toBeVisible()
  await expect(openRecall).toBeEnabled()

  // The cross-session digest renders too — and (CAPP-88) it counts only the OTHER
  // session, NOT the active one (whose findings already show in "This session" above).
  // With exactly one other untagged session it reads "Across 1 session" and its chips
  // reflect seed2's ledger: 2 active findings (m1, m3) + 1 ruled out (m2), with the
  // correcting one-liner attributed to "Permissions rework".
  await expect(knows).toContainText("Across 1 session")
  const crossGroup = knows.locator(".agent-rail-knows-group").nth(1)
  await expect(crossGroup.locator(".agent-rail-knows-scope")).toHaveText("Across 1 session")
  await expect(crossGroup.locator(".agent-rail-knows-chip.findings")).toContainText("2 findings")
  await expect(crossGroup.locator(".agent-rail-knows-chip.ruled-out")).toContainText("1 ruled out")
  // The cross-session ruled-out one-liner is seed2's (NOT the active session's n3),
  // proving the digest sources OTHER sessions' knowledge after exclude-self.
  await expect(crossGroup.locator(".agent-rail-knows-struck")).toContainText("a bare allow is accepted")
  await expect(crossGroup.locator(".agent-rail-knows-correction")).toContainText(
    "allow MUST return updatedInput",
  )

  // CAPP-109 / S2 — panels are now modal-by-default: "Open Recall →" renders the
  // RecallPanel IN the main window's ModalHost (no companion auto-pop). Assert the panel
  // (its always-visible search box) mounts inside the modal.
  await openRecall.click()
  await expect(win.locator(".modal-host-panel .recall-panel .recall-search")).toBeVisible({
    timeout: 15_000,
  })

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("Agent Rail propagation nudge (CAPP-101 / P1): a workspace-memory change marks the running terminal → 're-prime to pull' renders, and re-prime clears it", async () => {
  // P1 — when workspace memory changes, an ALREADY-RUNNING session froze its inject at
  // spawn, so we mark its terminal and surface a quiet, statically-visible Agent Rail KNOWS
  // affordance ("Workspace memory updated — re-prime to pull"). Seed a restorable UNTAGGED
  // session (its restored terminal is running), then mutate the UNTAGGED workspace memory via
  // the existing addWorkspaceFinding accessor — that fires onMemoryChanged → marks the running
  // terminal → the affordance appears. Clicking Re-prime PROMPTS the pull + clears the mark
  // (the affordance disappears). HONEST: re-prime does not inject the finding; this asserts the
  // affordance lifecycle, not magic propagation.
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-reprime-"))
  await seedStructuredConfig(tempHome)
  const ccId = "1eprime00-0000-4000-8000-000000000abc"
  const cwd = join(tempHome, "work")
  await seedSessionWithContext(tempHome, ccId, cwd)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CLAUDETUI_FAKE_STREAM: "1", CI: "1" },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })
  // The seeded session auto-restores into a structured surface (running terminal).
  await expect(win.locator(".agent-composer textarea")).toBeVisible({ timeout: 30_000 })

  // The nudge is NOT present before any memory change.
  await expect(win.locator(".agent-rail-reprime")).toHaveCount(0)

  // Mutate the UNTAGGED workspace memory — fires onMemoryChanged → marks the running terminal.
  await win.evaluate(async () => {
    await (window as any).api.addWorkspaceFinding(null, "a fresh durable finding from another session", "user")
  })

  // The quiet KNOWS-tier affordance appears, statically visible (no hover needed), with the
  // honest copy + an always-visible Re-prime button.
  const reprime = win.locator(".agent-rail-reprime")
  await expect(reprime).toBeVisible({ timeout: 15_000 })
  await expect(reprime.locator(".agent-rail-reprime-text")).toContainText("Workspace memory updated")
  await expect(reprime.locator(".agent-rail-reprime-text")).toContainText("re-prime to pull")
  const reprimeBtn = reprime.locator(".agent-rail-reprime-btn")
  await expect(reprimeBtn).toBeVisible()
  await expect(reprimeBtn).toBeEnabled()

  // Clicking Re-prime clears the mark → the affordance disappears.
  await reprimeBtn.click()
  await expect(win.locator(".agent-rail-reprime")).toHaveCount(0, { timeout: 15_000 })

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

test("CAPP-93 / U5: killing a session opens the Keep modal (pre-checked editable rows, statically-visible Remove); Keep & delete promotes to workspace memory", async () => {
  // Seed a session that HAS promotable findings, auto-restore it, kill it (Ctrl+K),
  // and assert the KillSessionModal renders: three visible buttons, one PRE-CHECKED
  // editable row per finding, and the per-row Remove control STATICALLY visible (no
  // hover). Then drive "Keep & delete" and assert the session is gone AND a (possibly
  // edited) finding landed in the untagged workspace-memory bucket.
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-kill-keep-"))
  await seedStructuredConfig(tempHome)
  const ccId = "k111cafe-0000-4000-8000-000000000abc"
  const cwd = join(tempHome, "work")
  await seedSessionForKill(tempHome, ccId, cwd)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CLAUDETUI_FAKE_STREAM: "1", CI: "1" },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })

  // The seeded session auto-restores into a structured surface (NOT an xterm) and is
  // the active session.
  await expect(win.locator(".agent-composer textarea")).toBeVisible({ timeout: 30_000 })

  // Kill the active session via Ctrl+K — this now OPENS the modal (no window.confirm).
  await win.keyboard.press("Control+k")

  const modal = win.locator(".kill-modal-panel")
  await expect(modal).toBeVisible({ timeout: 15_000 })
  await expect(modal.locator(".kill-modal-title")).toContainText("Doomed session")

  // BLOCKING contract: merely opening the modal must NOT kill the session — it stays put
  // until a footer button is pressed (proves there is no silent default delete).
  await expect(win.locator(".session-name", { hasText: "Doomed session" })).toHaveCount(1)

  // One editable row per promotable note (all 4 notes — active AND ruled-out — are
  // promotable). Every row is PRE-CHECKED (default = promote ALL).
  const rows = modal.locator(".kill-modal-finding")
  await expect(rows).toHaveCount(4, { timeout: 10_000 })
  const checks = modal.locator(".kill-modal-check")
  await expect(checks).toHaveCount(4)
  for (let i = 0; i < 4; i++) await expect(checks.nth(i)).toBeChecked()

  // The findings text is editable (a controlled <input> seeded with the note text).
  const inputs = modal.locator(".kill-modal-finding-input")
  await expect(inputs.first()).toHaveValue("the bug is a race in reopenTerminal")

  // The per-row Remove control is STATICALLY visible WITHOUT hovering (no hover-reveal).
  // Assert visibility on every row before any pointer interaction.
  const removeBtns = modal.locator(".kill-modal-remove")
  await expect(removeBtns).toHaveCount(4)
  for (let i = 0; i < 4; i++) await expect(removeBtns.nth(i)).toBeVisible()

  // All three footer buttons are visible.
  await expect(modal.locator(".kill-modal-keep")).toBeVisible()
  await expect(modal.locator(".kill-modal-delete")).toBeVisible()
  await expect(modal.locator(".kill-modal-cancel")).toBeVisible()

  // Edit the first finding's text (pressSequentially — real per-keystroke typing, NOT
  // fill) so we can prove the EDITED text is what gets promoted. Clear it first.
  await inputs.first().click()
  await inputs.first().press("Control+a")
  await inputs.first().press("Delete")
  await inputs.first().pressSequentially("edited race finding", { delay: 10 })
  await expect(inputs.first()).toHaveValue("edited race finding")

  // Trim one row out of the keep list via its Remove control (proves trimming works).
  await removeBtns.nth(1).click()
  await expect(modal.locator(".kill-modal-finding")).toHaveCount(3)

  // Keep & delete → promote the checked/edited findings into the OWNING (untagged)
  // workspace memory, THEN kill. The modal closes and the session row disappears.
  await modal.locator(".kill-modal-keep").click()
  await expect(win.locator(".kill-modal-panel")).toHaveCount(0, { timeout: 15_000 })
  await expect(win.locator(".session-name", { hasText: "Doomed session" })).toHaveCount(0, {
    timeout: 15_000,
  })

  // The edited finding landed in the untagged workspace-memory bucket (addressed by
  // null). Read it back through the same preload accessor the editor uses.
  await expect(async () => {
    const mem = await win.evaluate(() => (window as any).api.getWorkspaceMemory(null))
    const texts: string[] = (mem?.findings ?? []).map((f: any) => f.text)
    expect(texts).toContain("edited race finding")
    // The trimmed (removed) finding did NOT promote.
    expect(texts).not.toContain("structured engine is the default")
  }).toPass({ timeout: 15_000 })

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("CAPP-93 / U5: Delete everything kills WITHOUT promoting; Cancel keeps the session", async () => {
  // The negative control: "Delete everything" deletes the session but promotes NOTHING
  // (workspace memory stays empty). Also verifies Cancel is non-destructive.
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-kill-delete-"))
  await seedStructuredConfig(tempHome)
  const ccId = "k222cafe-0000-4000-8000-000000000abc"
  const cwd = join(tempHome, "work")
  await seedSessionForKill(tempHome, ccId, cwd)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CLAUDETUI_FAKE_STREAM: "1", CI: "1" },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })
  await expect(win.locator(".agent-composer textarea")).toBeVisible({ timeout: 30_000 })

  // Open the modal, then CANCEL — the session must still exist (non-destructive).
  await win.keyboard.press("Control+k")
  await expect(win.locator(".kill-modal-panel")).toBeVisible({ timeout: 15_000 })
  // Unchecking every finding disables "Keep & delete" so it can't silently degrade to a
  // plain delete — the user must pick "Delete everything" explicitly in that case.
  const cancelChecks = win.locator(".kill-modal-check")
  await expect(cancelChecks).toHaveCount(4)
  for (let i = 0; i < 4; i++) await cancelChecks.nth(i).uncheck()
  await expect(win.locator(".kill-modal-keep")).toBeDisabled()
  await win.locator(".kill-modal-cancel").click()
  await expect(win.locator(".kill-modal-panel")).toHaveCount(0, { timeout: 10_000 })
  await expect(win.locator(".session-name", { hasText: "Doomed session" })).toHaveCount(1)

  // Re-open and choose "Delete everything" — kills WITHOUT promoting.
  await win.keyboard.press("Control+k")
  await expect(win.locator(".kill-modal-panel")).toBeVisible({ timeout: 15_000 })
  await win.locator(".kill-modal-delete").click()
  await expect(win.locator(".kill-modal-panel")).toHaveCount(0, { timeout: 15_000 })
  await expect(win.locator(".session-name", { hasText: "Doomed session" })).toHaveCount(0, {
    timeout: 15_000,
  })

  // Nothing was promoted — the untagged workspace-memory bucket has no findings.
  await expect(async () => {
    const mem = await win.evaluate(() => (window as any).api.getWorkspaceMemory(null))
    expect((mem?.findings ?? []).length).toBe(0)
  }).toPass({ timeout: 15_000 })

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("CAPP-94 / U6: the workspace-memory editor opens from the switcher, renders sections + statically-visible controls, and Save/Add persist to the PINNED bucket", async () => {
  // Seed the untagged ("All") workspace-memory bucket so the editor has standing
  // instructions + findings (incl. a ruled-out/corrected one) to display. With no
  // workspace selected, the "Workspace memory" switcher button pins the editor to the
  // untagged bucket (addressed by null). Assert: the companion panel renders the
  // Instructions textarea + Save, the Add control, and a finding row with its Edit +
  // Delete controls STATICALLY visible (no hover). Then drive Save + Add and assert via
  // getWorkspaceMemory(null) that they persisted to the PINNED (untagged) bucket.
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-wmem-"))
  await seedStructuredConfig(tempHome)
  await seedUntaggedWorkspaceMemory(tempHome)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CLAUDETUI_FAKE_STREAM: "1", CI: "1" },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })

  // CAPP-123 — the memory entry point is a compact TEXT button ("Memory") in the
  // consolidated workspace control row (words over icons — the CAPP-122 icon-only row
  // was a regression). It is ALWAYS VISIBLE in the switcher (no hover-reveal), even in
  // "All" mode (the untagged bucket has its own memory).
  const memBtn = win.locator(".wsctl-memory")
  await expect(memBtn).toBeVisible({ timeout: 15_000 })
  await expect(memBtn).toContainText("Memory")
  await expect(memBtn).toHaveAttribute("aria-label", /workspace memory/i)

  // CAPP-123 no-hover guard: the control row's text buttons are statically visible at
  // FULL opacity AT REST (no prior hover). toBeVisible() ignores opacity, so read the
  // computed opacity directly — this catches an opacity:0 + :hover-reveal regression.
  const ctxBtnRest = win.locator(".wsctl-context")
  await expect(ctxBtnRest).toBeVisible({ timeout: 15_000 })
  await expect(ctxBtnRest).toContainText("Context")
  for (const btn of [memBtn, ctxBtnRest]) {
    const restOpacity = await btn.evaluate((el) => getComputedStyle(el).opacity)
    expect(restOpacity).toBe("1")
  }

  // CAPP-109 / S2 — the editor now opens IN the main window's ModalHost (modal-by-default).
  await memBtn.click()

  const panel = win.locator(".modal-host-panel .workspace-memory-panel")
  await expect(panel).toBeVisible({ timeout: 15_000 })

  // Instructions section: a textarea seeded from the record + an explicit Save button.
  const instr = panel.locator(".wmem-instructions")
  await expect(instr).toBeVisible()
  await expect(instr).toHaveValue("Prefer snake_case for all new modules.", { timeout: 10_000 })
  await expect(panel.locator(".wmem-save-btn")).toBeVisible()

  // The Add-finding control is statically visible.
  await expect(panel.locator(".wmem-add-input")).toBeVisible()
  await expect(panel.locator(".wmem-add-btn")).toBeVisible()

  // A finding row renders with its per-row Edit + Delete controls STATICALLY visible
  // (no hover). Assert on every row before any pointer interaction.
  const findingRows = panel.locator(".wmem-finding")
  await expect(findingRows).toHaveCount(3, { timeout: 10_000 })
  const editBtns = panel.locator(".wmem-finding .wmem-mini", { hasText: "Edit" })
  const deleteBtns = panel.locator(".wmem-finding .wmem-delete")
  await expect(editBtns).toHaveCount(3)
  await expect(deleteBtns).toHaveCount(3)
  for (let i = 0; i < 3; i++) {
    await expect(editBtns.nth(i)).toBeVisible()
    await expect(deleteBtns.nth(i)).toBeVisible()
  }

  // The ruled-out finding renders a strikethrough + its correction (the supersede graph).
  await expect(panel.locator(".wmem-struck")).toContainText("init carries the catalog immediately")
  await expect(panel.locator(".wmem-correction")).toContainText(
    "the catalog is empty until the first turn",
  )

  // EDIT the instructions and Save → persists to the PINNED (untagged) bucket.
  await instr.click()
  await instr.press("Control+a")
  await instr.press("Delete")
  await instr.pressSequentially("Always run npm test before committing.", { delay: 5 })
  await panel.locator(".wmem-save-btn").click()

  // ADD a new finding → persists too.
  const addInput = panel.locator(".wmem-add-input")
  await addInput.click()
  await addInput.pressSequentially("workspace memory is durable", { delay: 5 })
  await panel.locator(".wmem-add-btn").click()
  // The new finding row appears (4 total).
  await expect(panel.locator(".wmem-finding")).toHaveCount(4, { timeout: 10_000 })

  // LIVE-REFRESH (CAPP-94 review fix; CAPP-109/S2 — now same-window): mutate the SAME
  // bucket from the MAIN window. The open editor (now in the main-window ModalHost) must
  // update via the `workspace:memory-changed` push — NOT an in-panel optimistic update
  // (this add did not originate in the panel). Asserts the editor refreshes off the push.
  await win.evaluate(() =>
    (window as any).api.addWorkspaceFinding(null, "added from the main window", "user"),
  )
  await expect(
    panel.locator(".wmem-finding", { hasText: "added from the main window" }),
  ).toHaveCount(1, { timeout: 15_000 })
  await expect(panel.locator(".wmem-finding")).toHaveCount(5, { timeout: 15_000 })

  // Read back through the MAIN-window accessor (addressing the same untagged bucket via
  // null): both the edited instructions and the new finding landed in the PINNED bucket.
  await expect(async () => {
    const mem = await win.evaluate(() => (window as any).api.getWorkspaceMemory(null))
    expect(mem?.instructions).toBe("Always run npm test before committing.")
    const texts: string[] = (mem?.findings ?? []).map((f: any) => f.text)
    expect(texts).toContain("workspace memory is durable")
  }).toPass({ timeout: 15_000 })

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("CAPP-97: the workspace-memory editor shows a statically-visible Pin toggle per finding, and toggling it persists", async () => {
  // Seed the untagged ("All") bucket (reused seed: 3 findings) so the editor has rows
  // to pin. Open the editor in the companion window, assert one statically-visible Pin
  // control per row (NO hover), click the first to pin it, and verify the button reflects
  // the pinned state AND the backend persisted `pinned: true` to the untagged bucket.
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-wmem-pin-"))
  await seedStructuredConfig(tempHome)
  await seedUntaggedWorkspaceMemory(tempHome)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CLAUDETUI_FAKE_STREAM: "1", CI: "1" },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })

  const memBtn = win.locator(".wsctl-memory")
  await expect(memBtn).toBeVisible({ timeout: 15_000 })
  // CAPP-109 / S2 — opens in the main-window ModalHost (modal-by-default).
  await memBtn.click()

  const panel = win.locator(".modal-host-panel .workspace-memory-panel")
  await expect(panel).toBeVisible({ timeout: 15_000 })

  // One STATICALLY-visible Pin control per finding row (no hover-reveal — HARD rule).
  const findingRows = panel.locator(".wmem-finding")
  await expect(findingRows).toHaveCount(3, { timeout: 10_000 })
  const pinBtns = panel.locator(".wmem-finding .wmem-pin")
  await expect(pinBtns).toHaveCount(3)
  for (let i = 0; i < 3; i++) {
    await expect(pinBtns.nth(i)).toBeVisible()
    // Starts unpinned: the button reads "Pin" and is NOT marked pinned.
    await expect(pinBtns.nth(i)).toHaveText("Pin")
  }

  // Pin the FIRST finding. Its button flips to the pinned state ("📌 Pinned" + is-pinned).
  const firstPin = pinBtns.nth(0)
  await firstPin.click()
  await expect(firstPin).toContainText("Pinned", { timeout: 10_000 })
  await expect(firstPin).toHaveClass(/is-pinned/)
  // The row also gets the pinned marker + class.
  await expect(panel.locator(".wmem-finding.pinned")).toHaveCount(1)
  await expect(panel.locator(".wmem-pin-marker")).toHaveCount(1)

  // The backend persisted pinned:true to the untagged bucket (addressed by null).
  await expect(async () => {
    const mem = await win.evaluate(() => (window as any).api.getWorkspaceMemory(null))
    const pinnedCount = (mem?.findings ?? []).filter((f: any) => f.pinned === true).length
    expect(pinnedCount).toBe(1)
  }).toPass({ timeout: 15_000 })

  // Unpin it again → the button reverts and the pin clears on disk.
  await firstPin.click()
  await expect(firstPin).toHaveText("Pin", { timeout: 10_000 })
  await expect(panel.locator(".wmem-finding.pinned")).toHaveCount(0)
  await expect(async () => {
    const mem = await win.evaluate(() => (window as any).api.getWorkspaceMemory(null))
    const pinnedCount = (mem?.findings ?? []).filter((f: any) => f.pinned === true).length
    expect(pinnedCount).toBe(0)
  }).toPass({ timeout: 15_000 })

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("CAPP-99 / E1: the workspace-memory editor's Export section enables export and surfaces a copy-able @import line", async () => {
  // The EXPORT pillar. With no workspace selected, the editor pins to the untagged ("All")
  // bucket — folderless, so Mode A is unavailable and Mode C is the only option, default-OFF
  // with the machine-wide warning. Assert: the Export section + the untagged warning render
  // statically; enabling Mode C writes the export file, flips the section to ON, and surfaces
  // the exact absolute @import line; the "Copy line" button copies it to the clipboard.
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-export-"))
  await seedStructuredConfig(tempHome)
  await seedUntaggedWorkspaceMemory(tempHome)

  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CLAUDETUI_FAKE_STREAM: "1", CI: "1" },
  })

  const win: Page = await app.firstWindow()
  const pageErrors: string[] = []
  win.on("pageerror", (err) => pageErrors.push(String(err)))

  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })

  const memBtn = win.locator(".wsctl-memory")
  await expect(memBtn).toBeVisible({ timeout: 15_000 })
  // CAPP-109 / S2 — opens in the main-window ModalHost (modal-by-default).
  await memBtn.click()

  const panel = win.locator(".modal-host-panel .workspace-memory-panel")
  await expect(panel).toBeVisible({ timeout: 15_000 })

  // The Export section renders (statically visible — no hover-reveal).
  const exportSection = panel.locator(".wmem-export")
  await expect(exportSection).toBeVisible({ timeout: 10_000 })

  // Folderless/untagged → the machine-wide warning is shown.
  await expect(exportSection.locator(".wmem-export-warning")).toContainText(/every raw/i)

  // Untagged is Mode-C-only: the Mode-A radio is absent; the Mode-C radio is present + checked.
  await expect(exportSection.locator("input[type=radio]")).toHaveCount(1)

  // Enable export (Mode C, default path). The section flips to ON and surfaces the @import line.
  await exportSection.locator(".wmem-export-enable").click()
  await expect(exportSection.locator(".wmem-export-status")).toContainText(/ON/i, { timeout: 15_000 })

  // The exact @import line is shown (Mode C → an absolute @<path>), with a Copy button.
  const importLine = exportSection.locator(".wmem-export-import-line")
  await expect(importLine).toBeVisible({ timeout: 10_000 })
  await expect(importLine).toContainText("@")
  await expect(importLine).toContainText("workspace-memory.md")
  const lineText = (await importLine.textContent())?.trim() ?? ""
  expect(lineText.startsWith("@")).toBe(true)

  // The "Copy line" button is statically visible and clickable (the clipboard write itself
  // is environment-gated in headless Electron; we assert the affordance, not the OS clipboard).
  const copyBtn = exportSection.locator(".wmem-mini", { hasText: "Copy line" })
  await expect(copyBtn).toBeVisible()
  await copyBtn.click()
  // The line stays visible after the copy (the click is non-destructive).
  await expect(importLine).toBeVisible()

  // The export state persisted: read it back through the main-window accessor. The file
  // exists and is enabled (one-directional projection of the durable store).
  await expect(async () => {
    const st = await win.evaluate(() => (window as any).api.getExportState(null))
    expect(st?.enabled).toBe(true)
    expect(st?.mode).toBe("C")
    expect(typeof st?.importLine).toBe("string")
  }).toPass({ timeout: 15_000 })

  expect(pageErrors, `uncaught renderer errors:\n${pageErrors.join("\n")}`).toEqual([])
})

test("CAPP-98 / I1: the always-visible 'Context' switcher button opens the READ-ONLY inspector with the honesty header", async () => {
  // The Context Inspector v1. With no workspace selected, the always-visible "Context"
  // switcher button (next to "Workspace memory", NO hover-reveal) opens the READ-ONLY
  // inspector in the companion window for the untagged "All" bucket (folderless). Assert:
  // the button is statically visible, it opens the .context-inspector-panel in the
  // companion window, the verbatim honesty header is present, the tiers enumerate (incl.
  // a "none" placeholder for an absent tier), and the always-visible Refresh re-inspects.
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-ctx-inspect-"))
  await seedStructuredConfig(tempHome)
  // Seed the untagged bucket so tier #10 (the injected primer) has content to render.
  await seedUntaggedWorkspaceMemory(tempHome)

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

  // The tiers enumerate as collapsible sections — including a "none" placeholder for an
  // absent tier (the completeness claim depends on showing empties, never omitting them).
  await expect(panel.locator(".ctx-source").first()).toBeVisible()
  await expect(panel.locator(".ctx-badge-none").first()).toBeVisible()

  // The Mission Control primer (tier 10) is present (the untagged bucket was seeded).
  await expect(panel.locator(".ctx-source", { hasText: "Mission Control primer" })).toBeVisible()

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
