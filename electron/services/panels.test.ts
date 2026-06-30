import { describe, it, expect, beforeEach } from "vitest"
import { PanelService } from "./panels"

/**
 * CAPP-109 / S2 — routing + form-lifecycle integration tests for PanelService.
 *
 * The load-bearing facts under test:
 *  - modal-by-default: a fresh panel routes to the MAIN bridge ONLY (the companion is
 *    never touched → never auto-created).
 *  - showForm → main bridge gets panel:show; submitForm RESOLVES the pending promise
 *    AND routes panel:hide so neither mirror keeps a zombie (F3).
 *  - hide() (the modal's backdrop/Escape/×/tab-close sink) resolves a pending form as
 *    {cancelled:true} — so the MCP show_form call never hangs.
 *  - a surface:"window" (popped-out) panel ALSO routes to the companion (no regression).
 */

interface Captured {
  channel: string
  args: unknown[]
}

function makeBridges() {
  const main: Captured[] = []
  const companion: Captured[] = []
  const svc = new PanelService()
  svc.setMainBridge({ send: (channel, ...args) => main.push({ channel, args }) })
  svc.setCompanion({
    sendToCompanion: (channel, ...args) => companion.push({ channel, args }),
    close: () => {},
  })
  return { svc, main, companion }
}

describe("PanelService — modal-by-default routing (CAPP-109 / S2)", () => {
  let env: ReturnType<typeof makeBridges>
  beforeEach(() => {
    env = makeBridges()
  })

  it("show() routes panel:show to the MAIN bridge ONLY (companion untouched)", () => {
    const panel = env.svc.show("markdown", { content: "# Hi" })
    expect(panel.surface).toBe("modal")
    expect(env.main.map((c) => c.channel)).toEqual(["panel:show"])
    expect(env.companion).toHaveLength(0)
  })

  it("update() routes to the main bridge only for a modal panel", () => {
    const panel = env.svc.show("markdown", { content: "a" })
    env.main.length = 0
    env.svc.update(panel.id, { content: "b" })
    expect(env.main.map((c) => c.channel)).toEqual(["panel:update"])
    expect(env.companion).toHaveLength(0)
  })

  it("hideAll() clears the main mirror and signals the companion (clear-everything)", () => {
    env.svc.show("markdown", { content: "a" })
    env.svc.show("table", { rows: [] })
    env.main.length = 0
    env.companion.length = 0
    env.svc.hideAll()
    // Each tracked panel gets a panel:hide on the main bridge + the panel:hide-all sweep.
    expect(env.main.filter((c) => c.channel === "panel:hide")).toHaveLength(2)
    expect(env.main.some((c) => c.channel === "panel:hide-all")).toBe(true)
    // routeAll always pokes the companion for the sweep.
    expect(env.companion.some((c) => c.channel === "panel:hide-all")).toBe(true)
    expect(env.svc.list()).toHaveLength(0)
  })
})

describe("PanelService — show_form lifecycle through the modal (CAPP-109 / S2)", () => {
  let env: ReturnType<typeof makeBridges>
  beforeEach(() => {
    env = makeBridges()
  })

  it("showForm → main bridge gets panel:show; submit RESOLVES + clears BOTH mirrors (F3)", async () => {
    const formPromise = env.svc.showForm({ title: "Confirm?" })
    const shown = env.main.find((c) => c.channel === "panel:show")
    expect(shown).toBeTruthy()
    const panelId = (shown!.args[0] as { id: string }).id

    env.main.length = 0
    env.svc.submitForm(panelId, { ok: true })

    // The MCP call resolves with the submitted data.
    await expect(formPromise).resolves.toEqual({ ok: true })
    // panel:hide routed so the main mirror drops the resolved form (no zombie).
    expect(env.main.some((c) => c.channel === "panel:hide")).toBe(true)
    expect(env.svc.list()).toHaveLength(0)
  })

  it("hide() resolves a pending form as {cancelled:true} — the MCP call never hangs", async () => {
    const formPromise = env.svc.showForm({ title: "Confirm?" })
    const panelId = (env.main.find((c) => c.channel === "panel:show")!.args[0] as { id: string }).id

    env.svc.hide(panelId)

    await expect(formPromise).resolves.toEqual({ cancelled: true })
    expect(env.svc.list()).toHaveLength(0)
  })

  it("hideAll() resolves a pending form as {cancelled:true}", async () => {
    const formPromise = env.svc.showForm({ title: "Confirm?" })
    env.svc.hideAll()
    await expect(formPromise).resolves.toEqual({ cancelled: true })
  })

  it("show_form THEN show_panel — the form is STILL submittable (strand-guard backend)", async () => {
    // The form-exclusivity that keeps the form ACTIVE lives in the renderer (useActivePanel,
    // tested separately). The backend invariant the modal relies on: a later show_panel does
    // NOT touch the pending form's promise — submitForm on the original id still resolves it.
    const formPromise = env.svc.showForm({ title: "Confirm?" })
    const formId = (env.main.find((c) => c.channel === "panel:show")!.args[0] as { id: string }).id

    const markdown = env.svc.show("markdown", { content: "# later" })
    expect(markdown.id).not.toBe(formId)
    // Both panels coexist in the store.
    expect(env.svc.list().map((p) => p.id).sort()).toEqual([formId, markdown.id].sort())

    // The form remains resolvable.
    env.svc.submitForm(formId, { answer: 42 })
    await expect(formPromise).resolves.toEqual({ answer: 42 })
    // The markdown panel is untouched (still tracked).
    expect(env.svc.list().map((p) => p.id)).toEqual([markdown.id])
  })
})

describe("PanelService — popped-out (surface:window) panel routes to companion (no regression)", () => {
  it("a panel flipped to surface:window emits update/hide to BOTH bridges", () => {
    const { svc, main, companion } = makeBridges()
    const panel = svc.show("markdown", { content: "a" })
    // Simulate S3's popOut flipping the surface (popOut() itself lands in S3).
    ;(panel as { surface: string }).surface = "window"
    main.length = 0
    companion.length = 0

    svc.update(panel.id, { content: "b" })
    expect(main.map((c) => c.channel)).toContain("panel:update")
    expect(companion.map((c) => c.channel)).toContain("panel:update")

    main.length = 0
    companion.length = 0
    svc.hide(panel.id)
    expect(main.map((c) => c.channel)).toContain("panel:hide")
    expect(companion.map((c) => c.channel)).toContain("panel:hide")
  })
})
