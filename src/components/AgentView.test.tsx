import React from "react"
import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { BlockView } from "./AgentView"
import type {
  AssistantTextBlock,
  ResultBlock,
  UserBlock,
} from "../lib/agentTranscript"

/**
 * BO-8 — the structured chat must render assistant + result PROSE as markdown
 * (matching the companion MarkdownPanel), not as raw text. These tests render the
 * real AgentView block renderer to static HTML (node-only, no DOM/RTL needed) and
 * assert the markdown actually became formatted markup — the regression that left
 * literal backticks/`#`/`-` on screen.
 */

// A reply exercising every feature the acceptance calls out.
const RICH = [
  "# Heading",
  "",
  "Some **bold** text and `inline` code.",
  "",
  "- one",
  "- two",
  "",
  "```js",
  "const x = 1",
  "```",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "[a link](https://example.com)",
].join("\n")

function renderAssistant(text: string): string {
  const block: AssistantTextBlock = { kind: "assistant", id: "b0", text }
  return renderToStaticMarkup(
    <BlockView block={block} onExpand={() => {}} terminalId="t1" sessionId={null} />,
  )
}

describe("AgentView markdown rendering", () => {
  it("renders an assistant block's prose as formatted markdown", () => {
    const html = renderAssistant(RICH)
    // Still the assistant block wrapper (click-to-expand affordance preserved).
    expect(html).toContain("agent-assistant")
    // Fenced code block -> <pre><code>.
    expect(html).toMatch(/<pre[\s>]/)
    expect(html).toContain("<code")
    // **bold** -> <strong>.
    expect(html).toContain("<strong>bold</strong>")
    // Heading, list, table, link, inline code all become real markup.
    expect(html).toMatch(/<h1[\s>]/)
    expect(html).toMatch(/<ul[\s>]/)
    expect(html).toMatch(/<li[\s>]/)
    expect(html).toMatch(/<table[\s>]/)
    expect(html).toContain('href="https://example.com"')
    // NOT the raw source any longer.
    expect(html).not.toContain("# Heading")
    expect(html).not.toContain("```js")
  })

  it("renders a result block's final text as markdown", () => {
    const block: ResultBlock = { kind: "result", id: "b1", isError: false, text: "**done**" }
    const html = renderToStaticMarkup(
      <BlockView block={block} onExpand={() => {}} terminalId="t1" sessionId={null} />,
    )
    expect(html).toContain("agent-result-text")
    expect(html).toContain("<strong>done</strong>")
  })

  it("escapes raw HTML in agent prose (no rehype-raw)", () => {
    const html = renderAssistant("<script>alert(1)</script> and <b>x</b>")
    // The dangerous tags must be escaped to text, never emitted as live markup.
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<b>x</b>")
    expect(html).toContain("&lt;script&gt;")
  })

  it("does not throw on partial markdown mid-stream (unclosed code fence)", () => {
    expect(() => renderAssistant("```js\nconst x = 1")).not.toThrow()
    expect(() => renderAssistant("a **bold")).not.toThrow()
    expect(() => renderAssistant("| a | b |\n| - | - |\n| 1")).not.toThrow()
  })

  it("keeps the user bubble PLAIN (no markdown rendering)", () => {
    const block: UserBlock = { kind: "user", id: "b2", text: "**not bold** and `not code`" }
    const html = renderToStaticMarkup(
      <BlockView block={block} onExpand={() => {}} terminalId="t1" sessionId={null} />,
    )
    expect(html).toContain("agent-user-bubble")
    // The user's literal text is preserved verbatim — never turned into markup.
    expect(html).toContain("**not bold** and `not code`")
    expect(html).not.toContain("<strong>")
  })

  // WS5 — the streaming caret renders ONLY on the trailing assistant block while it
  // streams (driven by the `streaming` prop, decided by streamingCaretId). CAPP-58:
  // the caret is now a CSS `::after` on the streaming block's markdown body (so it
  // flows inline at the end of the prose instead of wrapping onto its own line), so
  // the DOM signal to assert on is the `agent-streaming` driver class, not a span.
  it("marks the assistant block as streaming (drives the caret) when streaming", () => {
    const block: AssistantTextBlock = { kind: "assistant", id: "b0", text: "typing" }
    const html = renderToStaticMarkup(
      <BlockView block={block} onExpand={() => {}} terminalId="t1" sessionId={null} streaming />,
    )
    expect(html).toContain("agent-streaming")
  })

  it("omits the streaming marker on a settled assistant block", () => {
    const block: AssistantTextBlock = { kind: "assistant", id: "b0", text: "settled" }
    const html = renderToStaticMarkup(
      <BlockView block={block} onExpand={() => {}} terminalId="t1" sessionId={null} />,
    )
    expect(html).not.toContain("agent-streaming")
  })

  // CAPP-74 — the streaming SMOOTHING BUFFER must NEVER hide a settled / historical /
  // rehydrated block's text: a NON-streaming assistant block renders its FULL prose
  // immediately (no typewriter replay). Static-markup render (no rAF/effects) is
  // exactly the "instant full" path the buffer falls back to.
  it("renders the FULL text of a settled (non-streaming) assistant block — no partial replay", () => {
    const html = renderAssistant("the complete settled reply text")
    expect(html).toContain("the complete settled reply text")
    expect(html).not.toContain("agent-streaming")
  })

  // CAPP-74 — when there's no rAF (SSR / this static render), even a STREAMING block
  // shows full text rather than a stuck-empty slice; the buffer only paces when it can
  // actually animate. So historical/rehydrated transcripts (rendered without a live rAF
  // drain) are complete instantly.
  it("renders full text for a streaming block when no rAF is available (instant fallback)", () => {
    const streamingHtml = renderToStaticMarkup(
      <BlockView
        block={{ kind: "assistant", id: "b0", text: "fully shown without animation" }}
        onExpand={() => {}}
        terminalId="t1"
        sessionId={null}
        streaming
      />,
    )
    expect(streamingHtml).toContain("fully shown without animation")
    expect(streamingHtml).toContain("agent-streaming")
  })
})
