import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import MarkdownView from "./MarkdownView"

/**
 * CAPP-79 — per-word fade-in for the STREAMING reveal (Lever B, layered on the CAPP-78
 * word-snap). When `revealing`, every word of the rendered prose is wrapped in a
 * `<span class="agent-word">` so the line still wraps naturally — but only the FRONTIER
 * (last) word ALSO carries `agent-word-new`, the single class the CSS animates (BLOCKER 2
 * fix: settled words never re-fade even if a mid-stream structure change remounts them).
 * A settled / historical block (NOT revealing) renders plain, so it never re-animates and
 * the DOM stays lean. Code (inline + fenced) is never split, so syntax stays intact.
 */
describe("MarkdownView — CAPP-79 per-word fade (streaming reveal)", () => {
  it("wraps each prose word of a streaming block, animating ONLY the frontier word", () => {
    const html = renderToStaticMarkup(<MarkdownView source="hello world" revealing />)
    expect(html).toContain("agent-word")
    // Two prose words → two word spans. Count the span open tags whose class begins with
    // `agent-word` (matches both the settled `agent-word` and the frontier
    // `agent-word agent-word-new`, but each span exactly once).
    const wordSpans = (html.match(/<span class="agent-word/g) ?? []).length
    expect(wordSpans).toBe(2)
    // FRONTIER-ONLY: exactly ONE word carries the animating `agent-word-new` class.
    const frontier = (html.match(/agent-word-new/g) ?? []).length
    expect(frontier).toBe(1)
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
