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
  let focusCount = 0
  // CAPP-116 — model the REAL CompanionService window lifecycle: `sendToCompanion`
  // lazily CREATES the window when closed (getOrCreate), `sendIfOpen` delivers only
  // when it is already open. A plain-push fake hid the ghost-resurrection bug.
  let windowOpen = false
  let createdCount = 0
  const svc = new PanelService()
  svc.setMainBridge({ send: (channel, ...args) => main.push({ channel, args }) })
  svc.setCompanion({
    sendToCompanion: (channel, ...args) => {
      if (!windowOpen) {
        windowOpen = true
        createdCount++
      }
      companion.push({ channel, args })
    },
    sendIfOpen: (channel, ...args) => {
      if (windowOpen) companion.push({ channel, args })
    },
    close: () => {
      windowOpen = false
    },
    focus: () => {
      focusCount++
    },
  })
  return {
    svc,
    main,
    companion,
    focusState: () => focusCount,
    companionCreated: () => createdCount,
    companionIsOpen: () => windowOpen,
    closeCompanion: () => {
      windowOpen = false
    },
  }
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

  it("hideAll() clears the main mirror; a CLOSED companion is neither poked nor created (CAPP-116)", () => {
    env.svc.show("markdown", { content: "a" })
    env.svc.show("table", { rows: [] })
    env.main.length = 0
    env.companion.length = 0
    env.svc.hideAll()
    // Each tracked panel gets a panel:hide on the main bridge + the panel:hide-all sweep.
    expect(env.main.filter((c) => c.channel === "panel:hide")).toHaveLength(2)
    expect(env.main.some((c) => c.channel === "panel:hide-all")).toBe(true)
    // CAPP-116 — the sweep must NOT touch a closed companion (sendIfOpen, non-creating).
    expect(env.companion).toHaveLength(0)
    expect(env.companionCreated()).toBe(0)
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

describe("PanelService — popOut (CAPP-110 / S3)", () => {
  let env: ReturnType<typeof makeBridges>
  beforeEach(() => {
    env = makeBridges()
  })

  it("flips surface to 'window', emits panel:show to the companion, raises it, and hides from the MAIN mirror", () => {
    const panel = env.svc.show("markdown", { content: "# Hi" })
    expect(panel.surface).toBe("modal")
    env.main.length = 0
    env.companion.length = 0

    const ok = env.svc.popOut(panel.id)
    expect(ok).toBe(true)
    expect(panel.surface).toBe("window")
    // The companion gets a fresh panel:show (it lazily creates the window there).
    expect(env.companion.map((c) => c.channel)).toEqual(["panel:show"])
    // The companion was raised.
    expect(env.focusState()).toBe(1)
    // The MAIN mirror gets ONLY a panel:hide (drop the now-popped-out panel).
    expect(env.main.map((c) => c.channel)).toEqual(["panel:hide"])
    expect((env.main[0].args[0] as string)).toBe(panel.id)
    // The panel is STILL tracked (popOut must not delete it — it lives in the companion now).
    expect(env.svc.list().map((p) => p.id)).toEqual([panel.id])
  })

  it("returns false for an unknown id (no emits)", () => {
    env.main.length = 0
    env.companion.length = 0
    expect(env.svc.popOut("panel-nope")).toBe(false)
    expect(env.main).toHaveLength(0)
    expect(env.companion).toHaveLength(0)
  })

  it("does NOT resolve a pending form — the show_form promise survives the pop-out", async () => {
    const formPromise = env.svc.showForm({ title: "Confirm?" })
    const formId = (
      env.main.find((c) => c.channel === "panel:show")!.args[0] as { id: string }
    ).id

    env.svc.popOut(formId)

    // The promise is STILL pending (popOut never touches pendingForms) and the form is
    // still tracked. We prove "unresolved" by racing it against a sentinel microtask.
    const sentinel = Symbol("pending")
    const race = await Promise.race([
      formPromise,
      Promise.resolve(sentinel),
    ])
    expect(race).toBe(sentinel)
    expect(env.svc.list().map((p) => p.id)).toEqual([formId])

    // After pop-out, a COMPANION-side submit STILL resolves the same promise (F3 regression):
    // submitForm routes panel:hide to BOTH surfaces so the main mirror has no zombie.
    env.main.length = 0
    env.companion.length = 0
    env.svc.submitForm(formId, { ok: true })
    await expect(formPromise).resolves.toEqual({ ok: true })
    // The main bridge received panel:hide for the resolved form (no zombie in the mirror).
    expect(env.main.some((c) => c.channel === "panel:hide" && c.args[0] === formId)).toBe(true)
    // The companion mirror is also cleared.
    expect(env.companion.some((c) => c.channel === "panel:hide" && c.args[0] === formId)).toBe(true)
    expect(env.svc.list()).toHaveLength(0)
  })
})

describe("PanelService — dismissWindowPanels on companion close (CAPP-110 / S3 review)", () => {
  let env: ReturnType<typeof makeBridges>
  beforeEach(() => {
    env = makeBridges()
  })

  it("cancels a popped-out pending form so the show_form MCP call never orphans", async () => {
    const formPromise = env.svc.showForm({ title: "Confirm?" })
    const formId = (
      env.main.find((c) => c.channel === "panel:show")!.args[0] as { id: string }
    ).id
    env.svc.popOut(formId) // form now lives in the companion (surface:"window")

    // User closes the companion window (× / OS) instead of submitting → dismissWindowPanels.
    env.svc.dismissWindowPanels()

    // The promise resolves CANCELLED (not orphaned) and the panel is gone.
    await expect(formPromise).resolves.toEqual({ cancelled: true })
    expect(env.svc.list()).toHaveLength(0)
  })

  it("drops popped-out non-form panels (no ghost left for the M4 loop to resurrect)", () => {
    const a = env.svc.show("markdown", { content: "# A" })
    const b = env.svc.show("mission", { id: "m1" })
    env.svc.popOut(a.id) // window
    env.svc.popOut(b.id) // window
    // A still-modal panel must SURVIVE a companion close (it lives in the main window).
    const c = env.svc.show("table", { rows: [] })
    expect(c.surface).toBe("modal")

    env.svc.dismissWindowPanels()

    // Only the modal panel remains; both window panels are dropped.
    expect(env.svc.list().map((p) => p.id)).toEqual([c.id])
  })

  it("is a no-op when nothing is popped out (only modal panels)", () => {
    const a = env.svc.show("markdown", { content: "# A" })
    env.svc.dismissWindowPanels()
    expect(env.svc.list().map((p) => p.id)).toEqual([a.id])
  })
})

describe("PanelService — ghost-companion guard on broadcasts (CAPP-116)", () => {
  let env: ReturnType<typeof makeBridges>
  beforeEach(() => {
    env = makeBridges()
  })

  it("hideAll() after the user CLOSES the companion does not resurrect it", () => {
    const a = env.svc.show("markdown", { content: "# A" })
    env.svc.popOut(a.id) // sendToCompanion — legitimately creates the window
    expect(env.companionCreated()).toBe(1)
    expect(env.companionIsOpen()).toBe(true)

    // User closes the companion (the real close chokepoint reconciles state).
    env.closeCompanion()
    env.svc.dismissWindowPanels()
    env.companion.length = 0

    // The MCP hide_all_panels path — must not spawn an empty ghost window.
    env.svc.hideAll()
    expect(env.companionCreated()).toBe(1) // still just the pop-out creation
    expect(env.companionIsOpen()).toBe(false)
    expect(env.companion).toHaveLength(0)
  })

  it("hideAll() with the companion OPEN still delivers the hide-all sweep (no regression)", () => {
    const a = env.svc.show("markdown", { content: "# A" })
    env.svc.popOut(a.id)
    env.companion.length = 0

    env.svc.hideAll()
    expect(env.companion.some((c) => c.channel === "panel:hide-all")).toBe(true)
    expect(env.companionCreated()).toBe(1) // delivery, not creation
  })

  it("submitForm's untracked-panel fallback does not create a closed companion", async () => {
    // Force the "shouldn't happen" branch: submit an id PanelService never tracked.
    env.svc.submitForm("panel-untracked", { ok: true })
    expect(env.companionCreated()).toBe(0)
    expect(env.companion).toHaveLength(0)
    // Main mirror still gets the defensive clear.
    expect(env.main.some((c) => c.channel === "panel:hide")).toBe(true)
  })

  it("popOut remains the ONLY broadcast-adjacent path allowed to create the window", () => {
    const a = env.svc.show("markdown", { content: "# A" })
    expect(env.companionCreated()).toBe(0) // modal show never touches the companion
    env.svc.popOut(a.id)
    expect(env.companionCreated()).toBe(1)
  })
})
