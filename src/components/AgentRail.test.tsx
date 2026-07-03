import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import AgentRail from "./AgentRail"
import type { ActionButtonView } from "../lib/actionButtonRow"

/**
 * CAPP-104 (AB-1) — the Agent Rail BUTTONS group. `renderToStaticMarkup` is the
 * established node-test render path here (no jsdom); effects don't run under SSR, so the
 * INITIAL render is asserted — which is exactly the "visible at rest, no hover-reveal"
 * property under test: every button label + its ✕ must be in the static markup, and the
 * two-step "Confirm?" state must NOT be (it appears only after a click).
 */

const baseProps = {
  open: true,
  onToggle: () => {},
  hasTerminal: true,
  terminalId: "t1",
  busy: false,
  blocks: [],
}

const buttons: ActionButtonView[] = [
  { id: "b1", label: "Run e2e suite", prompt: "npm run e2e", scope: "session", ownerId: "s1" },
  { id: "b2", label: "Redeploy", prompt: "deploy", scope: "workspace", ownerId: "ws-A", confirm: true },
]

describe("AgentRail — BUTTONS group (visible at rest, no hover-reveal)", () => {
  it("renders the BUTTONS label + every button label statically", () => {
    const html = renderToStaticMarkup(<AgentRail {...baseProps} actionButtons={buttons} />)
    expect(html).toContain("agent-rail-buttons")
    expect(html).toContain(">BUTTONS<")
    expect(html).toContain("Run e2e suite")
    expect(html).toContain("Redeploy")
  })

  it("renders a remove ✕ for every button", () => {
    const html = renderToStaticMarkup(<AgentRail {...baseProps} actionButtons={buttons} />)
    const removeCount = (html.match(/agent-rail-button-remove/g) ?? []).length
    expect(removeCount).toBe(buttons.length)
  })

  it("does NOT show the two-step 'Confirm?' state at rest", () => {
    const html = renderToStaticMarkup(<AgentRail {...baseProps} actionButtons={buttons} />)
    expect(html).not.toContain("Confirm?")
    // No button is armed at rest.
    expect(html).not.toContain("agent-rail-button armed")
  })

  it("omits the BUTTONS group entirely when there are no buttons", () => {
    const html = renderToStaticMarkup(<AgentRail {...baseProps} actionButtons={[]} />)
    expect(html).not.toContain("agent-rail-buttons")
    // With nothing else present, the calm empty state shows instead.
    expect(html).toContain("All quiet")
  })
})
