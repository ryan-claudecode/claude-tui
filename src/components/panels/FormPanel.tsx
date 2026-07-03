import { useState } from "react"
// CAPP-107 (review MINOR 1) — the QuestionForm↔ask_user payload contract is pinned in
// ONE shared pure module; the tool's parser (electron/mcp/tools/panels.ts) imports the
// same file, so the submit keys can never drift between the two sides.
import { buildQuestionSubmit, buildQuestionCancel } from "../../lib/questionSubmit"

interface Field {
  name: string
  type: "text" | "textarea" | "select" | "checklist" | "toggle" | "number"
  label?: string
  options?: string[]
  items?: string[]
  placeholder?: string
  default?: any
}

interface Props {
  panelId: string
  // Generic form (show_form)
  title?: string
  fields?: Field[]
  submitLabel?: string
  // CAPP-107 — the first-class question variant (ask_user). When `kind === "question"`
  // FormPanel renders <QuestionForm> instead of the generic field list.
  kind?: string
  question?: string
  context?: string
  options?: string[]
  multiSelect?: boolean
  allowFreeText?: boolean
}

/** Submit form data over whichever bridge this window exposes (main OR companion).
 *  Shared by the generic form and the question variant so a popped-out form still
 *  resolves the pending MCP promise. */
function submitForm(panelId: string, data: Record<string, any>) {
  if (typeof window !== "undefined" && (window as any).companionApi) {
    ;(window as any).companionApi.submitForm(panelId, data)
  } else {
    window.api.submitForm(panelId, data)
  }
}

function initialValue(f: Field) {
  if (f.default !== undefined) return f.default
  switch (f.type) {
    case "toggle":
      return false
    case "checklist":
      return []
    case "select":
      return f.options?.[0] ?? ""
    case "number":
      return 0
    default:
      return ""
  }
}

export default function FormPanel(props: Props) {
  // CAPP-107 — route a question to the dedicated variant.
  if (props.kind === "question") {
    return <QuestionForm {...props} />
  }

  const { panelId, title, fields = [], submitLabel = "Submit" } = props
  return <GenericForm panelId={panelId} title={title} fields={fields} submitLabel={submitLabel} />
}

function GenericForm({ panelId, title, fields = [], submitLabel = "Submit" }: Props) {
  const [values, setValues] = useState<Record<string, any>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, initialValue(f)])),
  )
  const [submitted, setSubmitted] = useState(false)

  const set = (name: string, value: any) =>
    setValues((v) => ({ ...v, [name]: value }))

  const toggleItem = (name: string, item: string) =>
    setValues((v) => {
      const arr: string[] = v[name] ?? []
      return {
        ...v,
        [name]: arr.includes(item) ? arr.filter((x) => x !== item) : [...arr, item],
      }
    })

  const handleSubmit = () => {
    setSubmitted(true)
    submitForm(panelId, values)
  }

  if (submitted) {
    return <div className="panel-empty">Form submitted.</div>
  }

  return (
    <div className="form-panel">
      {title && <h2 className="form-title">{title}</h2>}
      {fields.map((f) => (
        <div key={f.name} className="form-field">
          {f.label && f.type !== "toggle" && <label className="form-label">{f.label}</label>}
          {f.type === "text" && (
            <input
              type="text"
              className="form-input"
              placeholder={f.placeholder}
              value={values[f.name] ?? ""}
              onChange={(e) => set(f.name, e.target.value)}
            />
          )}
          {f.type === "number" && (
            <input
              type="number"
              className="form-input"
              value={values[f.name] ?? 0}
              onChange={(e) => set(f.name, Number(e.target.value))}
            />
          )}
          {f.type === "textarea" && (
            <textarea
              className="form-input form-textarea"
              placeholder={f.placeholder}
              value={values[f.name] ?? ""}
              onChange={(e) => set(f.name, e.target.value)}
            />
          )}
          {f.type === "select" && (
            <select
              className="form-input"
              value={values[f.name] ?? ""}
              onChange={(e) => set(f.name, e.target.value)}
            >
              {f.options?.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          )}
          {f.type === "checklist" && (
            <div className="form-checklist">
              {f.items?.map((item) => (
                <label key={item} className="form-check">
                  <input
                    type="checkbox"
                    checked={(values[f.name] ?? []).includes(item)}
                    onChange={() => toggleItem(f.name, item)}
                  />
                  <span>{item}</span>
                </label>
              ))}
            </div>
          )}
          {f.type === "toggle" && (
            <label className="form-toggle">
              <input
                type="checkbox"
                checked={!!values[f.name]}
                onChange={(e) => set(f.name, e.target.checked)}
              />
              <span className="toggle-track">
                <span className="toggle-thumb" />
              </span>
              <span>{f.label}</span>
            </label>
          )}
        </div>
      ))}
      <div className="form-actions">
        <button className="form-submit" onClick={handleSubmit}>
          {submitLabel}
        </button>
      </div>
    </div>
  )
}

/**
 * CAPP-107 — the QUESTION variant of a form (the `ask_user` MCP tool). Renders the
 * question as the title, `context` as a muted subline, `options` as large
 * click-to-select cards (radio for single-select, checkbox for multi_select) with
 * generous hit targets, an optional always-visible free-text field when
 * `allowFreeText` (or when there are no options), and Submit + Cancel text buttons.
 *
 * Submit sends `{ options: <selected labels>, text: <free text> }`; Cancel sends
 * `{ cancelled: true }` (both resolve the pending ask_user promise through the same
 * submitForm seam, so it works in the modal AND popped-out in the companion).
 */
function QuestionForm({
  panelId,
  question,
  context,
  options = [],
  multiSelect = false,
  allowFreeText = false,
  submitLabel = "Submit",
}: Props) {
  const hasOptions = options.length > 0
  // With no options there is nothing to pick — free text is the only answer.
  const freeText = allowFreeText || !hasOptions
  const [selected, setSelected] = useState<string[]>([])
  const [text, setText] = useState("")
  const [done, setDone] = useState<null | "submitted" | "cancelled">(null)

  const choose = (opt: string) => {
    setSelected((cur) => {
      if (multiSelect) {
        return cur.includes(opt) ? cur.filter((x) => x !== opt) : [...cur, opt]
      }
      // Single-select: clicking the chosen card again clears it.
      return cur.includes(opt) ? [] : [opt]
    })
  }

  const trimmed = text.trim()
  const canSubmit = selected.length > 0 || (freeText && trimmed.length > 0)

  const submit = () => {
    if (!canSubmit) return
    setDone("submitted")
    // MINOR 1 — build the payload through the shared contract module (the tool's
    // parseQuestionAnswer reads the same keys).
    submitForm(panelId, buildQuestionSubmit(selected, freeText ? trimmed : ""))
  }

  const cancel = () => {
    setDone("cancelled")
    submitForm(panelId, buildQuestionCancel())
  }

  if (done === "submitted") return <div className="panel-empty">Answer sent.</div>
  if (done === "cancelled") return <div className="panel-empty">Question dismissed.</div>

  return (
    <div className="form-panel question-form">
      <h2 className="form-title question-title">{question}</h2>
      {context && <p className="question-context">{context}</p>}

      {hasOptions && (
        <div
          className={`question-options ${multiSelect ? "multi" : "single"}`}
          role={multiSelect ? "group" : "radiogroup"}
        >
          {options.map((opt, i) => {
            const on = selected.includes(opt)
            return (
              <button
                type="button"
                // NIT 2 — key by index: the ask_user tool dedupes labels, but a direct
                // showPanel can still pass twins; a label key would collide.
                key={i}
                className={`question-option ${on ? "selected" : ""}`}
                role={multiSelect ? "checkbox" : "radio"}
                aria-checked={on}
                onClick={() => choose(opt)}
              >
                <span
                  className={`question-marker ${multiSelect ? "check" : "radio"}`}
                  aria-hidden="true"
                />
                <span className="question-option-label">{opt}</span>
              </button>
            )
          })}
        </div>
      )}

      {freeText && (
        <div className="question-freetext">
          <label className="form-label" htmlFor={`${panelId}-freetext`}>
            {hasOptions ? "Other — type your own answer" : "Your answer"}
          </label>
          <textarea
            id={`${panelId}-freetext`}
            className="form-input form-textarea question-freetext-input"
            placeholder="Type your answer…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
      )}

      <div className="form-actions question-actions">
        <button
          type="button"
          className="form-submit"
          disabled={!canSubmit}
          onClick={submit}
        >
          {submitLabel}
        </button>
        <button type="button" className="question-cancel" onClick={cancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
