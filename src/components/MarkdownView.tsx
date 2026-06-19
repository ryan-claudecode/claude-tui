import { memo, useRef, useState } from "react"
import type { ReactNode, MouseEvent } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

interface Props {
  /** The markdown source string. */
  source?: string
  /** Optional extra class on the `.markdown-body` container. */
  className?: string
}

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
 * each keystroke of the agent's reply. With React.memo only the block whose text
 * actually changed (the growing one) re-parses. react-markdown tolerates partial /
 * unbalanced markdown (e.g. an unclosed ``` fence between deltas) without throwing,
 * so incremental rendering never flickers or crashes.
 */
function MarkdownViewImpl({ source = "", className }: Props) {
  return (
    <div className={className ? `markdown-body ${className}` : "markdown-body"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {source}
      </ReactMarkdown>
    </div>
  )
}

const MarkdownView = memo(MarkdownViewImpl)
export default MarkdownView
