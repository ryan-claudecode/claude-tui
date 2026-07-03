import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import FormPanel from "./FormPanel"

/**
 * CAPP-107 — the ask_user QUESTION variant of FormPanel. `renderToStaticMarkup` is the
 * established node-test render path here (no jsdom), which renders the at-rest state —
 * exactly what "visible-at-rest" (the no-hover-reveal UI rule) needs proving. We assert
 * the question/context, the options (radio vs checkbox), the free-text field, and the
 * always-visible Submit + Cancel buttons all render without any interaction. The submit/
 * cancel round-trip is covered at the service + tool level (panels.test.ts).
 */

const render = (props: Record<string, any>) =>
  renderToStaticMarkup(<FormPanel panelId="panel-1" {...props} />)

describe("FormPanel — question variant (ask_user)", () => {
  it("renders the question, context, options, and Submit + Cancel at rest", () => {
    const html = render({
      kind: "question",
      question: "Deploy to prod now?",
      context: "prod is live",
      options: ["Yes", "No"],
    })
    expect(html).toContain("question-form")
    expect(html).toContain("Deploy to prod now?")
    expect(html).toContain("question-context")
    expect(html).toContain("prod is live")
    // Both option labels are visible with no hover/interaction.
    expect(html).toContain("Yes")
    expect(html).toContain("No")
    expect(html).toContain("question-option")
    // Single-select options are radios.
    expect(html).toContain('role="radio"')
    expect(html).toContain("question-marker radio")
    // Submit + Cancel are both statically visible.
    expect(html).toContain(">Submit<")
    expect(html).toContain("question-cancel")
    expect(html).toContain(">Cancel<")
    // Nothing selected yet → Submit is disabled (guards against empty answers).
    expect(html).toContain("disabled")
  })

  it("renders multi-select options as checkboxes", () => {
    const html = render({
      kind: "question",
      question: "Which areas changed?",
      options: ["api", "ui", "db"],
      multiSelect: true,
    })
    expect(html).toContain('role="checkbox"')
    expect(html).toContain("question-marker check")
    expect(html).toContain("question-options multi")
  })

  it("shows an always-visible free-text field when allowFreeText (with options)", () => {
    const html = render({
      kind: "question",
      question: "Pick one",
      options: ["a", "b"],
      allowFreeText: true,
    })
    expect(html).toContain("question-freetext")
    expect(html).toContain("question-freetext-input")
    expect(html).toContain("Other — type your own answer")
  })

  it("with no options renders a free-text-only question (input visible at rest)", () => {
    const html = render({
      kind: "question",
      question: "What should we name it?",
    })
    // No option cards, but the answer textarea is present and labelled.
    expect(html).not.toContain("question-option ")
    expect(html).toContain("question-freetext-input")
    expect(html).toContain("Your answer")
  })

  it("still renders the generic form when kind is not 'question'", () => {
    const html = render({
      title: "Confirm",
      fields: [{ name: "note", type: "text", label: "Note" }],
      submitLabel: "Go",
    })
    expect(html).toContain("form-panel")
    expect(html).not.toContain("question-form")
    expect(html).toContain("Confirm")
    expect(html).toContain(">Go<")
  })
})
