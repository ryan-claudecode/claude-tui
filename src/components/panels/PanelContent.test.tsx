import { describe, it, expect, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import PanelContent, { tabLabel, PANEL_LABELS } from "./PanelContent"
import type { PanelApi } from "../../lib/panelApi"
import type { PanelLike } from "./PanelContent"

/**
 * CAPP-106 / S1 — render-with-mock-`api` coverage for the shared PanelContent switch.
 *
 * `renderToStaticMarkup` is the established node-test render path here (see
 * MarkdownView.test.tsx) — the suite runs under the `node` vitest environment with no
 * jsdom. We render each behavior panel through the switch with a fully-stubbed `PanelApi`
 * and assert (a) it renders without throwing, (b) the right per-panel callbacks are wired
 * off `api`, and (c) RecallPanel's empty-`api` NEGATIVE CONTROL degrades to a disabled box.
 */

/** A complete, inert PanelApi — every method a no-op / resolved-empty so a static render
 *  can't throw. Individual tests override the slice they're asserting. */
function mockApi(overrides: Partial<PanelApi> = {}): PanelApi {
  return {
    sendToSession: vi.fn(() => true),
    missionStop: vi.fn(),
    missionPause: vi.fn(),
    scheduleRunNow: vi.fn(),
    scheduleSetEnabled: vi.fn(),
    scheduleDelete: vi.fn(),
    scheduleEdit: vi.fn(),
    approveWorktreeTask: vi.fn(async () => null),
    rejectWorktreeTask: vi.fn(async () => null),
    recall: vi.fn(async () => []),
    openSessionOverview: vi.fn(async () => undefined),
    promoteSessionToWorkspace: vi.fn(async () => ({ ok: true, count: 0, workspaceId: null })),
    getWorkspaceMemory: vi.fn(async () => ({
      workspaceId: "w1", instructions: "", findings: [], createdAt: 0, updatedAt: 0,
    })),
    setWorkspaceInstructions: vi.fn(async () => ({
      workspaceId: "w1", instructions: "", findings: [], createdAt: 0, updatedAt: 0,
    })),
    addWorkspaceFinding: vi.fn(async () => ({
      id: "f1", text: "x", source: "user" as const, status: "active" as const, createdAt: 0, promotedAt: 0,
    })),
    editWorkspaceFinding: vi.fn(async () => true),
    deleteWorkspaceFinding: vi.fn(async () => true),
    setWorkspaceFindingPinned: vi.fn(async () => true),
    onWorkspaceMemoryChanged: vi.fn(() => () => {}),
    getExportState: vi.fn(async () => ({
      workspaceId: "w1", mode: null, path: null, enabled: false, importLine: null, folderless: false,
    })),
    enableExport: vi.fn(async () => ({ ok: true })),
    disableExport: vi.fn(async () => ({
      workspaceId: "w1", mode: null, path: null, enabled: false, importLine: null, folderless: false,
    })),
    setUntaggedExportEnabled: vi.fn(async () => ({
      workspaceId: "w1", mode: null, path: null, enabled: false, importLine: null, folderless: false,
    })),
    regenerateExport: vi.fn(async () => ({ ok: true })),
    getAdoptionState: vi.fn(async () => ({
      adopted: false, hostFile: null, canWire: false, selfWired: false, importLine: null,
    })),
    wireImportBlock: vi.fn(async () => ({ ok: true, status: "wired" as const })),
    unwireImportBlock: vi.fn(async () => ({ ok: true, status: "removed" as const })),
    setExportSelfWired: vi.fn(async () => ({
      workspaceId: "w1", mode: null, path: null, enabled: false, importLine: null, folderless: false,
    })),
    inspectWorkspaceContext: vi.fn(async () => ({
      folder: "/x", gitRoot: "/x", adopted: false, sources: [],
    })),
    ...overrides,
  }
}

const panel = (type: string, props: Record<string, any> = {}): PanelLike => ({
  id: "panel-1", type, props,
})

describe("PanelContent — tabLabel / PANEL_LABELS (extracted)", () => {
  it("maps each panel type to a generic label", () => {
    expect(PANEL_LABELS["diff"]).toBe("Diff")
    expect(PANEL_LABELS["workspace-memory"]).toBe("Memory")
    expect(PANEL_LABELS["context-inspector"]).toBe("Context")
  })

  it("specializes the label by props (overview→name, review→title, memory/context→workspace)", () => {
    expect(tabLabel(panel("session-overview", { name: "Refactor" }))).toBe("Refactor")
    expect(tabLabel(panel("worktree-review", { title: "Task 3" }))).toBe("Review: Task 3")
    expect(tabLabel(panel("workspace-memory", { workspaceName: "App" }))).toBe("Memory: App")
    expect(tabLabel(panel("context-inspector", { workspaceName: "App" }))).toBe("Context: App")
  })

  it("falls back to the generic label when the specializing prop is absent", () => {
    expect(tabLabel(panel("session-overview", {}))).toBe("Overview")
    expect(tabLabel(panel("mission", {}))).toBe("Mission")
    expect(tabLabel(panel("totally-unknown", {}))).toBe("totally-unknown")
  })
})

describe("PanelContent — renders behavior panels with a mock api", () => {
  it("renders the diff panel (and wires onSend = api.sendToSession)", () => {
    const api = mockApi()
    const html = renderToStaticMarkup(
      <PanelContent
        panel={panel("diff", { files: [{ path: "a.ts", oldContent: "x", newContent: "y" }] })}
        api={api}
      />,
    )
    expect(html).toContain("diff-panel")
    expect(html).toContain("a.ts")
  })

  it("renders the mission panel with Stop/Pause controls", () => {
    const html = renderToStaticMarkup(
      <PanelContent panel={panel("mission", { id: "m1", goal: "Ship it", tasks: [] })} api={mockApi()} />,
    )
    expect(html).toContain("mission-panel")
    expect(html).toContain("Ship it")
    expect(html).toContain("Stop")
    expect(html).toContain("Pause")
  })

  it("renders the worktree-review panel (approve/reject wired)", () => {
    const html = renderToStaticMarkup(
      <PanelContent
        panel={panel("worktree-review", { missionId: "m1", taskId: "t1", title: "T1", status: "awaiting-review" })}
        api={mockApi()}
      />,
    )
    expect(html).toContain("worktree-review-panel")
    expect(html).toContain("Approve &amp; merge")
    expect(html).toContain("Reject")
  })

  it("renders the session-overview panel with the push button", () => {
    const html = renderToStaticMarkup(
      <PanelContent
        panel={panel("session-overview", {
          id: "s1", name: "Sess", status: "active", summary: "", notes: [], ruledOut: [],
          provisionalFindings: [], terminals: [],
        })}
        api={mockApi()}
      />,
    )
    expect(html).toContain("overview-panel")
    expect(html).toContain("Push context to workspace")
  })

  it("renders the workspace-memory editor", () => {
    const html = renderToStaticMarkup(
      <PanelContent
        panel={panel("workspace-memory", { workspaceId: "w1", workspaceName: "App", instructions: "", findings: [] })}
        api={mockApi()}
      />,
    )
    expect(html).toContain("workspace-memory-panel")
    expect(html).toContain("Memory — App")
  })

  it("renders the context-inspector with a Refresh button", () => {
    const html = renderToStaticMarkup(
      <PanelContent
        panel={panel("context-inspector", {
          workspaceId: "w1",
          result: { folder: "/x", gitRoot: "/x", adopted: false, sources: [] },
        })}
        api={mockApi()}
      />,
    )
    expect(html).toContain("context-inspector-panel")
    expect(html).toContain("Refresh")
  })

  it("renders the schedule detail panel with the action buttons + run history", () => {
    const html = renderToStaticMarkup(
      <PanelContent
        panel={panel("schedule", {
          id: "sch-1",
          name: "Fable watch",
          recurrence: { kind: "interval", everyMinutes: 20, window: { start: "08:00", end: "22:00" } },
          enabled: true,
          nextRunAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          runHistory: [{ at: new Date().toISOString(), status: "ok", durationMs: 3200, note: "found a hit" }],
        })}
        api={mockApi()}
      />,
    )
    expect(html).toContain("schedule-panel")
    expect(html).toContain("Fable watch")
    // Statically-visible TEXT buttons (words over icons).
    expect(html).toContain(">Edit<")
    expect(html).toContain(">Disable<")
    expect(html).toContain(">Run now<")
    expect(html).toContain(">Delete<")
    // Run history row rendered with its note.
    expect(html).toContain("found a hit")
    expect(html).toContain("Run history (1)")
  })

  it("renders a simple data panel (markdown) that ignores api", () => {
    const html = renderToStaticMarkup(
      <PanelContent panel={panel("markdown", { content: "# Hi" })} api={mockApi()} />,
    )
    expect(html).toContain("Hi")
  })

  it("falls back to a raw <pre> for an unknown type", () => {
    const html = renderToStaticMarkup(
      <PanelContent panel={panel("totally-unknown", { a: 1 })} api={mockApi()} />,
    )
    expect(html).toContain("panel-raw")
    expect(html).toContain("&quot;a&quot;: 1")
  })
})

describe("PanelContent — RecallPanel renders results from a mock api", () => {
  it("renders the recall search UI with a working api (search box + filter pills)", () => {
    const api = mockApi({ recall: vi.fn(async () => []) })
    const html = renderToStaticMarkup(
      <PanelContent panel={panel("recall", { query: "" })} api={api} />,
    )
    expect(html).toContain("recall-panel")
    expect(html).toContain("recall-search")
    // The always-visible status/scope filter pills (no hover-reveal).
    expect(html).toContain("recall-pill")
  })

  it("NEGATIVE CONTROL (A.4): an empty api still renders the box — never throws", () => {
    // The whole point of A.4: RecallPanel's guard degrades to a blank/disabled box rather
    // than crashing when no bridge is supplied. Rendering with api=undefined must succeed.
    const render = () =>
      renderToStaticMarkup(<PanelContent panel={panel("recall", { query: "" })} api={undefined} />)
    expect(render).not.toThrow()
    const html = render()
    expect(html).toContain("recall-panel")
    // The prompt copy for the initial (no-query / degraded) state is present.
    expect(html).toContain("Type to search")
  })
})
