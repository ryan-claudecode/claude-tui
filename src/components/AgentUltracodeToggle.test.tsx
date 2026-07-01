import React from "react"
import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import AgentUltracodeToggle from "./AgentUltracodeToggle"

/**
 * CAPP-117 — the ultracode toggle's VISIBILITY GATE. Renders the real component to
 * static HTML (node-only, no DOM/RTL — same pattern as AgentComposer.test.tsx; the
 * onToggle handler's window.api call never runs during SSR).
 *
 * The load-bearing rule: the effort gate only suppresses OFFERING ultracode — it must
 * NEVER hide an ACTIVE one. CAPP-108 deliberately preserves `ref.effort` while
 * ultracode is ON (the spawn suppresses it; it's restored on toggle-off), so a
 * persisted `ultracode:true` + `effort:"high"` ref is a real on-disk state. Hiding
 * the toggle there would strand ultracode active with no control to see it or turn
 * it off (the invisible-active-state trap).
 */
describe("AgentUltracodeToggle — CAPP-117 visibility gate", () => {
  const base = { sessionId: "s1", terminalId: "t1", model: "opus" }

  it("non-xhigh effort + ultracode ON → RENDERS, showing On (never an invisible active state)", () => {
    const html = renderToStaticMarkup(
      <AgentUltracodeToggle {...base} effort="high" ultracode={true} />,
    )
    expect(html).toContain("agent-ultracode-toggle")
    expect(html).toContain(">On<")
    expect(html).toMatch(/aria-checked="true"/)
  })

  it("non-xhigh effort + ultracode OFF → hidden (don't OFFER a mode that would fight the picked effort)", () => {
    const html = renderToStaticMarkup(
      <AgentUltracodeToggle {...base} effort="high" ultracode={false} />,
    )
    expect(html).toBe("")
  })

  it("effort `xhigh` → visible in both states (xhigh is what ultracode forces anyway)", () => {
    const off = renderToStaticMarkup(
      <AgentUltracodeToggle {...base} effort="xhigh" ultracode={false} />,
    )
    const on = renderToStaticMarkup(
      <AgentUltracodeToggle {...base} effort="xhigh" ultracode={true} />,
    )
    expect(off).toContain("agent-ultracode-toggle")
    expect(off).toContain(">Off<")
    expect(on).toContain("agent-ultracode-toggle")
    expect(on).toContain(">On<")
  })

  it("no effort (undefined) → visible in both states (unchanged pre-CAPP-117 behavior)", () => {
    const off = renderToStaticMarkup(<AgentUltracodeToggle {...base} ultracode={false} />)
    const on = renderToStaticMarkup(<AgentUltracodeToggle {...base} ultracode={true} />)
    expect(off).toContain("agent-ultracode-toggle")
    expect(off).toContain(">Off<")
    expect(on).toContain("agent-ultracode-toggle")
    expect(on).toContain(">On<")
  })

  it("non-xhigh MODEL → hidden regardless of ultracode (no exception: setTerminalModel forces ultracode off on the switch)", () => {
    const off = renderToStaticMarkup(
      <AgentUltracodeToggle {...base} model="sonnet" ultracode={false} />,
    )
    const on = renderToStaticMarkup(
      <AgentUltracodeToggle {...base} model="sonnet" ultracode={true} />,
    )
    expect(off).toBe("")
    expect(on).toBe("")
  })

  it("the switch is a statically visible control (role=switch button — no hover-reveal)", () => {
    const html = renderToStaticMarkup(<AgentUltracodeToggle {...base} ultracode={true} />)
    expect(html).toMatch(/role="switch"/)
    expect(html).toContain("agent-ultracode-toggle-switch")
  })
})
