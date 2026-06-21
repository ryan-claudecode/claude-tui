import { memo, useRef, useState } from "react"
import type { ReactNode, MouseEvent } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

interface Props {
  /** The markdown source string. */
  source?: string
  /** Optional extra class on the `.markdown-body` container. */
  className?: string
  /**
   * CAPP-79 — when set, this is the LIVE streaming block: wrap each prose word in a
   * `<span class="agent-word">` so the CSS can fade each one in as it's revealed (the
   * per-word "materialize" that softens the word-snap pop). Settled / historical blocks
   * leave this off and render plain — so they never re-animate and carry no extra DOM.
   */
  revealing?: boolean
}

/** A minimal hast word-span node the rehype plugin builds + later (re)classes. */
type WordSpan = {
  type: "element"
  tagName: "span"
  properties: { className: string[] }
  children: Array<{ type: "text"; value: string }>
}

/**
 * CAPP-79 (BLOCKER 2 fix) — the PURE "which word animates" decision, extracted so the
 * frontier-only invariant is unit-testable WITHOUT a DOM (the test env is node-only).
 *
 * Returns the className array for the prose word at `index` of `count` total words: the
 * FRONTIER (last, newest-revealed) word gets the animating `agent-word-new`; every
 * SETTLED word gets only the structural `agent-word`. So even if a settled word REMOUNTS
 * when the growing markdown slice forms an inline/block construct mid-stream (bold,
 * inline code, link, heading, list — react-markdown reconciles siblings by positional
 * keys, giving the following spans new keys → remount), it carries NO animation class and
 * therefore does NOT re-fade. Only the active edge (the frontier word) animates — the
 * SAME edge-only principle CAPP-77 used for the per-line rise. The frontier itself
 * re-animating on a structure remount is acceptable: it's the live reveal edge.
 */
export function wordFadeClass(index: number, count: number): string[] {
  return index === count - 1 ? ["agent-word", "agent-word-new"] : ["agent-word"]
}

/**
 * CAPP-79 — a tiny dependency-free rehype plugin that wraps every whitespace-delimited
 * word of the prose text nodes in a `<span class="agent-word">`, leaving whitespace as
 * bare text so the line still wraps naturally. Code is skipped (we never split a
 * `<code>`/`<pre>` subtree), so syntax stays intact.
 *
 * FRONTIER-ONLY ANIMATION (the BLOCKER 2 flicker fix): after wrapping, ONLY the LAST word
 * span in document order is tagged `agent-word-new` (via {@link wordFadeClass}); the CSS
 * animates only `.agent-revealing .agent-word-new`, NOT every `.agent-word`. So settled
 * words never fade again even when a mid-stream structure change (a new `**`/`` ` ``/`#`/
 * `-`) shifts react-markdown's positional sibling keys and REMOUNTS the following spans —
 * a remounted SETTLED span has no animating class, so no paragraph-wide re-blur. As the
 * reveal advances, the frontier moves to the new last word and only it animates.
 */
function rehypeWordFade() {
  const SKIP_TAGS = new Set(["code", "pre"])
  // Collected in DOCUMENT ORDER as we walk, so the LAST is the reveal frontier.
  const spans: WordSpan[] = []
  const wrap = (node: { tagName?: string; children?: unknown[] }) => {
    if (!Array.isArray(node.children)) return
    if (node.tagName && SKIP_TAGS.has(node.tagName)) return
    const next: unknown[] = []
    for (const child of node.children as Array<{ type?: string; value?: string }>) {
      if (child.type === "text" && typeof child.value === "string") {
        // Split keeping the whitespace runs; wrap non-space tokens, pass space through.
        for (const part of child.value.split(/(\s+)/)) {
          if (part === "") continue
          if (/^\s+$/.test(part)) {
            next.push({ type: "text", value: part })
          } else {
            const span: WordSpan = {
              type: "element",
              tagName: "span",
              // Structural class only for now; the frontier pass below adds the animator.
              properties: { className: ["agent-word"] },
              children: [{ type: "text", value: part }],
            }
            spans.push(span)
            next.push(span)
          }
        }
      } else {
        wrap(child as { tagName?: string; children?: unknown[] })
        next.push(child)
      }
    }
    node.children = next
  }
  return (tree: { tagName?: string; children?: unknown[] }) => {
    wrap(tree)
    // Frontier-only: tag ONLY the last word span; settled words keep just `agent-word`.
    for (let i = 0; i < spans.length; i++) {
      spans[i].properties.className = wordFadeClass(i, spans.length)
    }
  }
}

/** Stable plugin-array identity (so React.memo + react-markdown don't see a new ref). */
const WORD_FADE_REHYPE = [rehypeWordFade]

// A fenced code block with a hover "Copy" button. Reads text straight from the
// rendered DOM so it works regardless of how react-markdown nests children.
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  const copy = async (e: MouseEvent) => {
    // Inline (AgentView) the whole block is a click-to-expand target — copying must
    // not also trigger that. stopPropagation is harmless in the panel.
    e.stopPropagation()
    const el = ref.current
    const text = el?.querySelector("code")?.textContent ?? el?.textContent ?? ""
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="md-codeblock">
      <button className="md-copy" onClick={copy} type="button">
        {copied ? "Copied" : "Copy"}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  )
}

// Links: never let an anchor navigate the renderer away from the SPA. There is no
// `will-navigate` guard in electron/main.ts, so a plain `<a>` click would replace
// the whole app (main window) or the panel (companion). We suppress the default
// navigation while keeping the link styled + visible (and right-click-copyable).
// No external-open bridge is exposed to either renderer today, so opening in the
// OS browser is a follow-up — suppressing the nav is the safe baseline.
function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const onClick = (e: MouseEvent) => {
    e.preventDefault()
  }
  return (
    <a href={href} onClick={onClick} rel="noreferrer noopener">
      {children}
    </a>
  )
}

// Stable component map — defined once so memoized renders never see a new object.
const MARKDOWN_COMPONENTS = {
  pre: ({ children }: { children?: ReactNode }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <MarkdownLink href={href}>{children}</MarkdownLink>
  ),
}

/**
 * BO-8 — the ONE markdown renderer shared by the companion MarkdownPanel and the
 * inline structured chat (AgentView's assistant + result prose), so the two can
 * never drift. Wraps ReactMarkdown + remarkGfm (GFM tables/lists/strikethrough)
 * with a hover-copy code block and the SAME safe default: react-markdown ESCAPES
 * raw HTML (no rehype-raw), so untrusted agent/user text can't inject markup.
 *
 * Memoized on `source`: the structured transcript re-renders on every streamed
 * delta, so without memoization every settled block would re-parse its markdown on
 * each keystroke of the agent's reply. With React.memo only the block whose `source`
 * actually changed re-parses — every SETTLED block stays cached. For the ONE live
 * streaming block the CAPP-74 smoothing buffer feeds a `source` that grows per rAF
 * frame (the revealed slice, not just per delta), so that single block re-parses ~per
 * frame; this is inherent to a markdown typewriter, bounded to the one active block,
 * and well within react-markdown's budget (no throttle needed). react-markdown also
 * tolerates partial / unbalanced markdown (e.g. an unclosed ``` fence between frames)
 * without throwing, so incremental rendering never flickers or crashes.
 */
function MarkdownViewImpl({ source = "", className, revealing }: Props) {
  return (
    <div className={className ? `markdown-body ${className}` : "markdown-body"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={revealing ? WORD_FADE_REHYPE : undefined}
        components={MARKDOWN_COMPONENTS}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}

const MarkdownView = memo(MarkdownViewImpl)
export default MarkdownView
