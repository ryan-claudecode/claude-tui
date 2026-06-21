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

/**
 * CAPP-79 — a tiny dependency-free rehype plugin that wraps every whitespace-delimited
 * word of the prose text nodes in `<span class="agent-word">`, leaving whitespace as
 * bare text so the line still wraps naturally. Code is skipped (we never split a
 * `<code>`/`<pre>` subtree), so syntax stays intact.
 *
 * FLICKER-SAFE BY DOM IDENTITY (the same property the CAPP-77 per-line rise relies on):
 * the streaming block re-parses its growing revealed slice ~per frame, but the prefix
 * is stable, so React reconciles the already-revealed word spans to the SAME DOM nodes
 * (no remount → their fade does not restart). Only the NEWEST word is a freshly-mounted
 * span, so only it plays `agent-word-fade`. Settled words sit at the animation's `both`
 * end state.
 */
function rehypeWordFade() {
  const SKIP_TAGS = new Set(["code", "pre"])
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
            next.push({
              type: "element",
              tagName: "span",
              properties: { className: ["agent-word"] },
              children: [{ type: "text", value: part }],
            })
          }
        }
      } else {
        wrap(child as { tagName?: string; children?: unknown[] })
        next.push(child)
      }
    }
    node.children = next
  }
  return (tree: { tagName?: string; children?: unknown[] }) => wrap(tree)
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
