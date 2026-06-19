import React from "react"
import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import AgentComposer from "./AgentComposer"

/**
 * BO-10 — the composer must be HONEST about a busy agent. While the structured
 * terminal is generating or parked on a permission prompt, Send is disabled (a
 * message written into the blocked stdin would silently buffer unread and falsely
 * read as "sent" — the dogfooding bug) and a Stop button surfaces. These render the
 * real component to static HTML (node-only, no DOM/RTL — effects, hence the slash
 * picker's window.api calls, never run during SSR).
 */
describe("AgentComposer — BO-10 busy/Stop gating", () => {
  it("idle: a Send button, NO Stop button", () => {
    const html = renderToStaticMarkup(<AgentComposer terminalId="t1" busy={false} />)
    expect(html).toContain("composer-send")
    expect(html).not.toContain("composer-stop")
  })

  it("busy: a Stop button and a DISABLED Send", () => {
    const html = renderToStaticMarkup(<AgentComposer terminalId="t1" busy />)
    // The visible handbrake.
    expect(html).toContain("composer-stop")
    expect(html).toContain(">Stop<")
    // Send is present but disabled — never a silent write into a blocked pipe.
    expect(html).toMatch(/class="composer-send"[^>]*disabled/)
  })
})

/**
 * WS3 — the persistent hint strip. Idle shows the real affordances as PLAIN, quiet
 * muted text (the owner removed the keycap/kbd chips — keys read as inline text, not
 * boxed caps); busy shows the working/interrupt line.
 */
describe("AgentComposer — WS3 persistent hint strip", () => {
  it("renders the hint strip in BOTH states (persistent, not busy-only)", () => {
    const idle = renderToStaticMarkup(<AgentComposer terminalId="t1" busy={false} />)
    const busy = renderToStaticMarkup(<AgentComposer terminalId="t1" busy />)
    expect(idle).toContain("composer-hint")
    expect(busy).toContain("composer-hint")
  })

  it("idle: shows the shortcuts as PLAIN text (send / newline / commands / attach), NO keycap chips", () => {
    const html = renderToStaticMarkup(<AgentComposer terminalId="t1" busy={false} />)
    expect(html).toContain("composer-hint-keys")
    // Plain inline text, not boxed <kbd> keycaps.
    expect(html).not.toContain("<kbd>")
    expect(html).toMatch(/send/i)
    expect(html).toMatch(/newline/i)
    expect(html).toMatch(/commands/i)
    expect(html).toMatch(/drop an image to attach/i)
    // NOT the busy copy when idle.
    expect(html).not.toMatch(/interrupt/i)
  })

  it("busy: shows the working/interrupt line, NOT the idle chips", () => {
    const html = renderToStaticMarkup(<AgentComposer terminalId="t1" busy />)
    expect(html).toContain("composer-hint busy")
    expect(html).toContain("composer-hint-busy")
    expect(html).toMatch(/Agent is working/i)
    expect(html).toMatch(/Esc or Stop to interrupt/i)
    expect(html).not.toContain("composer-hint-keys")
  })
})
