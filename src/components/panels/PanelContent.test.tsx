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
 * and assert (a) it renders without throwing and (b) the right per-panel callbacks are
 * wired off `api`.
 */

/** A complete, inert PanelApi — every method a no-op / resolved-empty so a static render
 *  can't throw. Individual tests override the slice they're asserting. */
function mockApi(overrides: Partial<PanelApi> = {}): PanelApi {
  return {
    sendToSession: vi.fn(() => true),
    scheduleRunNow: vi.fn(),
    scheduleSetEnabled: vi.fn(),
    scheduleDelete: vi.fn(),
    scheduleEdit: vi.fn(),
    hidePanel: vi.fn(),
    openSessionOverview: vi.fn(async () => undefined),
    inspectWorkspaceContext: vi.fn(async () => ({
      folder: "/x", gitRoot: "/x", sources: [],
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
    expect(PANEL_LABELS["context-inspector"]).toBe("Context")
    expect(PANEL_LABELS["session-overview"]).toBe("Overview")
  })

  it("specializes the label by props (overview→name, context→workspace)", () => {
    expect(tabLabel(panel("session-overview", { name: "Refactor" }))).toBe("Refactor")
    expect(tabLabel(panel("context-inspector", { workspaceName: "App" }))).toBe("Context: App")
  })

  it("falls back to the generic label when the specializing prop is absent", () => {
    expect(tabLabel(panel("session-overview", {}))).toBe("Overview")
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

  it("renders the session-overview panel (terminals roster)", () => {
    const html = renderToStaticMarkup(
      <PanelContent
        panel={panel("session-overview", {
          id: "s1", name: "Sess", status: "active", terminals: [],
        })}
        api={mockApi()}
      />,
    )
    expect(html).toContain("overview-panel")
    expect(html).toContain("Terminals")
  })

  it("renders the context-inspector with a Refresh button", () => {
    const html = renderToStaticMarkup(
      <PanelContent
        panel={panel("context-inspector", {
          workspaceId: "w1",
          result: { folder: "/x", gitRoot: "/x", sources: [] },
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
