import React from "react"
import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { BlockView, assistantBlockClass } from "./AgentView"
import { wordFadeClass } from "./MarkdownView"
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
    // CAPP-79 — a streaming block word-wraps its prose (`.agent-word` spans), so the
    // text is interleaved with span tags; strip them to assert the FULL text is present.
    expect(streamingHtml.replace(/<[^>]+>/g, "")).toContain("fully shown without animation")
    expect(streamingHtml).toContain("agent-streaming")
  })

  // CAPP-77 (flicker fix) — a streaming block must carry `agent-revealing` in its
  // RENDERED class. The shipped bug derived it from the transient `draining` (shown <
  // text) state; under static render the buffer is caught up (shown === text), so the
  // pre-fix code emitted NO `agent-revealing` even while streaming. The fix drives it
  // off the stable whole-turn signal, so it is present whenever the block streams (and
  // motion is allowed — node has no matchMedia → motion allowed). This render-level
  // assertion FAILS against the pre-fix per-`draining` wiring and PASSES after.
  it("renders agent-revealing on a streaming block (whole-turn rise driver)", () => {
    const streamingHtml = renderToStaticMarkup(
      <BlockView
        block={{ kind: "assistant", id: "b0", text: "rising line" }}
        onExpand={() => {}}
        terminalId="t1"
        sessionId={null}
        streaming
      />,
    )
    expect(streamingHtml).toContain("agent-revealing")
  })

  it("omits agent-revealing on a settled (non-streaming) block", () => {
    const html = renderToStaticMarkup(
      <BlockView
        block={{ kind: "assistant", id: "b0", text: "settled" }}
        onExpand={() => {}}
        terminalId="t1"
        sessionId={null}
      />,
    )
    expect(html).not.toContain("agent-revealing")
  })
})

/**
 * CAPP-77 (flicker fix) — class STABILITY across the catch-up cycle. This is the gap
 * that let the flicker ship: every prior test was on the pure pacing model, NONE
 * asserted the rise/animation class is stable as the reveal catches up between deltas.
 *
 * The bug: the adaptive drain paces FASTER than prose streams, so BETWEEN tokens the
 * buffer drains to the target (`shown === text.length`); the shipped wiring set
 * `.agent-revealing` off that transient "draining" (`active && shown < text`) state, so
 * the class dropped between tokens and was re-added on the next token. Re-adding a class
 * that carries a CSS `animation` restarts `agent-line-rise` from keyframe 0 → the live
 * line snapped back and slid up on ~every token = jitter.
 *
 * The fix: drive `.agent-revealing` off the STABLE whole-turn `reveal` signal (the
 * hook's `active`), held continuously while streaming and dropped only at turn-end.
 *
 * We test the extracted pure derivation (`assistantBlockClass`) — the same function the
 * component renders its className from (no DOM needed; the test env is node-only). We
 * also model the OLD per-`draining` derivation as a negative control (mirroring the
 * `driveBuggy` idiom in useSmoothReveal.test) to prove the assertion FAILS pre-fix.
 */
describe("AgentView — per-line rise class stability across the catch-up cycle", () => {
  /** Whether the rendered class carries the rise/animation token. */
  const hasRevealing = (cls: string) => cls.split(/\s+/).includes("agent-revealing")

  // The pre-fix derivation: `.agent-revealing` was gated on `draining = active && shown
  // < text.length`. Reproduced here so the catch-up-cycle assertion has a negative
  // control it demonstrably fails against.
  function buggyRevealClass(streaming: boolean, active: boolean, shown: number, textLen: number): string {
    const draining = active && shown < textLen
    return (
      `agent-block agent-assistant` +
      (streaming ? " agent-streaming" : "") +
      (draining ? " agent-revealing" : "")
    )
  }

  // One streaming turn, frame by frame: text grows by a token, the adaptive drain then
  // CATCHES UP (shown === text) before the next token (the case the floor/match outpaces
  // the ~60-150 cps prose stream), then a new token grows text again (the re-kick). This
  // is the catch-up → re-kick cycle that toggled the buggy class.
  type Frame = { shown: number; textLen: number }
  const turn: Frame[] = [
    { shown: 3, textLen: 10 }, // token 1 arrives, mid-drain (head start trailing)
    { shown: 10, textLen: 10 }, // CAUGHT UP between tokens (shown === text)
    { shown: 10, textLen: 18 }, // token 2 arrives — re-kick, mid-drain again
    { shown: 18, textLen: 18 }, // caught up again
    { shown: 18, textLen: 27 }, // token 3 arrives — re-kick
    { shown: 27, textLen: 27 }, // caught up again
  ]

  it("FIXED: agent-revealing stays applied through the whole streaming turn (no toggle)", () => {
    // Streaming, motion allowed → `reveal` (active) is true for the whole turn,
    // independent of the catch-up `shown`/`text` state.
    const classes = turn.map(() => assistantBlockClass(true, true))
    // Present on EVERY frame — the rise driver never drops between tokens.
    for (const cls of classes) expect(hasRevealing(cls)).toBe(true)
    // And it never flips off→on across the catch-up→re-kick cycle (stable transitions).
    for (let i = 1; i < classes.length; i++) {
      expect(hasRevealing(classes[i])).toBe(hasRevealing(classes[i - 1]))
    }
  })

  it("REGRESSION: the pre-fix per-draining wiring TOGGLES the class between tokens", () => {
    // Identical catch-up cycle through the OLD derivation: the class is present while
    // mid-drain (shown < text) but DROPS the instant the buffer catches up, then is
    // re-added by the next token — the toggle that restarted the rise = the flicker.
    const buggy = turn.map((f) => buggyRevealClass(true, true, f.shown, f.textLen))
    // The caught-up frames have NO agent-revealing (class dropped between tokens)...
    expect(hasRevealing(buggy[1])).toBe(false) // caught up
    expect(hasRevealing(buggy[2])).toBe(true) // next token re-adds it
    // ...so the membership is NOT stable across the cycle — at least one off→on flip.
    const flips = buggy.filter((c, i) => i > 0 && hasRevealing(c) !== hasRevealing(buggy[i - 1])).length
    expect(flips).toBeGreaterThan(0)
    // The FIXED derivation has ZERO flips on the identical input — the contrast proof.
    const fixed = turn.map(() => assistantBlockClass(true, true))
    const fixedFlips = fixed.filter((c, i) => i > 0 && hasRevealing(c) !== hasRevealing(fixed[i - 1])).length
    expect(fixedFlips).toBe(0)
  })

  it("drops agent-revealing at turn end (settled/historical block never animates)", () => {
    // Turn over → streaming false → reveal false → class dropped → final block settles.
    expect(hasRevealing(assistantBlockClass(false, false))).toBe(false)
  })

  it("no agent-revealing under reduced motion even while streaming (reveal=false)", () => {
    // AssistantBlock computes reveal = streaming && !prefersReducedMotion(); under
    // reduced motion that is false, so the rise (and the buffer) are bypassed.
    expect(hasRevealing(assistantBlockClass(true, false))).toBe(false)
  })

  it("keeps the streaming caret class (agent-streaming) independent of the rise driver", () => {
    // The WS5 caret driver is separate: present whenever streaming, regardless of reveal.
    expect(assistantBlockClass(true, true)).toContain("agent-streaming")
    expect(assistantBlockClass(true, false)).toContain("agent-streaming") // reduced motion: caret yes, rise no
    expect(assistantBlockClass(false, false)).not.toContain("agent-streaming")
  })
})

/**
 * CAPP-79 (BLOCKER 2) — FRONTIER-ONLY per-word fade. The shipped wiring animated EVERY
 * `.agent-word` and relied on DOM identity to keep settled words from re-firing; but a
 * mid-stream markdown structure change (bold/inline-code/link/heading/list) shifts
 * react-markdown's positional sibling keys → remounts the following spans → their fade
 * RE-FIRED on already-settled text (a paragraph-wide re-blur). The fix tags ONLY the
 * frontier (last) word with the animating `agent-word-new`; settled words carry just the
 * structural `agent-word`, so a remounted settled span has NO animation and can't re-fade.
 *
 * The "which word animates" decision is the pure `wordFadeClass`, unit-tested here.
 * DOM-RECONCILIATION FLICKER ITSELF is structurally untestable in the node harness (no
 * jsdom / no real react-markdown remount-on-keying to observe), so we pin the decision
 * function + assert the RENDERED markup carries exactly one frontier word.
 */
describe("AgentView — per-word fade is frontier-only (CAPP-79 BLOCKER 2)", () => {
  it("wordFadeClass tags ONLY the frontier (last) word with the animator", () => {
    const total = 5
    // Settled words (every index but the last) get just the structural class — NO animator.
    for (let i = 0; i < total - 1; i++) {
      expect(wordFadeClass(i, total)).toEqual(["agent-word"])
      expect(wordFadeClass(i, total)).not.toContain("agent-word-new")
    }
    // The frontier (last) word gets the animating class.
    expect(wordFadeClass(total - 1, total)).toEqual(["agent-word", "agent-word-new"])
  })

  it("a settled word carries NO animation class — a remount cannot re-fade it", () => {
    // The whole point: even if react-markdown remounts a settled word span on a structure
    // change, its className has no `agent-word-new`, so the CSS animation never plays.
    expect(wordFadeClass(0, 8)).not.toContain("agent-word-new")
    expect(wordFadeClass(3, 8)).not.toContain("agent-word-new")
    // Single-word edge: the only word IS the frontier.
    expect(wordFadeClass(0, 1)).toEqual(["agent-word", "agent-word-new"])
  })

  it("renders exactly ONE frontier word span in a streaming block's markup", () => {
    // A streaming block (revealing=true; node has no rAF so it renders the FULL text) wraps
    // every prose word; only the last carries `agent-word-new`.
    const html = renderToStaticMarkup(
      <BlockView
        block={{ kind: "assistant", id: "b0", text: "alpha beta gamma delta" }}
        onExpand={() => {}}
        terminalId="t1"
        sessionId={null}
        streaming
      />,
    )
    const wordSpans = (html.match(/<span class="agent-word/g) ?? []).length
    const frontier = (html.match(/agent-word-new/g) ?? []).length
    expect(wordSpans).toBeGreaterThan(1) // multiple words wrapped
    expect(frontier).toBe(1) // exactly ONE animates — the frontier
  })

  it("a SETTLED (non-streaming) block injects NO word spans at all", () => {
    // revealing is off for settled/historical blocks, so rehypeWordFade never runs — no
    // `.agent-word` spans, hence nothing can ever animate on a settled/rehydrated block.
    const html = renderAssistant("settled prose with several words here")
    expect(html).not.toContain("agent-word")
  })
})
