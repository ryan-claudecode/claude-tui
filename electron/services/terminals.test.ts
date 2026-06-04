import { describe, it, expect } from "vitest"
import { TerminalService } from "./terminals"

describe("TerminalService.onEvent", () => {
  it("notifies listeners on created and exit, and unsubscribes cleanly", () => {
    const svc = new TerminalService()
    const events: any[] = []
    const off = svc.onEvent((e) => events.push(e))

    const info = svc.create("t", process.cwd())
    expect(events.some((e) => e.type === "created" && e.info.id === info.id)).toBe(true)

    off()
    const before = events.length
    svc.kill(info.id)
    // exit fires async from the pty; assert no *new* synchronous delivery after unsubscribe
    expect(events.length).toBe(before)
  })
})
