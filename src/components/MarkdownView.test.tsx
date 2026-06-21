import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import MarkdownView from "./MarkdownView"

/**
 * CAPP-79 — per-word fade-in for the STREAMING reveal (Lever B, layered on the CAPP-78
 * word-snap). When `revealing`, every word of the rendered prose is wrapped in a
 * `<span class="agent-word">` so the CSS can fade each one in as it appears — turning
 * the hard word-pop into a soft "materialize". A settled / historical block (NOT
 * revealing) renders plain, so it never re-animates and the DOM stays lean. Code
 * (inline + fenced) is never split, so syntax stays intact.
 */
describe("MarkdownView — CAPP-79 per-word fade (streaming reveal)", () => {
  it("wraps each prose word of a streaming block in an agent-word span", () => {
    const html = renderToStaticMarkup(<MarkdownView source="hello world" revealing />)
    expect(html).toContain('class="agent-word"')
    const count = html.match(/agent-word/g)?.length ?? 0
    expect(count).toBe(2) // two words → two spans
  })

  it("does NOT wrap words when not revealing (settled / historical block)", () => {
    const html = renderToStaticMarkup(<MarkdownView source="hello world" />)
    expect(html).not.toContain("agent-word")
  })

  it("wraps words inside inline emphasis but never splits code", () => {
    // "see" + "here" are prose words; the inline-code "x = 1" must stay intact.
    const html = renderToStaticMarkup(
      <MarkdownView source={"see `x = 1` here"} revealing />,
    )
    expect(html).toContain('class="agent-word"')
    // The code content is rendered in a <code> and is NOT chopped into word spans.
    expect(html).toContain("<code>x = 1</code>")
  })

  it("still renders the prose text intact (words + whitespace preserved)", () => {
    const html = renderToStaticMarkup(<MarkdownView source="alpha beta gamma" revealing />)
    // Strip tags; the visible text must be unchanged by the wrapping.
    const text = html.replace(/<[^>]+>/g, "")
    expect(text).toContain("alpha beta gamma")
  })
})
