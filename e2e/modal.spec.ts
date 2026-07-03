import { test, expect, _electron, type ElectronApplication } from "@playwright/test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * CAPP-109 / S2 — ModalHost e2e: a panel/form renders IN the main window (modal-by-
 * default, no companion auto-pop), a real form submits through the modal end-to-end,
 * and a show_panel landing behind a form gets a TAB while the form stays active +
 * submittable (the M2 strand-guard). Hermetic via a temp USERPROFILE (see smoke.spec.ts).
 */

let app: ElectronApplication | undefined
let tempHome: string | undefined

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

test("ModalHost renders a panel in the MAIN window (no companion needed)", async () => {
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-e2e-modal-"))
  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CI: "1" },
  })
  const win = await app.firstWindow()
  await win.waitForSelector("#root", { timeout: 30_000 })
  // Wait for the shell to fully boot (proves the panel:* IPC handlers — registered after
  // the MCP server starts — are live) before driving showPanel, avoiding a startup race.
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })

  // Show a markdown panel through the real panel:show IPC (the same path the agent's
  // show_panel uses). It must render in the in-main-window ModalHost. Retried via toPass
  // so a not-yet-registered handler on the first call self-heals.
  const overlay = win.locator(".modal-host-overlay")
  await expect(async () => {
    await win.evaluate(async () => {
      await (window as any).api.showPanel("markdown", { content: "# Hello modal" })
    })
    await expect(overlay).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
  await expect(win.locator(".modal-host-panel")).toContainText("Hello modal")
  // The pop-out + close affordances are statically visible (no hover-reveal).
  await expect(win.locator(".modal-host-popout")).toBeVisible()
  await expect(win.locator(".modal-host-close")).toBeVisible()

  // Close via the × button → window.api.hidePanel → the modal unmounts.
  await win.locator(".modal-host-close").click()
  await expect(overlay).toBeHidden({ timeout: 10_000 })
})

test("a real form renders in the modal and SUBMITS end-to-end", async () => {
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-e2e-modalform-"))
  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CI: "1" },
  })
  const win = await app.firstWindow()
  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })

  // Mount a form panel via panel:show, then submit it via the rendered DOM. The submit
  // goes window.api.submitForm → panel:form-submit IPC → PanelService.submitForm, which
  // routes panel:hide back to the main mirror so the modal unmounts (F3). (The blocking
  // pending-promise is MCP-only and covered by the service unit tests; here we verify the
  // renderer round-trip end-to-end through the modal.)
  await expect(async () => {
    await win.evaluate(async () => {
      await (window as any).api.showPanel("form", {
        title: "Confirm action",
        fields: [{ name: "note", type: "text", label: "Note", placeholder: "type…" }],
        submitLabel: "Go",
      })
    })
    await expect(win.locator(".modal-host-overlay")).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
  await expect(win.locator(".form-title")).toContainText("Confirm action")

  await win.locator(".form-input").fill("hi there")
  await win.locator(".form-submit", { hasText: "Go" }).click()

  // After submit the form panel is hidden → the modal unmounts.
  await expect(win.locator(".modal-host-overlay")).toBeHidden({ timeout: 10_000 })
})

test("show_panel behind a form → form stays ACTIVE, the panel gets a TAB (strand-guard)", async () => {
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-e2e-strand-"))
  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CI: "1" },
  })
  const win = await app.firstWindow()
  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })

  // Show the form FIRST (retry-safe — only this single panel is created on a retry, so the
  // tab-count assertion below stays exact). Form-exclusivity must then keep it active.
  await expect(async () => {
    await win.evaluate(async () => {
      await (window as any).api.showPanel("form", {
        title: "Blocking form",
        fields: [{ name: "x", type: "text", label: "X" }],
        submitLabel: "Send",
      })
    })
    await expect(win.locator(".modal-host-overlay")).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })

  // THEN a markdown panel lands behind it (handlers are proven live now → show once).
  await win.evaluate(async () => {
    await (window as any).api.showPanel("markdown", { content: "# Later panel" })
  })

  // The FORM is the active body (form-exclusive), NOT the later markdown.
  await expect(win.locator(".modal-host-body .form-title")).toContainText("Blocking form")
  await expect(win.locator(".modal-host-body")).not.toContainText("Later panel")
  // A real tab strip appears (visible.length > 1), with a tab for the markdown panel.
  const tabs = win.locator(".modal-host-tab")
  await expect(tabs).toHaveCount(2)

  // The form is still submittable while the later panel sits in a tab.
  await win.locator(".modal-host-body .form-input").fill("answer")
  await win.locator(".modal-host-body .form-submit", { hasText: "Send" }).click()

  // The form resolves + unmounts; the markdown panel remains (now the active body).
  await expect(win.locator(".modal-host-body")).toContainText("Later panel", { timeout: 10_000 })
})

test("CAPP-107 ask_user question card renders in the modal and submits a choice", async () => {
  tempHome = await mkdtemp(join(tmpdir(), "claudetui-e2e-question-"))
  app = await _electron.launch({
    args: [".", `--user-data-dir=${join(tempHome, "electron-data")}`],
    env: { ...process.env, USERPROFILE: tempHome, CI: "1" },
  })
  const win = await app.firstWindow()
  await win.waitForSelector("#root", { timeout: 30_000 })
  await expect(win.locator(".sidebar-brand")).toContainText("ClaudeTUI", { timeout: 30_000 })

  // The ask_user tool composes a kind:"question" form; drive that same shape through
  // panel:show so the QuestionForm variant renders in the ModalHost (the renderer path
  // is identical — the blocking pending-promise is MCP-only, covered by unit tests).
  await expect(async () => {
    await win.evaluate(async () => {
      await (window as any).api.showPanel("form", {
        kind: "question",
        question: "Deploy to prod now?",
        context: "prod is live",
        options: ["Yes", "No"],
      })
    })
    await expect(win.locator(".modal-host-overlay")).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })

  // The question card, its context subline, and both options are visible at rest.
  await expect(win.locator(".question-title")).toContainText("Deploy to prod now?")
  await expect(win.locator(".question-context")).toContainText("prod is live")
  const options = win.locator(".question-option")
  await expect(options).toHaveCount(2)
  // Submit is disabled until a choice is made (no empty answers), Cancel is visible.
  await expect(win.locator(".question-form .form-submit")).toBeDisabled()
  await expect(win.locator(".question-cancel")).toBeVisible()

  // Pick "Yes" then submit → the modal unmounts (the form-submit round-trip).
  await options.filter({ hasText: "Yes" }).click()
  await expect(win.locator(".question-form .form-submit")).toBeEnabled()
  await win.locator(".question-form .form-submit").click()
  await expect(win.locator(".modal-host-overlay")).toBeHidden({ timeout: 10_000 })
})
