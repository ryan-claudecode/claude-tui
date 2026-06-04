# Sessions-as-Containers — Foundation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the current per-terminal service to `TerminalService` and introduce a new durable `SessionService` *container* (session records + atomic persistence + status derivation + note lifecycle + `get_session_context` formatting), fully unit-tested, with the app still building and running exactly as before.

**Architecture:** The existing `electron/services/sessions.ts` (which manages PTYs — one per "session" today) is renamed to `electron/services/terminals.ts` (`TerminalService`, `TerminalInfo`, `TerminalActivity`). A brand-new `electron/services/sessions.ts` holds `SessionService` — a durable container persisted to `~/.claude-tui/sessions/<id>.json`, mirroring `MissionService`'s proven patterns (atomic tmp+rename persist, DI of `now`/`dir` for testing). This plan builds the tested engine; Plans 2–3 wire it to MCP/seed-prompts and the UI. The container does **not** touch the renderer, IPC channel strings, preload names, or MCP tool names — those external contracts stay stable, so app behavior is unchanged.

**Tech Stack:** TypeScript, Electron, electron-vite, vitest. Node `fs` (`writeFileSync`/`renameSync`/`mkdirSync`/`readdirSync`/`readFileSync`).

**Spec:** `docs/superpowers/specs/2026-06-04-sessions-as-containers-design.md`

**Scope OUT of this plan (Plans 2–3):** MCP tools (`session_note`/`get_session_context`/`set_terminal_activity`), seed-prompt hijack, idle-flush summary generation, lazy-spawn + `--resume` reattach wiring, and the entire UI rework (sidebar tree, tabbar, Overview panel, keymap, status/activity rendering).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `electron/services/terminals.ts` | RENAMED from `sessions.ts`. `TerminalService` — runtime PTY ops (create/kill/write/waitForIdle/etc.). Behavior identical to today; only identifiers change. |
| `electron/services/sessions.ts` | NEW. `SessionService` — durable session-container records, persistence, status derivation, notes, context formatting. Pure logic + fs; no PTY ownership in this plan. |
| `electron/services/sessions.test.ts` | NEW. Vitest unit tests for `SessionService`, mirroring `mission.test.ts` DI patterns. |
| `electron/ipc.ts`, `electron/mcp/server.ts`, `electron/mcp/tools.ts`, `electron/services/{broadcast,layouts,snippets,templates,workspaces,mission}.ts` | Import-site updates only (path + renamed symbols). |

**Importers to update during the rename** (verified via grep):
- `electron/ipc.ts:3` — `import { SessionService } from "./services/sessions"`
- `electron/mcp/server.ts:4` — `import type { SessionService } from "../services/sessions"`
- `electron/mcp/tools.ts:3` — `import type { SessionService } from "../services/sessions"`
- `electron/services/broadcast.ts:1` — `import type { SessionService } from "./sessions"`
- `electron/services/layouts.ts:4` — `import type { SessionService, SessionInfo } from "./sessions"`
- `electron/services/snippets.ts:4` — `import type { SessionService } from "./sessions"`
- `electron/services/templates.ts:1` — `import type { SessionService, SessionInfo } from "./sessions"`
- `electron/services/workspaces.ts:3` — `import type { SessionService, SessionInfo } from "./sessions"`
- `electron/services/mission.ts:4` — `import type { SessionInfo, SessionActivity } from "./sessions"`

---

## Task 1: Rename `SessionService` → `TerminalService`

Mechanical, behavior-preserving rename. The TypeScript compiler is the safety net — it flags every unresolved reference, so the build is the verification.

**Files:**
- Rename: `electron/services/sessions.ts` → `electron/services/terminals.ts`
- Modify: all 9 importers listed above

- [ ] **Step 1: Rename the file**

```bash
git mv electron/services/sessions.ts electron/services/terminals.ts
```

- [ ] **Step 2: Rename the symbols inside `electron/services/terminals.ts`**

Within `electron/services/terminals.ts`, rename (whole-word):
- `class SessionService` → `class TerminalService`
- `interface SessionInfo` → `interface TerminalInfo`
- `interface Session ` → `interface Terminal ` (the internal one, L13)
- `interface SessionActivity` → `interface TerminalActivity`
- every internal use of those type names (e.g. `SessionInfo[]`, `Map<string, Session>`, `SessionActivity[]`) → the new names.

Do **not** change: IPC channel strings (`"session:created"`, `"session:data"`, etc. — these are renderer contracts), method names (`create`, `kill`, …), or the `CLAUDE_TUI` env var.

- [ ] **Step 3: Update the 9 importers**

In each importer, change the path `"./sessions"`→`"./terminals"` (or `"../services/sessions"`→`"../services/terminals"`) and the symbols:
- `SessionService` → `TerminalService`
- `SessionInfo` → `TerminalInfo`
- `SessionActivity` → `TerminalActivity`

Also update local identifiers that hold the service instance type, e.g. in `electron/ipc.ts` any `sessionService: SessionService` parameter/field type becomes `TerminalService` (keep the **variable name** `sessionService` to minimize churn — only the *type* changes). Same for `mcp/tools.ts`'s `registerTools(server, sessions: SessionService, …)` → `sessions: TerminalService` (keep param name `sessions`).

- [ ] **Step 4: Build to verify the rename is complete**

Run: `npm run build`
Expected: exits 0, no `TS2307` (cannot find module) or `TS2304` (cannot find name) errors. If any appear, they pinpoint a missed reference — fix and rebuild.

- [ ] **Step 5: Run the existing test suite (behavior unchanged)**

Run: `npx vitest run`
Expected: PASS — the same 23 mission tests pass (the rename doesn't touch `mission.ts` logic, only the imported type names).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: rename SessionService to TerminalService (frees Session for the container)"
```

---

## Task 2: `SessionService` skeleton + records + atomic persistence

**Files:**
- Create: `electron/services/sessions.ts`
- Create: `electron/services/sessions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `electron/services/sessions.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { SessionService } from "./sessions"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ctui-sess-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("SessionService persistence", () => {
  it("create() makes an active, empty, named-placeholder session and persists it atomically", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    expect(s.status).toBe("active")
    expect(s.terminals).toEqual([])
    expect(s.notes).toEqual([])
    expect(s.provisionalFindings).toEqual([])
    expect(s.summary).toBe("")
    expect(s.createdAt).toBe(1000)
    // persisted to <dir>/<id>.json
    const file = join(dir, `${s.id}.json`)
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, "utf-8")).id).toBe(s.id)
    // no leftover tmp file
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it("load() rehydrates persisted sessions from disk", () => {
    const a = new SessionService({ dir, now: () => 1000 })
    const s = a.create()
    const b = new SessionService({ dir, now: () => 2000 })
    b.load()
    expect(b.get(s.id)?.id).toBe(s.id)
    expect(b.list().length).toBe(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: FAIL — "Cannot find module './sessions'" / `SessionService` is not exported.

- [ ] **Step 3: Write the minimal implementation**

Create `electron/services/sessions.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "fs"
import { join } from "path"
import { homedir } from "os"

export interface TerminalRef {
  id: string
  name: string
  cwd: string
  ccConversationId?: string
  lastState: "active" | "idle" | "dead"
}

export interface Note {
  id: string
  text: string
  createdAt: number
  source: "self" | "observer"
  status: "active" | "superseded"
  supersededBy?: string
}

export interface WorkSession {
  id: string
  name: string
  status: "active" | "stopped"
  workspaceId?: string
  summary: string
  notes: Note[]
  provisionalFindings: Note[]
  terminals: TerminalRef[]
  createdAt: number
  updatedAt: number
}

export interface SessionServiceOpts {
  dir?: string
  now?: () => number
}

export class SessionService {
  private sessions = new Map<string, WorkSession>()
  private dir: string
  private now: () => number

  constructor(opts: SessionServiceOpts = {}) {
    this.dir = opts.dir ?? join(homedir(), ".claude-tui", "sessions")
    this.now = opts.now ?? (() => Date.now())
  }

  create(): WorkSession {
    const t = this.now()
    const s: WorkSession = {
      id: `session-${t}-${Math.random().toString(36).slice(2, 8)}`,
      name: "Untitled session",
      status: "active",
      summary: "",
      notes: [],
      provisionalFindings: [],
      terminals: [],
      createdAt: t,
      updatedAt: t,
    }
    this.sessions.set(s.id, s)
    this.persist(s)
    return s
  }

  get(id: string): WorkSession | undefined { return this.sessions.get(id) }
  list(): WorkSession[] { return [...this.sessions.values()] }

  load(): void {
    let files: string[]
    try { files = readdirSync(this.dir) } catch { return }
    for (const f of files) {
      if (!f.endsWith(".json")) continue
      try {
        const s = JSON.parse(readFileSync(join(this.dir, f), "utf-8")) as WorkSession
        this.sessions.set(s.id, s)
      } catch { /* skip malformed */ }
    }
  }

  private persist(s: WorkSession): void {
    s.updatedAt = this.now()
    mkdirSync(this.dir, { recursive: true })
    const dest = join(this.dir, `${s.id}.json`)
    const tmp = `${dest}.tmp`
    writeFileSync(tmp, JSON.stringify(s, null, 2))
    renameSync(tmp, dest)
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/services/sessions.ts electron/services/sessions.test.ts
git commit -m "feat: SessionService container skeleton with atomic persistence + load"
```

---

## Task 3: Terminal membership (add/remove/rename) + session naming

**Files:**
- Modify: `electron/services/sessions.ts`
- Test: `electron/services/sessions.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `electron/services/sessions.test.ts`:

```ts
describe("SessionService terminals", () => {
  it("addTerminal stores a TerminalRef and persists", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    svc.addTerminal(s.id, { id: "t1", name: "Untitled", cwd: "/r", lastState: "active" })
    expect(svc.get(s.id)!.terminals).toEqual([
      { id: "t1", name: "Untitled", cwd: "/r", lastState: "active" },
    ])
  })

  it("removeTerminal drops it but keeps the session alive (empty-but-live)", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    svc.addTerminal(s.id, { id: "t1", name: "x", cwd: "/r", lastState: "active" })
    svc.removeTerminal(s.id, "t1")
    expect(svc.get(s.id)).toBeDefined()
    expect(svc.get(s.id)!.terminals).toEqual([])
  })

  it("first terminal's first name sets the session name when still placeholder", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    svc.addTerminal(s.id, { id: "t1", name: "Untitled", cwd: "/r", lastState: "active" })
    svc.nameTerminal(s.id, "t1", "Fix auth race")
    expect(svc.get(s.id)!.terminals[0].name).toBe("Fix auth race")
    expect(svc.get(s.id)!.name).toBe("Fix auth race") // session inherits from first terminal
  })

  it("naming a later terminal does NOT overwrite an already-named session", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    svc.addTerminal(s.id, { id: "t1", name: "Untitled", cwd: "/r", lastState: "active" })
    svc.nameTerminal(s.id, "t1", "First")
    svc.addTerminal(s.id, { id: "t2", name: "Untitled", cwd: "/r", lastState: "active" })
    svc.nameTerminal(s.id, "t2", "Second")
    expect(svc.get(s.id)!.name).toBe("First")
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: FAIL — `addTerminal`/`removeTerminal`/`nameTerminal` are not functions.

- [ ] **Step 3: Implement**

Add these methods to the `SessionService` class in `electron/services/sessions.ts`:

```ts
  addTerminal(sessionId: string, ref: TerminalRef): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    if (!s.terminals.some((t) => t.id === ref.id)) s.terminals.push(ref)
    this.persist(s)
  }

  removeTerminal(sessionId: string, terminalId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.terminals = s.terminals.filter((t) => t.id !== terminalId)
    this.persist(s)
  }

  nameTerminal(sessionId: string, terminalId: string, name: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const t = s.terminals.find((x) => x.id === terminalId)
    if (!t) return
    t.name = name
    // Session inherits its name from the FIRST terminal while still a placeholder.
    if (s.name === "Untitled session" && s.terminals[0]?.id === terminalId) s.name = name
    this.persist(s)
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: PASS (all terminal tests green).

- [ ] **Step 5: Commit**

```bash
git add electron/services/sessions.ts electron/services/sessions.test.ts
git commit -m "feat: session terminal membership + first-terminal naming"
```

---

## Task 4: Status derivation (session display label)

**Files:**
- Modify: `electron/services/sessions.ts`
- Test: `electron/services/sessions.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `electron/services/sessions.test.ts`:

```ts
describe("SessionService.deriveStatus", () => {
  const mk = (svc: SessionService) => svc.create()

  it("Empty when no terminals", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = mk(svc)
    expect(svc.deriveStatus(s.id)).toBe("Empty")
  })

  it("Stopped when session.status is stopped", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = mk(svc)
    svc.addTerminal(s.id, { id: "t1", name: "x", cwd: "/r", lastState: "idle" })
    svc.setStatus(s.id, "stopped")
    expect(svc.deriveStatus(s.id)).toBe("Stopped")
  })

  it("Idle when live terminals exist but none active", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = mk(svc)
    svc.addTerminal(s.id, { id: "t1", name: "x", cwd: "/r", lastState: "idle" })
    expect(svc.deriveStatus(s.id)).toBe("Idle")
  })

  it("counts active terminals (singular vs plural)", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = mk(svc)
    svc.addTerminal(s.id, { id: "t1", name: "x", cwd: "/r", lastState: "active" })
    expect(svc.deriveStatus(s.id)).toBe("1 Terminal Working")
    svc.addTerminal(s.id, { id: "t2", name: "y", cwd: "/r", lastState: "active" })
    expect(svc.deriveStatus(s.id)).toBe("2 Terminals Working")
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: FAIL — `deriveStatus`/`setStatus` are not functions.

- [ ] **Step 3: Implement**

Add to `SessionService`:

```ts
  setStatus(sessionId: string, status: "active" | "stopped"): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.status = status
    this.persist(s)
  }

  /** Human-readable session label derived from status + terminal states. */
  deriveStatus(sessionId: string): string {
    const s = this.sessions.get(sessionId)
    if (!s) return "Stopped"
    if (s.terminals.length === 0) return "Empty"
    if (s.status === "stopped") return "Stopped"
    const active = s.terminals.filter((t) => t.lastState === "active").length
    if (active > 0) return `${active} Terminal${active === 1 ? "" : "s"} Working`
    return "Idle"
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/sessions.ts electron/services/sessions.test.ts
git commit -m "feat: session status derivation (Empty/Stopped/Idle/[n] Working)"
```

---

## Task 5: Note lifecycle — append + `corrects` (supersede)

**Files:**
- Modify: `electron/services/sessions.ts`
- Test: `electron/services/sessions.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `electron/services/sessions.test.ts`:

```ts
describe("SessionService notes", () => {
  it("addNote appends an active self-sourced note", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    const n = svc.addNote(s.id, "root cause is the N+1 query")
    expect(n!.text).toBe("root cause is the N+1 query")
    expect(n!.status).toBe("active")
    expect(n!.source).toBe("self")
    expect(svc.get(s.id)!.notes).toHaveLength(1)
  })

  it("addNote with corrects supersedes the referenced note and links it", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    const first = svc.addNote(s.id, "bug is in auth")!
    const second = svc.addNote(s.id, "actually it's the list endpoint", { corrects: first.id })!
    const notes = svc.get(s.id)!.notes
    const stored = notes.find((x) => x.id === first.id)!
    expect(stored.status).toBe("superseded")
    expect(stored.supersededBy).toBe(second.id)
    expect(notes.find((x) => x.id === second.id)!.status).toBe("active")
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: FAIL — `addNote` is not a function.

- [ ] **Step 3: Implement**

Add to `SessionService`:

```ts
  addNote(sessionId: string, text: string, opts: { corrects?: string } = {}): Note | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    const note: Note = {
      id: `note-${this.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text,
      createdAt: this.now(),
      source: "self",
      status: "active",
    }
    if (opts.corrects) {
      const target = s.notes.find((n) => n.id === opts.corrects)
      if (target) {
        target.status = "superseded"
        target.supersededBy = note.id
      }
    }
    s.notes.push(note)
    this.persist(s)
    return note
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/sessions.ts electron/services/sessions.test.ts
git commit -m "feat: session note lifecycle with corrects/supersede"
```

---

## Task 6: `getContext` formatting (summary → active → ruled-out) + `setSummary`

**Files:**
- Modify: `electron/services/sessions.ts`
- Test: `electron/services/sessions.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `electron/services/sessions.test.ts`:

```ts
describe("SessionService.getContext", () => {
  it("orders summary first, then active notes, then a ruled-out section with corrections", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    svc.setSummary(s.id, "Goal: fix the auth race. Currently patching middleware.")
    const wrong = svc.addNote(s.id, "bug is in auth")!
    svc.addNote(s.id, "actually it's the list endpoint", { corrects: wrong.id })
    svc.addNote(s.id, "tests live in mission.test.ts")
    const ctx = svc.getContext(s.id)!
    // summary leads
    expect(ctx.indexOf("Goal: fix the auth race")).toBeGreaterThanOrEqual(0)
    // active notes present
    expect(ctx).toContain("actually it's the list endpoint")
    expect(ctx).toContain("tests live in mission.test.ts")
    // ruled-out section present and shows the superseded note with its correction
    expect(ctx).toContain("Ruled out")
    expect(ctx).toContain("bug is in auth")
    // ordering: summary before active before ruled-out
    expect(ctx.indexOf("Goal:")).toBeLessThan(ctx.indexOf("actually it's the list endpoint"))
    expect(ctx.indexOf("actually it's the list endpoint")).toBeLessThan(ctx.indexOf("Ruled out"))
  })

  it("omits the ruled-out section when nothing is superseded", () => {
    const svc = new SessionService({ dir, now: () => 1000 })
    const s = svc.create()
    svc.addNote(s.id, "only a live note")
    expect(svc.getContext(s.id)!).not.toContain("Ruled out")
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: FAIL — `setSummary`/`getContext` are not functions.

- [ ] **Step 3: Implement**

Add to `SessionService`:

```ts
  setSummary(sessionId: string, summary: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.summary = summary
    this.persist(s)
  }

  /** The primer a terminal pulls: summary, then active notes, then ruled-out (with corrections). */
  getContext(sessionId: string): string | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    const parts: string[] = []
    parts.push(`# Session: ${s.name}`)
    if (s.summary.trim()) parts.push(`## Summary\n${s.summary.trim()}`)

    const active = s.notes.filter((n) => n.status === "active")
    if (active.length) {
      parts.push(`## Findings\n` + active.map((n) => `- ${n.text}`).join("\n"))
    }

    const superseded = s.notes.filter((n) => n.status === "superseded")
    if (superseded.length) {
      const lines = superseded.map((n) => {
        const correction = s.notes.find((c) => c.id === n.supersededBy)
        return correction ? `- ~~${n.text}~~ → ${correction.text}` : `- ~~${n.text}~~`
      })
      parts.push(`## Ruled out / corrected\n` + lines.join("\n"))
    }
    return parts.join("\n\n")
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run electron/services/sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + build (foundation green)**

Run: `npx vitest run` then `npm run build`
Expected: all tests pass (23 mission + new session tests); build exits 0.

- [ ] **Step 6: Commit**

```bash
git add electron/services/sessions.ts electron/services/sessions.test.ts
git commit -m "feat: get_session_context formatting (summary/active/ruled-out) + setSummary"
```

---

## Done criteria (Plan 1)

- `electron/services/terminals.ts` is the renamed PTY service; app builds and runs unchanged.
- `electron/services/sessions.ts` exports a `SessionService` container with: `create`, `get`, `list`, `load`, `addTerminal`, `removeTerminal`, `nameTerminal`, `setStatus`, `deriveStatus`, `addNote` (with `corrects`), `setSummary`, `getContext`.
- All persisted atomically to `~/.claude-tui/sessions/<id>.json`.
- Full vitest suite green; `npm run build` exits 0.
- **Next:** Plan 2 (context-engine wiring: MCP tools + seed hijack + idle-flush + lazy-spawn/resume), then Plan 3 (UI rework).
```
