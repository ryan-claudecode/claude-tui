import { describe, it, expect } from "vitest"
import { CompanionService, type CompanionWindowLike } from "./companion"

/**
 * A fake companion window that records sends and lets the test control when
 * `did-finish-load` fires (the readiness gate) and when `closed` fires.
 */
class FakeWindow implements CompanionWindowLike {
  sent: Array<{ channel: string; args: unknown[] }> = []
  showCount = 0
  closed = false
  destroyed = false
  private finishLoad: (() => void) | null = null
  private closedListener: (() => void) | null = null

  webContents = {
    send: (channel: string, ...args: unknown[]) => {
      this.sent.push({ channel, args })
    },
    once: (_event: "did-finish-load", listener: () => void) => {
      this.finishLoad = listener
    },
  }

  on(_event: "closed", listener: () => void) {
    this.closedListener = listener
  }

  show() {
    this.showCount++
  }

  moveTop() {}

  isDestroyed() {
    return this.destroyed
  }

  loadURL(_url: string) {}
  loadFile(_path: string) {}

  close() {
    this.closed = true
    this.fireClosed()
  }

  /** Simulate the renderer finishing its load. */
  fireDidFinishLoad() {
    this.finishLoad?.()
  }

  /** Simulate Electron's "closed" event firing. */
  fireClosed() {
    this.closedListener?.()
  }
}

/**
 * CompanionService with the window factory overridden to hand back fakes,
 * exposing each created window so the test can drive its lifecycle.
 */
class TestCompanionService extends CompanionService {
  windows: FakeWindow[] = []
  protected createWindow(): CompanionWindowLike {
    const w = new FakeWindow()
    this.windows.push(w)
    return w
  }
}

/** Let queued `ready.then(...)` microtasks settle. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe("CompanionService readiness gate", () => {
  it("queues events sent before did-finish-load and delivers them once, in order, after load", async () => {
    const svc = new TestCompanionService()

    svc.sendToCompanion("panel:show", { id: "a" })
    svc.sendToCompanion("panel:update", { id: "b" })

    const win = svc.windows[0]
    // Nothing delivered yet — the renderer hasn't finished loading.
    await flush()
    expect(win.sent).toEqual([])

    // Renderer finishes loading → queued sends flush in order.
    win.fireDidFinishLoad()
    await flush()

    expect(win.sent).toEqual([
      { channel: "panel:show", args: [{ id: "a" }] },
      { channel: "panel:update", args: [{ id: "b" }] },
    ])
    // Exactly once each — no duplicates.
    expect(win.sent.length).toBe(2)
  })

  it("delivers events sent after load immediately", async () => {
    const svc = new TestCompanionService()

    // Open the window and let it finish loading.
    svc.sendToCompanion("panel:show", { id: "a" })
    const win = svc.windows[0]
    win.fireDidFinishLoad()
    await flush()
    expect(win.sent.length).toBe(1)

    // A later send reuses the ready window and delivers promptly.
    svc.sendToCompanion("panel:update", { id: "b" })
    await flush()

    expect(win.sent).toEqual([
      { channel: "panel:show", args: [{ id: "a" }] },
      { channel: "panel:update", args: [{ id: "b" }] },
    ])
    // Reused the same window rather than creating a new one.
    expect(svc.windows.length).toBe(1)
    expect(win.showCount).toBe(1)
  })

  it("drops events to a destroyed window without throwing", async () => {
    const svc = new TestCompanionService()

    svc.sendToCompanion("panel:show", { id: "a" })
    const win = svc.windows[0]

    // Window gets destroyed before the ready gate resolves.
    win.destroyed = true
    win.fireDidFinishLoad()
    await flush()

    // No send attempted on the destroyed window, and no throw escaped.
    expect(win.sent).toEqual([])
  })

  it("reopening after closed creates a new window and a fresh ready gate", async () => {
    const svc = new TestCompanionService()

    // First window opens, loads, receives an event.
    svc.sendToCompanion("panel:show", { id: "a" })
    const first = svc.windows[0]
    first.fireDidFinishLoad()
    await flush()
    expect(first.sent.length).toBe(1)

    // Window closes (e.g. user closed it / all panels hidden).
    first.fireClosed()

    // Next send must build a brand-new window, not send into the closed one.
    svc.sendToCompanion("panel:show", { id: "b" })
    expect(svc.windows.length).toBe(2)
    const second = svc.windows[1]
    expect(second).not.toBe(first)

    // The new window has its own gate — nothing delivered until it finishes loading.
    await flush()
    expect(second.sent).toEqual([])
    second.fireDidFinishLoad()
    await flush()
    expect(second.sent).toEqual([{ channel: "panel:show", args: [{ id: "b" }] }])

    // The old window received nothing further.
    expect(first.sent.length).toBe(1)
  })
})
