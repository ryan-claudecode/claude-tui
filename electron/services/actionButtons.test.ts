import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  ActionButtonService,
  dispatchActionButton,
  pickDispatchTerminal,
  MAX_BUTTONS_PER_OWNER,
  MAX_LABEL_LEN,
  UNTAGGED_STEM,
  type ActionButtonsChanged,
  type DispatchDeps,
} from "./actionButtons"

/**
 * CAPP-104 (AB-1) — the action-button store. A real service over a temp dir; every
 * external effect is fs (over the temp dir) or the injected `now`. Covers CRUD, the
 * per-owner cap, the session/workspace/untagged scoping + file layout, the onChanged
 * seam, persistence round-trip, session-kill cleanup, and the pure dispatch resolver
 * (live terminal reuse vs fresh spawn).
 */

let dir: string
let t = 1_000
const now = () => t++

function svc(): ActionButtonService {
  return new ActionButtonService({ dir, now })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ab-test-"))
  t = 1_000
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("ActionButtonService — CRUD", () => {
  it("adds a session button and lists it", () => {
    const s = svc()
    const res = s.add("session", "sess-1", { label: "Run e2e suite", prompt: "run npm run e2e" })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.button.scope).toBe("session")
    expect(res.button.ownerId).toBe("sess-1")
    expect(res.button.label).toBe("Run e2e suite")
    expect(res.button.prompt).toBe("run npm run e2e")
    expect(res.button.createdBy).toBe("agent")
    expect(s.listForOwner("session", "sess-1")).toHaveLength(1)
    expect(s.list()).toHaveLength(1)
  })

  it("trims + rejects a blank label / blank prompt", () => {
    const s = svc()
    expect(s.add("session", "sess-1", { label: "   ", prompt: "x" }).ok).toBe(false)
    expect(s.add("session", "sess-1", { label: "x", prompt: "   " }).ok).toBe(false)
    const ok = s.add("session", "sess-1", { label: "  Trim me  ", prompt: "  do it  " })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.button.label).toBe("Trim me")
      expect(ok.button.prompt).toBe("do it")
    }
  })

  it("rejects a label longer than the cap", () => {
    const s = svc()
    const res = s.add("session", "sess-1", { label: "x".repeat(MAX_LABEL_LEN + 1), prompt: "p" })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain(String(MAX_LABEL_LEN))
  })

  it("stores confirm only when set (clean file)", () => {
    const s = svc()
    const a = s.add("session", "sess-1", { label: "plain", prompt: "p" })
    const b = s.add("session", "sess-1", { label: "danger", prompt: "p", confirm: true })
    if (a.ok) expect("confirm" in a.button).toBe(false)
    if (b.ok) expect(b.button.confirm).toBe(true)
  })

  it("removes a button by (scope, owner, id)", () => {
    const s = svc()
    const res = s.add("session", "sess-1", { label: "a", prompt: "p" })
    if (!res.ok) throw new Error("add failed")
    expect(s.remove("session", "sess-1", res.button.id)).toBe(true)
    expect(s.listForOwner("session", "sess-1")).toHaveLength(0)
    // Removing again → false (already gone).
    expect(s.remove("session", "sess-1", res.button.id)).toBe(false)
  })

  it("findById scans across owners", () => {
    const s = svc()
    const a = s.add("session", "sess-1", { label: "a", prompt: "pa" })
    const b = s.add("workspace", "ws-9", { label: "b", prompt: "pb" })
    if (!a.ok || !b.ok) throw new Error("add failed")
    expect(s.findById(a.button.id)?.prompt).toBe("pa")
    expect(s.findById(b.button.id)?.prompt).toBe("pb")
    expect(s.findById("nope")).toBeUndefined()
  })
})

describe("ActionButtonService — the per-owner cap", () => {
  it(`caps at ${MAX_BUTTONS_PER_OWNER} and returns a clear error past it`, () => {
    const s = svc()
    for (let i = 0; i < MAX_BUTTONS_PER_OWNER; i++) {
      expect(s.add("session", "sess-1", { label: `b${i}`, prompt: "p" }).ok).toBe(true)
    }
    const over = s.add("session", "sess-1", { label: "one too many", prompt: "p" })
    expect(over.ok).toBe(false)
    if (!over.ok) {
      expect(over.error).toContain(String(MAX_BUTTONS_PER_OWNER))
      expect(over.error.toLowerCase()).toContain("remove one")
    }
    expect(s.listForOwner("session", "sess-1")).toHaveLength(MAX_BUTTONS_PER_OWNER)
  })

  it("the cap is PER owner (a second owner still has room)", () => {
    const s = svc()
    for (let i = 0; i < MAX_BUTTONS_PER_OWNER; i++) s.add("session", "sess-1", { label: `b${i}`, prompt: "p" })
    expect(s.add("session", "sess-2", { label: "fresh", prompt: "p" }).ok).toBe(true)
    expect(s.add("workspace", "ws-1", { label: "fresh", prompt: "p" }).ok).toBe(true)
  })
})

describe("ActionButtonService — scoping + file layout", () => {
  it("writes one file per owner with the right stems", () => {
    const s = svc()
    s.add("session", "sess-1", { label: "a", prompt: "p" })
    s.add("workspace", "ws-9", { label: "b", prompt: "p" })
    s.add("workspace", null, { label: "c", prompt: "p" }) // untagged
    expect(existsSync(join(dir, "session-sess-1.json"))).toBe(true)
    expect(existsSync(join(dir, "workspace-ws-9.json"))).toBe(true)
    expect(existsSync(join(dir, `workspace-${UNTAGGED_STEM}.json`))).toBe(true)
  })

  it("null workspace addresses the untagged bucket (stored + readable via null)", () => {
    const s = svc()
    const res = s.add("workspace", null, { label: "global", prompt: "p" })
    if (!res.ok) throw new Error("add failed")
    expect(res.button.ownerId).toBe(UNTAGGED_STEM)
    expect(s.listForOwner("workspace", null)).toHaveLength(1)
    // Addressable by the sentinel string too.
    expect(s.listForOwner("workspace", UNTAGGED_STEM)).toHaveLength(1)
  })

  it("a session button requires an owner id", () => {
    const s = svc()
    expect(() => s.add("session", null, { label: "x", prompt: "p" })).toThrow()
  })

  it("listForCaller unions the caller's session + workspace buttons", () => {
    const s = svc()
    s.add("session", "sess-1", { label: "s", prompt: "p" })
    s.add("workspace", "ws-1", { label: "w", prompt: "p" })
    s.add("session", "sess-2", { label: "other", prompt: "p" }) // not the caller
    const view = s.listForCaller("sess-1", "ws-1")
    expect(view.map((b) => b.label).sort()).toEqual(["s", "w"])
  })
})

describe("ActionButtonService — persistence + change seam", () => {
  it("survives a reconstruction (loadAll warms the cache)", () => {
    const s1 = svc()
    s1.add("session", "sess-1", { label: "keep", prompt: "p" })
    s1.add("workspace", null, { label: "global", prompt: "p" })
    const s2 = svc() // fresh instance over the same dir
    expect(s2.list()).toHaveLength(2)
    expect(s2.listForOwner("session", "sess-1")[0].label).toBe("keep")
    expect(s2.listForOwner("workspace", null)[0].label).toBe("global")
  })

  it("emits the affected owner's full set on add + remove", () => {
    const s = svc()
    const events: ActionButtonsChanged[] = []
    s.onChanged((e) => events.push(e))
    const a = s.add("session", "sess-1", { label: "a", prompt: "p" })
    if (!a.ok) throw new Error("add failed")
    expect(events.at(-1)).toMatchObject({ scope: "session", ownerId: "sess-1" })
    expect(events.at(-1)?.buttons).toHaveLength(1)
    s.remove("session", "sess-1", a.button.id)
    expect(events.at(-1)?.buttons).toHaveLength(0)
  })
})

describe("ActionButtonService — session-kill cleanup", () => {
  it("deleteForSession drops the file + cache and emits an empty set", () => {
    const s = svc()
    s.add("session", "sess-1", { label: "a", prompt: "p" })
    s.add("workspace", "ws-1", { label: "w", prompt: "p" })
    const events: ActionButtonsChanged[] = []
    s.onChanged((e) => events.push(e))

    s.deleteForSession("sess-1")
    expect(existsSync(join(dir, "session-sess-1.json"))).toBe(false)
    expect(s.listForOwner("session", "sess-1")).toHaveLength(0)
    // The workspace button is untouched (buttons outlive a session).
    expect(s.listForOwner("workspace", "ws-1")).toHaveLength(1)
    // Emitted the empty session snapshot so the rail drops the rows.
    expect(events.at(-1)).toEqual({ scope: "session", ownerId: "sess-1", buttons: [] })
  })

  it("deleteForSession on an unknown session is a silent no-op (no emit)", () => {
    const s = svc()
    const events: ActionButtonsChanged[] = []
    s.onChanged((e) => events.push(e))
    s.deleteForSession("ghost")
    expect(events).toHaveLength(0)
  })
})

describe("dispatch-target resolution (live terminal vs fresh spawn)", () => {
  it("pickDispatchTerminal returns the most recent LIVE structured terminal", () => {
    const terminals = [
      { id: "t1", engine: "structured", lastState: "idle" },
      { id: "t2", engine: "xterm", lastState: "idle" },
      { id: "t3", engine: "structured", lastState: "idle" },
    ]
    const alive = (id: string) => id !== "t3" // t3 dead → t1 is the newest live structured
    expect(pickDispatchTerminal(terminals, alive)).toBe("t1")
    // All structured terminals alive → the newest (t3).
    expect(pickDispatchTerminal(terminals, () => true)).toBe("t3")
    // None structured/alive → undefined (caller spawns fresh).
    expect(pickDispatchTerminal([{ id: "x", engine: "xterm" }], () => true)).toBeUndefined()
  })

  it("reuses a live structured terminal (no spawn)", () => {
    const spawned: string[] = []
    const sent: Array<{ terminalId: string; prompt: string }> = []
    const deps: DispatchDeps = {
      findButton: () => ({ id: "b1", label: "L", prompt: "PROMPT", scope: "session", ownerId: "s1", createdBy: "agent", createdAt: 0 }),
      getSession: () => ({ name: "terraformer", terminals: [{ id: "live", engine: "structured", lastState: "idle" }] }),
      isAlive: () => true,
      spawnTerminal: (sid) => { spawned.push(sid); return "fresh" },
      sendPrompt: (terminalId, prompt) => { sent.push({ terminalId, prompt }); return true },
    }
    const res = dispatchActionButton(deps, "b1", "s1")
    expect(res.ok).toBe(true)
    expect(res.spawned).toBe(false)
    expect(res.sessionName).toBe("terraformer")
    expect(spawned).toHaveLength(0)
    expect(sent).toEqual([{ terminalId: "live", prompt: "PROMPT" }])
  })

  it("spawns a fresh terminal when none is alive, then sends", () => {
    const sent: Array<{ terminalId: string; prompt: string }> = []
    const deps: DispatchDeps = {
      findButton: () => ({ id: "b1", label: "L", prompt: "PROMPT", scope: "session", ownerId: "s1", createdBy: "agent", createdAt: 0 }),
      getSession: () => ({ name: "s", terminals: [{ id: "dead", engine: "structured", lastState: "dead" }] }),
      isAlive: () => false, // the existing terminal is dead
      spawnTerminal: () => "fresh",
      sendPrompt: (terminalId, prompt) => { sent.push({ terminalId, prompt }); return true },
    }
    const res = dispatchActionButton(deps, "b1", "s1")
    expect(res.ok).toBe(true)
    expect(res.spawned).toBe(true)
    expect(sent).toEqual([{ terminalId: "fresh", prompt: "PROMPT" }])
  })

  it("errors when the button / session is missing, or the spawn / send fails", () => {
    const base: DispatchDeps = {
      findButton: () => ({ id: "b1", label: "L", prompt: "P", scope: "session", ownerId: "s1", createdBy: "agent", createdAt: 0 }),
      getSession: () => ({ name: "s", terminals: [] }),
      isAlive: () => false,
      spawnTerminal: () => "fresh",
      sendPrompt: () => true,
    }
    expect(dispatchActionButton({ ...base, findButton: () => undefined }, "b1", "s1").ok).toBe(false)
    expect(dispatchActionButton({ ...base, getSession: () => undefined }, "b1", "s1").ok).toBe(false)
    expect(dispatchActionButton({ ...base, spawnTerminal: () => undefined }, "b1", "s1").ok).toBe(false)
    expect(dispatchActionButton({ ...base, sendPrompt: () => false }, "b1", "s1").ok).toBe(false)
  })
})
