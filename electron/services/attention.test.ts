import { describe, it, expect, vi } from "vitest"
import { AttentionService, type AttentionDeps } from "./attention"
import type { PanelService, PanelEvent } from "./panels"
import type { TerminalService, TerminalEvent } from "./terminals"
import type { NotificationService, NotificationState } from "./notifications"

/**
 * Minimal fake emitters: expose the exact `onEvent`/`onNotification` surface
 * AttentionService subscribes to, plus an `emit*` helper to drive it by hand. No
 * real PTY, no Electron, no ~/.claude-tui — the suite stays hermetic (P1-6).
 */
class FakePanels {
  private cbs = new Set<(e: PanelEvent) => void>()
  onEvent(cb: (e: PanelEvent) => void) {
    this.cbs.add(cb)
    return () => this.cbs.delete(cb)
  }
  emit(e: PanelEvent) {
    for (const cb of this.cbs) cb(e)
  }
}

class FakeTerminals {
  private cbs = new Set<(e: TerminalEvent) => void>()
  onEvent(cb: (e: TerminalEvent) => void) {
    this.cbs.add(cb)
    return () => this.cbs.delete(cb)
  }
  emit(e: TerminalEvent) {
    for (const cb of this.cbs) cb(e)
  }
}

class FakeNotifications {
  private cbs = new Set<(n: NotificationState) => void>()
  onNotification(cb: (n: NotificationState) => void) {
    this.cbs.add(cb)
    return () => this.cbs.delete(cb)
  }
  emit(n: NotificationState) {
    for (const cb of this.cbs) cb(n)
  }
}

interface Harness {
  svc: AttentionService
  panels: FakePanels
  terminals: FakeTerminals
  notifications: FakeNotifications
  snapshots: any[][]
  toasts: Array<{ message: string; level: string }>
  osNotifications: Array<{ title: string; body: string; onClick: () => void }>
  jumps: string[]
  setFocused: (v: boolean) => void
  setOsEnabled: (v: boolean) => void
  setSessionOf: (fn: (id: string) => string | undefined) => void
  tick: () => void
}

/** A controllable clock so `since` values are deterministic. */
function makeHarness(opts: { focused?: boolean; osEnabled?: boolean } = {}): Harness {
  const panels = new FakePanels()
  const terminals = new FakeTerminals()
  const notifications = new FakeNotifications()
  const snapshots: any[][] = []
  const toasts: Array<{ message: string; level: string }> = []
  const osNotifications: Array<{ title: string; body: string; onClick: () => void }> = []
  const jumps: string[] = []
  let focused = opts.focused ?? false
  let osEnabled = opts.osEnabled ?? true
  let sessionOf: (id: string) => string | undefined = (id) => `sess-of-${id}`
  let clock = 1_000

  const deps: AttentionDeps = {
    sendToRenderer: (channel, ...args) => {
      if (channel === "attention:updated") snapshots.push(args[0] as any[])
      if (channel === "attention:jump") jumps.push(args[0] as string)
    },
    sessionOf: (id) => sessionOf(id),
    isWindowFocused: () => focused,
    osNotificationsEnabled: () => osEnabled,
    notify: (message, level) => toasts.push({ message, level }),
    showOsNotification: (o) => osNotifications.push(o),
    logWarn: () => {},
  }

  const svc = new AttentionService(
    panels as unknown as PanelService,
    terminals as unknown as TerminalService,
    notifications as unknown as NotificationService,
    deps,
    { now: () => clock },
  )

  return {
    svc,
    panels,
    terminals,
    notifications,
    snapshots,
    toasts,
    osNotifications,
    jumps,
    setFocused: (v) => (focused = v),
    setOsEnabled: (v) => (osEnabled = v),
    setSessionOf: (fn) => (sessionOf = fn),
    tick: () => (clock += 1000),
  }
}

describe("AttentionService — blocked (tier 1)", () => {
  it("enqueues a blocked entry on form-pending and clears it on form-resolved", () => {
    const h = makeHarness()
    h.panels.emit({ type: "form-pending", panelId: "panel-1", origin: { sessionId: "s1", terminalId: "t1" } })
    expect(h.svc.list()).toHaveLength(1)
    const [entry] = h.svc.list()
    expect(entry).toMatchObject({ tier: 1, kind: "blocked", sessionId: "s1", terminalId: "t1" })

    h.panels.emit({ type: "form-resolved", panelId: "panel-1" })
    expect(h.svc.list()).toHaveLength(0)
  })

  it("uses the default reason for a plain form and the CAPP-107 question reason when supplied", () => {
    const h = makeHarness()
    h.panels.emit({ type: "form-pending", panelId: "p-plain", origin: { terminalId: "t1" } })
    expect(h.svc.list()[0].reason).toBe("Form waiting for you")

    // A first-class question (ask_user) rides the reason on the form-pending event.
    h.panels.emit({
      type: "form-pending",
      panelId: "p-q",
      origin: { terminalId: "t2" },
      reason: "Question: Ship it?",
    })
    const q = h.svc.list().find((e) => e.terminalId === "t2")!
    expect(q.reason).toBe("Question: Ship it?")
  })

  it("does NOT clear a blocked entry on focus/seen — only the form resolve clears it", () => {
    const h = makeHarness()
    h.panels.emit({ type: "form-pending", panelId: "panel-1", origin: { terminalId: "t1" } })
    h.svc.seen("t1")
    expect(h.svc.list()).toHaveLength(1)
    expect(h.svc.list()[0].kind).toBe("blocked")
  })

  it("resolves sessionId via sessionOf when origin omits it", () => {
    const h = makeHarness()
    h.setSessionOf(() => "resolved-session")
    h.panels.emit({ type: "form-pending", panelId: "p", origin: { terminalId: "t9" } })
    expect(h.svc.list()[0].sessionId).toBe("resolved-session")
  })

  it("keys anonymous (no-terminal) forms on the panel id so each gets its own entry", () => {
    const h = makeHarness()
    h.panels.emit({ type: "form-pending", panelId: "p1", origin: {} })
    h.panels.emit({ type: "form-pending", panelId: "p2", origin: {} })
    expect(h.svc.list()).toHaveLength(2)
    h.panels.emit({ type: "form-resolved", panelId: "p1" })
    expect(h.svc.list()).toHaveLength(1)
  })
})

describe("AttentionService — tier-1 toast + OS notification", () => {
  it("always raises an in-app toast, and an OS notification only when unfocused + enabled", () => {
    const h = makeHarness({ focused: false, osEnabled: true })
    h.panels.emit({ type: "form-pending", panelId: "p", origin: { terminalId: "t1" } })
    expect(h.toasts).toHaveLength(1)
    expect(h.osNotifications).toHaveLength(1)
    // The OS notification's click emits attention:jump with the entry id.
    h.osNotifications[0].onClick()
    expect(h.jumps).toEqual(["blocked:t1"])
  })

  it("suppresses the OS notification when the window is focused", () => {
    const h = makeHarness({ focused: true, osEnabled: true })
    h.panels.emit({ type: "form-pending", panelId: "p", origin: { terminalId: "t1" } })
    expect(h.toasts).toHaveLength(1)
    expect(h.osNotifications).toHaveLength(0)
  })

  it("suppresses the OS notification when osNotifications is disabled", () => {
    const h = makeHarness({ focused: false, osEnabled: false })
    h.panels.emit({ type: "form-pending", panelId: "p", origin: { terminalId: "t1" } })
    expect(h.osNotifications).toHaveLength(0)
  })
})

describe("AttentionService — asked / finished (terminal idle)", () => {
  it("enqueues asked when the idle tail shows the prompt", () => {
    const h = makeHarness()
    h.terminals.emit({ type: "state", id: "t1", state: "idle", burstMs: 500, promptDetected: true })
    const [e] = h.svc.list()
    expect(e).toMatchObject({ tier: 2, kind: "asked", terminalId: "t1" })
  })

  it("enqueues finished only after a burst >= the 10s guardrail (no prompt)", () => {
    const h = makeHarness()
    // Short burst, no prompt — a fresh-spawn blip; must NOT enqueue.
    h.terminals.emit({ type: "state", id: "t1", state: "idle", burstMs: 3000, promptDetected: false })
    expect(h.svc.list()).toHaveLength(0)
    // Sustained burst — finished enqueues.
    h.terminals.emit({ type: "state", id: "t2", state: "idle", burstMs: 12000, promptDetected: false })
    expect(h.svc.list()).toHaveLength(1)
    expect(h.svc.list()[0]).toMatchObject({ tier: 3, kind: "finished", terminalId: "t2" })
  })

  it("ignores active state events (only idle transitions enqueue)", () => {
    const h = makeHarness()
    h.terminals.emit({ type: "state", id: "t1", state: "active" })
    expect(h.svc.list()).toHaveLength(0)
  })
})

describe("AttentionService — error notifications", () => {
  it("enqueues a tier-2 error for an attributed error/warning toast", () => {
    const h = makeHarness()
    h.notifications.emit({
      id: "n1",
      level: "error",
      message: "Build failed: TS2304",
      timeout: 5000,
      createdAt: 0,
      sessionId: "s1",
    })
    expect(h.svc.list()[0]).toMatchObject({ tier: 2, kind: "error", sessionId: "s1" })
    expect(h.svc.list()[0].reason).toContain("Build failed")
  })

  it("does NOT enqueue an unattributed toast (no sessionId)", () => {
    const h = makeHarness()
    h.notifications.emit({ id: "n1", level: "error", message: "boom", timeout: 5000, createdAt: 0 })
    expect(h.svc.list()).toHaveLength(0)
  })

  it("does NOT enqueue info/success toasts even with a sessionId", () => {
    const h = makeHarness()
    h.notifications.emit({ id: "n1", level: "info", message: "done", timeout: 5000, createdAt: 0, sessionId: "s1" })
    h.notifications.emit({ id: "n2", level: "success", message: "ok", timeout: 5000, createdAt: 0, sessionId: "s1" })
    expect(h.svc.list()).toHaveLength(0)
  })
})

describe("AttentionService — tier replacement + since preservation", () => {
  it("a higher tier replaces a lower one for the same terminal and preserves since", () => {
    const h = makeHarness()
    // finished (tier 3) lands first at clock=1000.
    h.terminals.emit({ type: "state", id: "t1", state: "idle", burstMs: 12000, promptDetected: false })
    const finishedSince = h.svc.list()[0].since
    expect(h.svc.list()[0].kind).toBe("finished")

    h.tick() // clock -> 2000
    // asked (tier 2) upgrades — must replace finished and KEEP the original since.
    h.terminals.emit({ type: "state", id: "t1", state: "idle", burstMs: 500, promptDetected: true })
    expect(h.svc.list()).toHaveLength(1)
    const asked = h.svc.list()[0]
    expect(asked.kind).toBe("asked")
    expect(asked.since).toBe(finishedSince)

    h.tick() // clock -> 3000
    // blocked (tier 1) upgrades again — replace, preserve original since.
    h.panels.emit({ type: "form-pending", panelId: "p", origin: { terminalId: "t1" } })
    expect(h.svc.list()).toHaveLength(1)
    const blocked = h.svc.list()[0]
    expect(blocked.kind).toBe("blocked")
    expect(blocked.since).toBe(finishedSince)
  })

  it("a lower-tier re-trigger does NOT downgrade a higher entry", () => {
    const h = makeHarness()
    h.panels.emit({ type: "form-pending", panelId: "p", origin: { terminalId: "t1" } })
    // finished arrives after — must be ignored; blocked stays.
    h.terminals.emit({ type: "state", id: "t1", state: "idle", burstMs: 12000, promptDetected: false })
    expect(h.svc.list()).toHaveLength(1)
    expect(h.svc.list()[0].kind).toBe("blocked")
  })

  it("an equal-tier same-id re-trigger refreshes reason but keeps since", () => {
    const h = makeHarness()
    h.notifications.emit({ id: "n1", level: "error", message: "first", timeout: 0, createdAt: 0, sessionId: "s1" })
    const since = h.svc.list()[0].since
    h.tick()
    h.notifications.emit({ id: "n2", level: "error", message: "second", timeout: 0, createdAt: 0, sessionId: "s1" })
    expect(h.svc.list()).toHaveLength(1)
    expect(h.svc.list()[0].since).toBe(since)
    expect(h.svc.list()[0].reason).toContain("second")
  })
})

describe("AttentionService — ordering", () => {
  it("orders tier-ascending then since-ascending (oldest first within a tier)", () => {
    const h = makeHarness()
    // Two tier-2 asked entries at different times.
    h.terminals.emit({ type: "state", id: "t1", state: "idle", burstMs: 0, promptDetected: true })
    h.tick()
    h.terminals.emit({ type: "state", id: "t2", state: "idle", burstMs: 0, promptDetected: true })
    h.tick()
    // A tier-3 finished and a tier-1 blocked.
    h.terminals.emit({ type: "state", id: "t3", state: "idle", burstMs: 12000, promptDetected: false })
    h.panels.emit({ type: "form-pending", panelId: "p", origin: { terminalId: "t4" } })

    const order = h.svc.list().map((e) => `${e.tier}:${e.terminalId}`)
    expect(order).toEqual(["1:t4", "2:t1", "2:t2", "3:t3"])
  })
})

describe("AttentionService — seen / dismiss / kill cleanup", () => {
  it("seen() clears a terminal's tier-2/3 entries", () => {
    const h = makeHarness()
    h.terminals.emit({ type: "state", id: "t1", state: "idle", burstMs: 0, promptDetected: true })
    expect(h.svc.list()).toHaveLength(1)
    h.svc.seen("t1")
    expect(h.svc.list()).toHaveLength(0)
  })

  it("dismiss() drops a single entry by id", () => {
    const h = makeHarness()
    h.terminals.emit({ type: "state", id: "t1", state: "idle", burstMs: 0, promptDetected: true })
    const id = h.svc.list()[0].id
    expect(h.svc.dismiss(id)).toBe(true)
    expect(h.svc.list()).toHaveLength(0)
    expect(h.svc.dismiss("nope")).toBe(false)
  })

  it("a terminal exit clears all of that terminal's entries (incl. blocked)", () => {
    const h = makeHarness()
    h.panels.emit({ type: "form-pending", panelId: "p", origin: { terminalId: "t1" } })
    h.terminals.emit({ type: "state", id: "t2", state: "idle", burstMs: 12000, promptDetected: false })
    expect(h.svc.list()).toHaveLength(2)
    h.terminals.emit({ type: "exit", id: "t1" })
    expect(h.svc.list().map((e) => e.terminalId)).toEqual(["t2"])
  })

  it("clearSession() removes every entry owned by a killed session", () => {
    const h = makeHarness()
    h.setSessionOf((id) => (id === "t1" ? "sX" : "sY"))
    h.terminals.emit({ type: "state", id: "t1", state: "idle", burstMs: 0, promptDetected: true })
    h.terminals.emit({ type: "state", id: "t2", state: "idle", burstMs: 0, promptDetected: true })
    h.svc.clearSession("sX")
    expect(h.svc.list().map((e) => e.terminalId)).toEqual(["t2"])
  })
})

describe("AttentionService — request()", () => {
  it("adds a tier-2 asked entry prefixed as agent-requested", () => {
    const h = makeHarness()
    const entry = h.svc.request("s1", "t1", "need a decision on the API shape")
    expect(entry).toMatchObject({ tier: 2, kind: "asked", sessionId: "s1", terminalId: "t1" })
    expect(entry.reason).toMatch(/agent asked/i)
    expect(h.svc.list()).toHaveLength(1)
  })

  it("publishes a snapshot to the renderer on each change", () => {
    const h = makeHarness()
    h.svc.request("s1", "t1", "hi")
    expect(h.snapshots.length).toBeGreaterThan(0)
    expect(h.snapshots.at(-1)).toHaveLength(1)
  })
})

describe("AttentionService — tier-1 toast carries no sessionId (no error loop)", () => {
  it("the tier-1 toast does not itself enqueue an error entry", () => {
    // Regression guard: fireTier1 calls notify(); if that toast carried a
    // sessionId it would loop back as a tier-2 error for the same terminal.
    const h = makeHarness({ focused: true })
    h.panels.emit({ type: "form-pending", panelId: "p", origin: { terminalId: "t1", sessionId: "s1" } })
    expect(h.svc.list()).toHaveLength(1)
    expect(h.svc.list()[0].kind).toBe("blocked")
    // toast captured but it never round-trips through onNotification in the real
    // wiring because the injected notify here is a stub — assert intent via deps.
    expect(h.toasts).toHaveLength(1)
  })
})
