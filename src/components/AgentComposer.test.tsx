import React from "react"
import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import AgentComposer, {
  dictationProgressLabel,
  dictationProgressPct,
  composerSubmitDisabled,
} from "./AgentComposer"
import QueuedMessages, { queuedChipPreview } from "./QueuedMessages"
import type { QueuedAgentInput } from "../../electron/services/streamProtocol"

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

/**
 * CAPP-120 (STT-1) — the push-to-talk mic affordance. It must be STATICALLY VISIBLE in
 * the composer controls row (no hover-reveal): the button is in the initial static markup,
 * so it is always rendered, not gated behind a hover state.
 */
describe("AgentComposer — CAPP-120 dictation mic", () => {
  it("renders a statically-visible mic button in the controls row", () => {
    const html = renderToStaticMarkup(<AgentComposer terminalId="t1" busy={false} />)
    // The button is present unconditionally (no hover-reveal wrapper hides it).
    expect(html).toContain("composer-mic-wrap")
    expect(html).toContain("composer-mic")
    // Idle state shows the mic glyph and an explicit label.
    expect(html).toContain("🎤")
    expect(html).toMatch(/aria-label="[^"]*(Dictate|Set up voice dictation)/i)
  })

  it("does not open the download overlay until the mic is pressed", () => {
    const html = renderToStaticMarkup(<AgentComposer terminalId="t1" busy={false} />)
    expect(html).not.toContain("composer-mic-download")
  })
})

describe("AgentComposer — dictation progress helpers", () => {
  it("labels each acquisition phase", () => {
    expect(dictationProgressLabel(null)).toMatch(/Preparing/)
    // CAPP-124 — when the total is known the download label leads with the percent.
    const dl = dictationProgressLabel({ phase: "downloading", receivedBytes: 340_000_000, totalBytes: 680_000_000 })
    expect(dl).toMatch(/Downloading.*324.*648.*MB/)
    expect(dl).toMatch(/50%/)
    expect(dictationProgressLabel({ phase: "downloading", receivedBytes: 1_000_000 })).toMatch(/Downloading/)
    expect(dictationProgressLabel({ phase: "extracting" })).toBe("Extracting…")
    expect(dictationProgressLabel({ phase: "verifying" })).toBe("Verifying…")
  })

  it("computes a bounded percent (0 when total unknown)", () => {
    expect(dictationProgressPct({ phase: "downloading", receivedBytes: 340, totalBytes: 680 })).toBe(50)
    expect(dictationProgressPct({ phase: "downloading", receivedBytes: 100 })).toBe(0)
    expect(dictationProgressPct({ phase: "extracting" })).toBe(0)
    expect(dictationProgressPct(null)).toBe(0)
  })
})

/**
 * CAPP-130 — queued messages. Sending while the agent is busy ENQUEUES instead of
 * being disabled: the primary button reads "Queue" (explicit label, not a tooltip),
 * stays ENABLED whenever there's content (attachment-only queuing works like an
 * attachment-only send), and a visible removable chip row lists the queue FIFO.
 */
describe("AgentComposer — CAPP-130 queue-while-busy button", () => {
  it("idle: the primary button reads 'Send'", () => {
    const html = renderToStaticMarkup(<AgentComposer terminalId="t1" busy={false} />)
    expect(html).toMatch(/class="composer-send"[^>]*>Send</)
  })

  it("busy: the primary button reads 'Queue' (explicit label change, not disabled)", () => {
    const html = renderToStaticMarkup(<AgentComposer terminalId="t1" busy />)
    // Explicit "Queue" label while busy — send-while-busy enqueues, never a dead button.
    expect(html).toMatch(/class="composer-send"[^>]*>Queue</)
    // Stop remains a separate, unchanged button.
    expect(html).toContain("composer-stop")
  })
})

describe("composerSubmitDisabled — enablement (attachment-only parity)", () => {
  it("disabled only when there is NO text AND NO attachment", () => {
    expect(composerSubmitDisabled("", [])).toBe(true)
    expect(composerSubmitDisabled("   ", [])).toBe(true)
    expect(composerSubmitDisabled("hi", [])).toBe(false)
    // Attachment-only is legal (parity with attachment-only sends).
    expect(composerSubmitDisabled("", ["/tmp/a.png"])).toBe(false)
  })
})

describe("queuedChipPreview — chip projection", () => {
  it("truncates long text and collapses whitespace", () => {
    const long = "a".repeat(80)
    const { text } = queuedChipPreview({ id: "q1", text: long, queuedAt: 0 })
    expect(text.length).toBeLessThanOrEqual(48)
    expect(text.endsWith("…")).toBe(true)
    expect(queuedChipPreview({ id: "q2", text: "line\n\n  two", queuedAt: 0 }).text).toBe("line two")
  })

  it("an attachment-only item previews its attachment count, never blank", () => {
    const { text, attachCount } = queuedChipPreview({ id: "q3", attachments: ["a.png", "b.png"], queuedAt: 0 })
    expect(attachCount).toBe(2)
    expect(text).toMatch(/2 attachments/)
  })
})

describe("QueuedMessages — chip row", () => {
  const q = (id: string, text?: string, attachments?: string[]): QueuedAgentInput => ({
    id,
    text,
    attachments,
    queuedAt: 0,
  })

  it("renders nothing when the queue is empty", () => {
    expect(renderToStaticMarkup(<QueuedMessages queue={[]} onRemove={() => {}} />)).toBe("")
  })

  it("renders chips FIFO, each with a ✕ remove button + a 📎N badge when attachments ride along", () => {
    const html = renderToStaticMarkup(
      <QueuedMessages
        queue={[q("q1", "alpha"), q("q2", "beta", ["x.png"]), q("q3", "gamma")]}
        onRemove={() => {}}
      />,
    )
    // FIFO order preserved.
    expect(html.indexOf("alpha")).toBeLessThan(html.indexOf("beta"))
    expect(html.indexOf("beta")).toBeLessThan(html.indexOf("gamma"))
    // One always-visible remove control per chip (no hover-reveal).
    const removeButtons = html.match(/aria-label="Remove queued message"/g) ?? []
    expect(removeButtons).toHaveLength(3)
    // The attachment marker rides along on the item that has one.
    expect(html).toMatch(/📎1/)
  })
})
