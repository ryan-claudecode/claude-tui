/**
 * CAPP-107 — the QuestionForm → ask_user payload contract, pinned in ONE module.
 *
 * The question form submits a payload the ask_user MCP tool parses back out of an
 * untyped Record. Before this module, the key names ("options"/"text"/"cancelled")
 * lived independently in FormPanel.tsx and electron/mcp/tools/panels.ts — renaming
 * either side would silently break every option answer while all suites stayed
 * green. Both call sites now import THESE helpers, so the contract is a single
 * source of truth and the round-trip is directly testable
 * (questionSubmit.test.ts).
 *
 * PURE + renderer-safe (no node imports) — imported by BOTH the renderer
 * (src/components/panels/FormPanel.tsx) and the electron main process
 * (electron/mcp/tools/panels.ts). Keep it that way: no `node:*`, no Electron.
 */

/** What the question form submits through the submitForm seam. */
export interface QuestionSubmitData {
  options: string[]
  text: string
}

/** What the ask_user tool returns to the agent (JSON-stringified). */
export interface QuestionAnswer {
  answer: string
  selected: string[]
  free_text?: string
}

/** Build the submit payload from the user's selections + free text (trimmed). */
export function buildQuestionSubmit(selected: string[], text: string): QuestionSubmitData {
  return { options: [...selected], text: text.trim() }
}

/** Build the cancel payload (the same shape PanelService.hide resolves with). */
export function buildQuestionCancel(): { cancelled: true } {
  return { cancelled: true }
}

/**
 * Parse a resolved show_form payload into the agent-facing answer: the selected
 * option label(s) and any free text, verbatim, plus a combined `answer` string —
 * or `{ cancelled: true }` when the user dismissed the question (or the form was
 * cancelled by a close path).
 */
export function parseQuestionAnswer(
  data: Record<string, any>,
): QuestionAnswer | { cancelled: true } {
  if (data?.cancelled) return { cancelled: true }
  const selected: string[] = Array.isArray(data?.options)
    ? data.options.filter((x: unknown): x is string => typeof x === "string")
    : []
  const freeText = typeof data?.text === "string" ? data.text.trim() : ""
  const parts = [...selected]
  if (freeText) parts.push(freeText)
  return {
    answer: parts.join(", "),
    selected,
    free_text: freeText || undefined,
  }
}

/**
 * CAPP-107 (review NIT 2) — normalize the ask_user `options` list: de-duplicate
 * preserving first-occurrence order. Fewer than 2 unique options is not a real
 * choice, so it collapses to `undefined` — the caller then treats it like the
 * no-options case (free text implied on).
 */
export function normalizeQuestionOptions(options?: string[]): string[] | undefined {
  if (!Array.isArray(options)) return undefined
  const unique: string[] = []
  for (const opt of options) {
    if (!unique.includes(opt)) unique.push(opt)
  }
  return unique.length >= 2 ? unique : undefined
}
