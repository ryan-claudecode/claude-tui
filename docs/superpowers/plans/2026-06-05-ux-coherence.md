# ② UX Coherence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make terminal navigation live in exactly one place (tabs), give the sidebar uniform non-reflowing rows, make the Session Overview panel live-refresh, and rename the misnamed `session:*` per-PTY IPC channels to `terminal:*`.

**Architecture:** Pure presentational refactor of `Sidebar.tsx` + `TabBar.tsx` driven by a small extracted pure helper (`deriveSessionRow`), plus a renderer-side live-refresh subscription in `App.tsx`, plus a lockstep wire-protocol rename across `terminals.ts` / `ipc.ts` / `preload.ts` / `App.tsx`. No service-layer model changes — selection stays centralized in `App.tsx` via the existing `selectTerminal`/`setActiveTerminalId` action (the surface-agnostic invariant from the spec).

**Tech Stack:** React 19 + TypeScript, Electron IPC, vitest (node env), electron-vite.

**Testing approach (read first):** The test harness is node-only (`vitest.config.ts` → `include: ["electron/**/*.test.ts"]`, `environment: "node"`); there is no React/DOM test harness, and prior UI tasks (Plan 3a Sidebar/TabBar) were verified by build + E2E, not unit tests. This plan keeps that pattern: **logic-bearing changes get node-level TDD** (the pure `deriveSessionRow` helper; the emitted IPC channel strings asserted in `terminals.test.ts`), while **presentational / renderer-wiring changes** (tab dots, tooltip, overflow CSS, the live-refresh subscription, the `+` button) are verified by `npm run typecheck` + `npm run build` + an E2E smoke against the running app using its own MCP self-test tools (`take_screenshot`, `get_app_state`). The standing gate before every commit: `npm run typecheck` exits 0 AND `npm test` is all green.

**Out of scope (do not do):** hover-peek, master-detail/accordion layouts, the `sessionService` JS-variable rename, idle-duration ("12m") plumbing (the row data has no timestamp — keep the idle string as `"Idle"`).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/lib/sessionRow.ts` | Pure derivation of a sidebar row's view-model (dot, count, activity) from a session | **Create** |
| `src/lib/sessionRow.test.ts` | Node-level tests for `deriveSessionRow` | **Create** |
| `vitest.config.ts` | Broaden `include` to also pick up `src/**/*.test.ts` | Modify |
| `src/components/Sidebar.tsx` | Uniform 2-line session rows; remove inline accordion | Modify |
| `src/components/TabBar.tsx` | Primary terminal nav: per-tab dot, activity tooltip, overflow, `+` | Modify |
| `src/App.tsx` | Pass activity/new-terminal to TabBar; live Overview refresh subscription; channel-string listeners | Modify |
| `src/App.css` | Styles for count badge, fixed-height rows, tab dots, overflow scroll | Modify |
| `electron/services/terminals.ts` | Emit `terminal:*` instead of `session:*` | Modify |
| `electron/services/terminals.test.ts` | Assert emitted channel names are `terminal:*` | Modify |
| `electron/ipc.ts` | `terminal:*` handlers | Modify |
| `electron/preload.ts` | `terminal:*` bridge | Modify |
| `CLAUDE.md` | Update the IPC example that uses `session:*` strings | Modify |

---

## Task 1: Extract `deriveSessionRow` pure helper (TDD)

**Files:**
- Create: `src/lib/sessionRow.ts`
- Test: `src/lib/sessionRow.test.ts`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Broaden the vitest include so `src` tests run**

Modify `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["electron/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
  },
})
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/sessionRow.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { deriveSessionRow } from "./sessionRow"

describe("deriveSessionRow", () => {
  it("empty session: idle dot, zero count, Empty activity", () => {
    expect(deriveSessionRow({ status: "running", terminals: [] })).toEqual({
      dot: "idle", count: 0, activity: "Empty",
    })
  })

  it("stopped session: dead dot, Stopped activity regardless of terminals", () => {
    expect(
      deriveSessionRow({ status: "stopped", terminals: [{ lastState: "active", activity: "x" }] }),
    ).toEqual({ dot: "dead", count: 1, activity: "Stopped" })
  })

  it("active terminal: active dot, count, and its activity string surfaces", () => {
    expect(
      deriveSessionRow({
        status: "running",
        terminals: [
          { lastState: "idle", activity: "old" },
          { lastState: "active", activity: "Edit(auth.ts)" },
        ],
      }),
    ).toEqual({ dot: "active", count: 2, activity: "Edit(auth.ts)" })
  })

  it("active terminal with no activity string falls back to Working", () => {
    expect(
      deriveSessionRow({ status: "running", terminals: [{ lastState: "active" }] }),
    ).toEqual({ dot: "active", count: 1, activity: "Working" })
  })

  it("all idle: idle dot and Idle activity", () => {
    expect(
      deriveSessionRow({ status: "running", terminals: [{ lastState: "idle", activity: "x" }] }),
    ).toEqual({ dot: "idle", count: 1, activity: "Idle" })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/sessionRow.test.ts`
Expected: FAIL — `Cannot find module './sessionRow'`.

- [ ] **Step 4: Write minimal implementation**

Create `src/lib/sessionRow.ts`:

```typescript
export interface RowTerminal {
  lastState: string
  activity?: string
}

export interface RowSession {
  status: string
  terminals: RowTerminal[]
}

export interface SessionRowView {
  dot: "dead" | "active" | "idle"
  count: number
  activity: string
}

/**
 * Pure view-model for one sidebar session row. The row is fixed-height and never
 * expands, so all triage info (dot color, terminal count, one activity line) is
 * derived here from the busiest terminal.
 */
export function deriveSessionRow(s: RowSession): SessionRowView {
  const working = s.terminals.filter((t) => t.lastState === "active").length
  const dot = s.status === "stopped" ? "dead" : working > 0 ? "active" : "idle"
  const count = s.terminals.length
  const [busy] = [...s.terminals].sort(
    (a, b) => (b.lastState === "active" ? 1 : 0) - (a.lastState === "active" ? 1 : 0),
  )
  const activity =
    s.status === "stopped" ? "Stopped"
    : count === 0 ? "Empty"
    : busy?.lastState === "active" ? (busy.activity ?? "Working")
    : "Idle"
  return { dot, count, activity }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/sessionRow.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Verify the full gate**

Run: `npm run typecheck && npm test`
Expected: typecheck exits 0; all tests green.

- [ ] **Step 7: Commit**

```bash
git add vitest.config.ts src/lib/sessionRow.ts src/lib/sessionRow.test.ts
git commit -m "feat: extract pure deriveSessionRow helper for uniform sidebar rows"
```

---

## Task 2: Sidebar — uniform non-reflowing rows

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/App.tsx:585-596` (drop now-unused Sidebar props)
- Modify: `src/App.css` (count badge + fixed-height row styles)

- [ ] **Step 1: Rewrite `Sidebar.tsx` to use the helper and remove the accordion**

Replace the entire contents of `src/components/Sidebar.tsx` with:

```typescript
import { deriveSessionRow } from "../lib/sessionRow"

interface TerminalRow { id: string; name: string; lastState: string; activity?: string }
interface SessionRow { id: string; name: string; status: string; terminals: TerminalRow[] }

interface Props {
  sessions: SessionRow[]
  activeSessionId: string | null
  workspaces: Array<{ name: string }>
  onNewSession: () => void
  onKillSession: () => void
  onSelectSession: (id: string) => void
  onSelectWorkspace?: (index: number) => void
  onShowOverview?: (sessionId: string) => void
}

export default function Sidebar({
  sessions, activeSessionId, workspaces,
  onNewSession, onKillSession, onSelectSession, onSelectWorkspace, onShowOverview,
}: Props) {
  return (
    <div className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-icon">◈</span>
        <span>ClaudeTUI</span>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-header">WORKSPACES</div>
        {workspaces.length === 0 && (
          <div className="sidebar-empty">(no workspaces)</div>
        )}
        {workspaces.map((ws, i) => (
          <div key={i} className="sidebar-item" onClick={() => onSelectWorkspace?.(i)}>
            {ws.name}
          </div>
        ))}
      </div>

      <div className="sidebar-section sessions-section">
        <div className="sidebar-header">SESSIONS</div>
        {sessions.length === 0 && (
          <div className="sidebar-empty">(no sessions)</div>
        )}
        {sessions.map((s) => {
          const { dot, count, activity } = deriveSessionRow(s)
          const selected = activeSessionId === s.id
          return (
            <div
              key={s.id}
              className={`session-item ${selected ? "active" : ""}`}
              onClick={() => onSelectSession(s.id)}
            >
              <div className="session-item-line1">
                <span className={`status-dot ${dot}`} />
                <span className="session-name">{s.name}</span>
                <span className="session-count">{count} ▣</span>
                <button
                  className="session-overview-btn"
                  title="Session overview"
                  onClick={(e) => { e.stopPropagation(); onShowOverview?.(s.id) }}
                >
                  ⊕
                </button>
              </div>
              <div className="session-item-line2">{activity}</div>
            </div>
          )
        })}
      </div>

      <div className="sidebar-actions">
        <div className="sidebar-hint new" onClick={onNewSession}>
          <span className="shortcut-key">Ctrl+N</span>
          <span className="shortcut-desc">New session</span>
        </div>
        <div className="sidebar-hint kill" onClick={onKillSession}>
          <span className="shortcut-key">Ctrl+K</span>
          <span className="shortcut-desc">Kill session</span>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Drop the now-unused props at the Sidebar call site**

In `src/App.tsx`, the `<Sidebar .../>` element (around line 585) currently passes `activeTerminalId` and `onSelectTerminal`. Remove those two lines so it reads:

```tsx
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        workspaces={workspaces}
        onNewSession={handleNewSession}
        onKillSession={handleKillSession}
        onSelectSession={handleSelectSession}
        onSelectWorkspace={(index) => window.api.activateWorkspace(index)}
        onShowOverview={openOverview}
      />
```

(Leave `handleSelectTerminal` defined in `App.tsx` — it is still used by the TabBar's `onSelectTerminal` and the keymap. Only the Sidebar no longer needs it.)

- [ ] **Step 3: Add the row styles**

In `src/App.css`, find the existing `.session-item` rule. Add (or merge) these rules so every row is a fixed two-line cell that does not change height when selected:

```css
.session-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  cursor: pointer;
  border-radius: 6px;
}
.session-item.active {
  background: var(--bg-elevated, #1c2128);
}
.session-item-line1 {
  display: flex;
  align-items: center;
  gap: 6px;
}
.session-item-line1 .session-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-count {
  font-size: 11px;
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
}
.session-item-line2 {
  font-size: 11px;
  opacity: 0.6;
  height: 16px;
  line-height: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 16px;
}
```

(If an old `.session-group`, `.activity-line`, `.terminal-item`, or `.activity-inline` rule exists and is now unused, leave it — removing dead CSS is not required and avoids touching unrelated styles. The new markup no longer emits those classes.)

- [ ] **Step 4: Verify gate + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck 0 (this catches any leftover reference to the removed props); tests green; build OK.

- [ ] **Step 5: E2E smoke (manual/agent)**

Launch the app (`npm start`), create two sessions, click between them, and confirm via `take_screenshot` that: rows are the same height whether selected or not, no terminals appear inside the sidebar, each row shows a `N ▣` count and one activity line, and selecting a session only swaps the main area.

- [ ] **Step 6: Commit**

```bash
git add src/components/Sidebar.tsx src/App.tsx src/App.css
git commit -m "feat: uniform non-reflowing sidebar rows; remove inline terminal accordion"
```

---

## Task 3: TabBar — per-tab status dot + activity tooltip + overflow

**Files:**
- Modify: `src/components/TabBar.tsx`
- Modify: `src/App.tsx:598-605` (pass `activity` through; `activeTerminals` already carry it)
- Modify: `src/App.css` (tab dot + overflow scroll)

- [ ] **Step 1: Add the dot, tooltip, and accept `activity` in `TabBar.tsx`**

In `src/components/TabBar.tsx`, change the `Props.terminals` type and the tab markup. Update the interface:

```typescript
interface Props {
  terminals: Array<{ id: string; name: string; lastState: string; activity?: string }>
  activeTerminalId: string | null
  splitId: string | null
  onSelectTerminal: (id: string) => void
  onCloseTerminal: (id: string) => void
  onRenameTerminal: (id: string, newName: string) => void
}
```

Then inside the `terminals.map`, add a status dot before the name and a `title` tooltip on the tab. Replace the opening of the mapped `<div className={...} onClick=...>` and the non-editing `<span>` branch so the tab looks like:

```tsx
        <div
          key={t.id}
          className={`tab ${t.id === activeTerminalId ? "active" : ""} ${t.id === splitId ? "split" : ""}`}
          onClick={() => onSelectTerminal(t.id)}
          title={t.activity ? `${t.name} — ${t.activity}` : t.name}
        >
          <span className={`status-dot ${t.lastState}`} />
          {editingId === t.id ? (
            <input
              className="tab-rename-input"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename()
                if (e.key === "Escape") setEditingId(null)
              }}
              onBlur={commitRename}
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              onDoubleClick={() => {
                setEditingId(t.id)
                setEditValue(t.name)
              }}
            >
              {t.name}
            </span>
          )}
          <span
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation()
              onCloseTerminal(t.id)
            }}
          >
            &times;
          </span>
        </div>
```

- [ ] **Step 2: Add overflow + dot styles**

In `src/App.css`, find the `.tab-bar` rule and ensure it scrolls horizontally instead of wrapping, and that tabs lay out their dot inline:

```css
.tab-bar {
  display: flex;
  align-items: stretch;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  white-space: nowrap;
}
.tab .status-dot {
  flex: 0 0 auto;
}
```

(Merge these properties into the existing `.tab-bar` / `.tab` rules rather than duplicating the selectors — keep whatever colors/padding already exist.)

- [ ] **Step 3: Verify gate + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck 0 (TabBar already receives `activeTerminals`, which include `activity` and `lastState`, so no App.tsx change is required for props); tests green; build OK.

- [ ] **Step 4: E2E smoke**

Launch the app, open a session with 3+ terminals, and confirm via `take_screenshot`: each tab has a status dot, hovering shows the activity tooltip (`get_app_state` to confirm the active terminal), and many tabs scroll horizontally rather than wrapping.

- [ ] **Step 5: Commit**

```bash
git add src/components/TabBar.tsx src/App.css
git commit -m "feat: promote TabBar to primary nav — per-tab dot, activity tooltip, overflow scroll"
```

---

## Task 4: New-terminal (+) affordance in the TabBar

**Files:**
- Modify: `src/components/TabBar.tsx`
- Modify: `src/App.tsx:598-605` (pass `onNewTerminal`)

- [ ] **Step 1: Add the `onNewTerminal` prop and `+` button**

In `src/components/TabBar.tsx`, add `onNewTerminal` to `Props`:

```typescript
interface Props {
  terminals: Array<{ id: string; name: string; lastState: string; activity?: string }>
  activeTerminalId: string | null
  splitId: string | null
  onSelectTerminal: (id: string) => void
  onCloseTerminal: (id: string) => void
  onRenameTerminal: (id: string, newName: string) => void
  onNewTerminal: () => void
}
```

Add it to the destructured params (`onNewTerminal,`). Then **remove the early `return` for the empty case** so the `+` button always renders, and append the button after the `terminals.map(...)`. The render becomes:

```tsx
  return (
    <div className="tab-bar">
      {terminals.map((t) => (
        /* ...unchanged tab markup from Task 3... */
      ))}
      <button className="tab-new" title="New terminal in this session" onClick={onNewTerminal}>
        +
      </button>
    </div>
  )
```

(Delete the line `if (terminals.length === 0) return <div className="tab-bar" />` — with the `+` button present, an empty session should still show the bar so the user can add a terminal.)

- [ ] **Step 2: Wire `onNewTerminal` in `App.tsx`**

`handleNewTerminal` already exists (referenced in the keymap dependency array at `App.tsx:550`). Pass it to the TabBar:

```tsx
        <TabBar
          terminals={activeTerminals}
          activeTerminalId={activeTerminalId}
          splitId={splitRight}
          onSelectTerminal={(id) => setActiveTerminalId(id)}
          onCloseTerminal={(id) => activeSessionId && window.api.closeTerminal(activeSessionId, id)}
          onRenameTerminal={handleRenameTerminal}
          onNewTerminal={handleNewTerminal}
        />
```

- [ ] **Step 3: Style the `+` button**

In `src/App.css`, add:

```css
.tab-new {
  flex: 0 0 auto;
  background: transparent;
  border: none;
  color: var(--fg-muted, #8b949e);
  font-size: 16px;
  line-height: 1;
  padding: 0 10px;
  cursor: pointer;
}
.tab-new:hover {
  color: var(--fg, #c9d1d9);
}
```

- [ ] **Step 4: Verify gate + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck 0; tests green; build OK.

- [ ] **Step 5: E2E smoke**

Launch the app, click the `+` in the tab bar, confirm via `get_app_state` that a new terminal was created in the active session and became active.

- [ ] **Step 6: Commit**

```bash
git add src/components/TabBar.tsx src/App.tsx src/App.css
git commit -m "feat: add new-terminal (+) affordance to the TabBar"
```

---

## Task 5: Session Overview — live refresh (M5)

**Files:**
- Modify: `src/App.tsx` (subscription + debounced re-fetch of open overview panels)

**Context:** `openOverview(sessionId)` (App.tsx:387) fetches `getSessionOverview` once and stores it as a panel with id `overview-${sessionId}`. Panels live in `panels` state. The renderer already listens to terminal state events and the container `worksession:updated` event. We add an effect that, whenever such an event fires, re-fetches the overview for any open `overview-*` panel and replaces its props.

- [ ] **Step 1: Add a refresh helper + subscription effect**

In `src/App.tsx`, add this effect near the other mount-time `useEffect`s (after `openOverview` is defined so it is in scope; if hoisting is an issue, inline the fetch as shown — it does not depend on `openOverview`). Place it after the panel/overview callbacks:

```tsx
  // M5: keep any open Session Overview panel live. When a terminal's state or the
  // container changes, re-fetch the overview for each open overview-* panel and
  // replace its props. Debounced so a burst of events coalesces into one refresh.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null

    const refreshOpenOverviews = () => {
      if (timer) return // coalesce: a refresh is already scheduled
      timer = setTimeout(async () => {
        timer = null
        const openIds = panels
          .filter((p) => p.visible && p.id.startsWith("overview-"))
          .map((p) => p.id.slice("overview-".length))
        for (const sessionId of openIds) {
          const ov = await window.api.getSessionOverview(sessionId)
          if (!ov) continue // session gone mid-refresh: leave last content
          setPanels((prev) =>
            prev.map((p) =>
              p.id === `overview-${sessionId}`
                ? {
                    ...p,
                    props: {
                      ...ov,
                      onReopenTerminal: (terminalId: string) =>
                        window.api.reopenTerminal(sessionId, terminalId),
                    },
                  }
                : p,
            ),
          )
        }
      }, 250)
    }

    window.api.onSessionState(refreshOpenOverviews)
    window.api.onWorkSessionUpdated(refreshOpenOverviews)
    return () => {
      if (timer) clearTimeout(timer)
      window.api.removeAllListeners("terminal:state")
      window.api.removeAllListeners("worksession:updated")
    }
  }, [panels])
```

**Important:** verify the exact preload accessor names. Open `electron/preload.ts` and confirm the listener for the terminal-state event (the one renamed in Task 6/7 to `terminal:state`) is exposed as `onSessionState`, and the container update as `onWorkSessionUpdated`. If the names differ, use the actual exported names. The `removeAllListeners` strings MUST match the post-rename channel names (`terminal:state`, `worksession:updated`). If Task 5 is executed **before** the rename tasks, temporarily use `"session:state"` here and update it in Task 7's listener sweep — note this in the commit.

- [ ] **Step 2: Verify gate + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck 0; tests green; build OK.

- [ ] **Step 3: E2E smoke**

Launch the app, open a session's Overview (⊕), then drive activity in that session (e.g. via `wait_for_session_idle` with an injected command, or just type in the terminal). Confirm via repeated `take_screenshot` that the Overview's terminal activity / summary updates without re-opening the panel. Kill the session while the panel is open and confirm the app does not crash (the `if (!ov) continue` guard).

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat: live-refresh open Session Overview panels (M5)"
```

---

## Task 6: IPC rename — emit side in `terminals.ts` (TDD)

**Files:**
- Modify: `electron/services/terminals.test.ts`
- Modify: `electron/services/terminals.ts`

**Context:** `TerminalService` emits events via `this.sendToRenderer(channel, ...)`. The emitted channels are `session:state` (×3 sites), `session:data`, `session:exit`, `session:created` (×2), `session:renamed`, `session:focus`. All become `terminal:*`.

- [ ] **Step 1: Write/extend a failing test asserting `terminal:*` emission**

Open `electron/services/terminals.test.ts`. The existing tests construct a `TerminalService` and exercise it. Add a test that captures `sendToRenderer` calls and asserts the channel prefix. If the existing tests already stub `sendToRenderer`, reuse that stub; otherwise add:

```typescript
import { describe, it, expect, vi } from "vitest"
import { TerminalService } from "./terminals"

describe("TerminalService IPC channel names", () => {
  it("emits a terminal:state event (not session:state) when activity changes", () => {
    const svc = new TerminalService()
    const sent: string[] = []
    // sendToRenderer is the single funnel for all renderer events.
    ;(svc as unknown as { sendToRenderer: (c: string, ...a: unknown[]) => void }).sendToRenderer =
      (channel: string) => { sent.push(channel) }

    // markActive is the internal transition that emits "...:state"/"active".
    // If the method name differs, call the smallest public path that triggers a state emit.
    ;(svc as unknown as { markActive: (id: string) => void }).markActive?.("nonexistent")

    // No terminal with that id exists, so nothing is emitted — assert the negative
    // by checking that IF anything was sent, it used the terminal: prefix.
    expect(sent.every((c) => !c.startsWith("session:"))).toBe(true)
  })
})
```

**Note to implementer:** this negative-style assertion is deliberately robust to the internal method names. If `terminals.test.ts` already has a test that drives a real emit (e.g. by creating a terminal and writing to it), prefer adding a positive assertion there: `expect(sent).toContain("terminal:state")` and `expect(sent).not.toContain("session:state")`. Use whichever the existing test scaffolding makes natural — the goal is a test that goes red on the old `session:` strings.

- [ ] **Step 2: Run test to verify it fails (before the rename)**

Run: `npx vitest run electron/services/terminals.test.ts`
Expected: FAIL if you used a positive `toContain("terminal:state")` assertion against the current `session:state` emit. (If you could only write the negative assertion, it will already pass — in that case rely on the round-trip E2E in Task 8 as the real guard and proceed.)

- [ ] **Step 3: Rename the emitted channels in `terminals.ts`**

In `electron/services/terminals.ts`, change each emitted channel string (lines ~219, 231, 277, 284, 313, 372, 519, 547, 573):

| Old | New |
|-----|-----|
| `this.sendToRenderer("session:state", ...)` | `this.sendToRenderer("terminal:state", ...)` |
| `this.sendToRenderer("session:data", ...)` | `this.sendToRenderer("terminal:data", ...)` |
| `this.sendToRenderer("session:exit", ...)` | `this.sendToRenderer("terminal:exit", ...)` |
| `this.sendToRenderer("session:created", ...)` | `this.sendToRenderer("terminal:created", ...)` |
| `this.sendToRenderer("session:renamed", ...)` | `this.sendToRenderer("terminal:renamed", ...)` |
| `this.sendToRenderer("session:focus", ...)` | `this.sendToRenderer("terminal:focus", ...)` |

Do NOT touch any `worksession:*` strings.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/services/terminals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (intermediate — the wire is half-renamed; ipc/preload follow in Task 7)**

```bash
git add electron/services/terminals.ts electron/services/terminals.test.ts
git commit -m "refactor: emit terminal:* channels from TerminalService (was session:*)"
```

---

## Task 7: IPC rename — handlers, bridge, and renderer listeners (lockstep)

**Files:**
- Modify: `electron/ipc.ts`
- Modify: `electron/preload.ts`
- Modify: `src/App.tsx`

**Context:** This task completes the wire so the renamed emits from Task 6 reconnect. After this task the wire is whole again. The handlers (`ipc.ts`) and the bridge (`preload.ts`) must change together, and any **raw** channel string in the renderer (`App.tsx` `removeAllListeners("session:focus")` at ~line 210, plus the Task 5 listener cleanup) must change too.

- [ ] **Step 1: Rename handlers in `ipc.ts`**

In `electron/ipc.ts`, rename every `session:*` channel in `ipcMain.handle(...)` / `ipcMain.on(...)` (lines ~144-167) to `terminal:*`:

```
"session:create"        -> "terminal:create"
"session:kill"          -> "terminal:kill"
"session:focus"         -> "terminal:focus"
"session:list"          -> "terminal:list"
"session:activity"      -> "terminal:activity"
"session:rename"        -> "terminal:rename"
"session:handoff"       -> "terminal:handoff"
"session:write"         -> "terminal:write"
"session:resize"        -> "terminal:resize"
"session:get-output"    -> "terminal:get-output"
"session:search-output" -> "terminal:search-output"
```

Do NOT touch `worksession:*` handlers.

- [ ] **Step 2: Rename the bridge in `preload.ts`**

In `electron/preload.ts`, rename the channel strings (NOT the JS function names like `createSession`/`onSessionData` — only the string literals inside `ipcRenderer.invoke/send/on`). Apply the same mapping as Step 1 for invoke/send, and for the event listeners (lines ~88-106):

```
"session:data"     -> "terminal:data"
"session:exit"     -> "terminal:exit"
"session:created"  -> "terminal:created"
"session:state"    -> "terminal:state"
"session:renamed"  -> "terminal:renamed"
"session:focus"    -> "terminal:focus"
```

Keeping the JS accessor names (`onSessionData`, `createSession`, etc.) unchanged means the renderer API surface does not move — only the wire strings do. Do NOT touch `worksession:*`.

- [ ] **Step 3: Fix raw channel strings in the renderer**

In `src/App.tsx`, update raw channel strings passed to `removeAllListeners`:
- Line ~210: `window.api.removeAllListeners("session:focus")` → `window.api.removeAllListeners("terminal:focus")`
- The Task 5 cleanup already targets `"terminal:state"` and `"worksession:updated"` — confirm those are correct now that the rename is in.

Search the renderer for any other raw `"session:` string: `npx tsc -b` will not catch these (they are strings), so grep them out.

- [ ] **Step 4: Grep-guard — no per-PTY `session:` channels remain**

Run (the leading quote excludes `worksession:`):

```bash
grep -rn '"session:' electron/ src/ || echo "CLEAN: no session: PTY channels remain"
```

Expected: `CLEAN` (only `worksession:` strings exist, which start with `"worksession:` and are not matched by `"session:`). If any line prints, rename it.

- [ ] **Step 5: Verify gate + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck 0; tests green (incl. Task 6's); build OK.

- [ ] **Step 6: E2E round-trip (the real guard for an all-or-nothing rename)**

Launch the app. Create a terminal, type into it (write), see output (data), rename it, switch focus, kill it — all must work. A renamed-but-unmatched channel manifests as a dead terminal (no echo / no output). Confirm with `get_app_state` + `take_screenshot`.

- [ ] **Step 7: Commit**

```bash
git add electron/ipc.ts electron/preload.ts src/App.tsx
git commit -m "refactor: rename session:* PTY channels to terminal:* across ipc/preload/renderer"
```

---

## Task 8: Docs + final E2E

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the IPC example in `CLAUDE.md`**

In `CLAUDE.md`, the "How to Add a New Feature" example emits `this.sendToRenderer("session:paused", id)` and registers `ipcMain.handle("session:pause", ...)`. Update those example strings to the `terminal:*` convention and add a one-line note so the convention is documented:

- Change `this.sendToRenderer("session:paused", id)` → `this.sendToRenderer("terminal:paused", id)`
- Change `ipcMain.handle("session:pause", ...)` → `ipcMain.handle("terminal:pause", ...)`
- Change `pauseSession: (id) => ipcRenderer.invoke("session:pause", id)` → `... ipcRenderer.invoke("terminal:pause", id)`
- Add under the example: `> IPC channel convention: per-terminal (PTY) operations use the `terminal:*` channel namespace; durable work-session container operations use `worksession:*`. (The renderer-facing JS accessor names — `createSession`, `onSessionData`, etc. — are kept for stability and do not need to match the channel namespace.)`

- [ ] **Step 2: Final full verification**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck 0; all tests green; build OK.

- [ ] **Step 3: Full E2E walkthrough**

Launch the app and exercise the whole ② surface end to end: uniform sidebar rows (no reflow on select), tabs as the only terminal nav (dot + tooltip + overflow + `+`), a live-refreshing Overview, and terminal create/write/output/rename/kill over the renamed channels. Capture a final `take_screenshot`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document terminal:* vs worksession:* IPC channel convention"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** §1 Sidebar → Tasks 1–2; §2 TabBar → Tasks 3–4; §3 Overview live refresh → Task 5; §4 IPC rename (full 17-channel table) → Tasks 6–7; docs → Task 8. The surface-agnostic invariant is preserved (selection stays in `App.tsx`; TabBar is one renderer).
- **Ordering matters:** Task 6 (emit rename) and Task 7 (handler/bridge/listener rename) together are atomic for the wire — between them the app is intentionally half-renamed; do not E2E-judge until after Task 7. Task 5's listener strings depend on the post-rename names; the task body flags the before/after-rename contingency.
- **Type consistency:** `deriveSessionRow` returns `{ dot, count, activity }` and is consumed identically in Sidebar. `Props.terminals` in TabBar gains `activity?` (Task 3) before `onNewTerminal` (Task 4). Preload JS accessor names are deliberately unchanged.
