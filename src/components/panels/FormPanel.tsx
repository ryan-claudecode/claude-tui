import { useState } from "react"

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
  title?: string
  fields?: Field[]
  submitLabel?: string
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

export default function FormPanel({ panelId, title, fields = [], submitLabel = "Submit" }: Props) {
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
    window.api.submitForm(panelId, values)
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
