import { describe, it, expect } from "vitest"
import {
  snapshotPromoteRows,
  rowsToPromoteEntries,
  type PromoteEntry,
} from "./killSessionPromote"

describe("killSessionPromote — snapshot + checked-entries mapping (CAPP-93 / U5)", () => {
  const entries: PromoteEntry[] = [
    {
      text: "root cause is a race in reopenTerminal",
      originSessionId: "s1",
      originNoteId: "n1",
      createdAt: 10,
      status: "active",
      source: "self",
    },
    {
      text: "init carries the catalog immediately",
      originSessionId: "s1",
      originNoteId: "n2",
      createdAt: 20,
      status: "superseded",
      supersededBy: "n3",
      source: "self",
    },
  ]

  it("snapshots every entry into a PRE-CHECKED, editable row (default = promote ALL)", () => {
    const rows = snapshotPromoteRows(entries)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.checked)).toBe(true)
    expect(rows[0].text).toBe(entries[0].text)
    expect(rows[1].text).toBe(entries[1].text)
    // rowId derives from the origin note id when present (stable + unique).
    expect(rows[0].rowId).toBe("n1")
    expect(rows[1].rowId).toBe("n2")
    // The origin entry rides along untouched for provenance.
    expect(rows[0].origin).toBe(entries[0])
  })

  it("falls back to an index-based rowId for an authored finding with no note id", () => {
    const authored: PromoteEntry[] = [{ text: "freshly authored", source: "user" }]
    const rows = snapshotPromoteRows(authored)
    expect(rows[0].rowId).toBe("row-0")
  })

  it("empty candidate list → no rows", () => {
    expect(snapshotPromoteRows([])).toEqual([])
  })

  it("maps ONLY checked rows back to entries, carrying edited text + preserved provenance", () => {
    const rows = snapshotPromoteRows(entries)
    // Edit the first row's text; uncheck the second.
    rows[0].text = "root cause is a race in reopenTerminal (confirmed)"
    rows[1].checked = false
    const out = rowsToPromoteEntries(rows)
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe("root cause is a race in reopenTerminal (confirmed)")
    // Provenance preserved verbatim from the origin.
    expect(out[0].originSessionId).toBe("s1")
    expect(out[0].originNoteId).toBe("n1")
    expect(out[0].createdAt).toBe(10)
    expect(out[0].status).toBe("active")
    expect(out[0].source).toBe("self")
  })

  it("preserves a ruled-out finding's status + supersededBy when kept", () => {
    const rows = snapshotPromoteRows(entries)
    const out = rowsToPromoteEntries(rows)
    const ruledOut = out.find((e) => e.originNoteId === "n2")
    expect(ruledOut?.status).toBe("superseded")
    // supersededBy rides through unchanged — the service rewrites/orphan-keeps it.
    expect(ruledOut?.supersededBy).toBe("n3")
  })

  it("trims edited text and drops a row whose text was cleared to whitespace", () => {
    const rows = snapshotPromoteRows(entries)
    rows[0].text = "   spaced out   "
    rows[1].text = "   " // cleared → dropped even though still checked
    const out = rowsToPromoteEntries(rows)
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe("spaced out")
  })

  it("all unchecked → empty promote set (Keep degrades to Delete)", () => {
    const rows = snapshotPromoteRows(entries).map((r) => ({ ...r, checked: false }))
    expect(rowsToPromoteEntries(rows)).toEqual([])
  })
})
