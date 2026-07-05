import { describe, it, expect } from "vitest"
import {
  groupToolRuns,
  summarizeToolGroup,
  activeToolLabel,
  TOOL_GROUP_MIN_RUN,
  type DisplayItem,
  type ToolGroupItem,
} from "./toolGroups"
import type { TranscriptBlock, ToolBlock, ToolStatus } from "./agentTranscript"

let seq = 0
function tool(name: string, status: ToolStatus = "done"): ToolBlock {
  return { kind: "tool", id: `b${seq++}`, toolUseId: `t${seq}`, name, input: {}, status }
}
function text(t = "hi"): TranscriptBlock {
  return { kind: "assistant", id: `b${seq++}`, text: t }
}
function raw(): TranscriptBlock {
  return { kind: "raw", id: `b${seq++}`, raw: { type: "rate_limit_event" } }
}

/** The single tool-group in a display list (fails the test if there isn't exactly one). */
function onlyGroup(items: DisplayItem[]): ToolGroupItem {
  const groups = items.filter((i): i is ToolGroupItem => i.kind === "tool-group")
  expect(groups).toHaveLength(1)
  return groups[0]
}

describe("groupToolRuns", () => {
  it("folds a run of consecutive tools into one group", () => {
    const items = groupToolRuns([tool("Read"), tool("Grep"), tool("Edit")])
    expect(items).toHaveLength(1)
    const g = onlyGroup(items)
    expect(g.count).toBe(3)
    expect(g.tools.map((t) => t.name)).toEqual(["Read", "Grep", "Edit"])
    expect(g.id).toBe(g.tools[0].id) // stable key = first tool's id
  })

  it("leaves a lone tool inline (a run below the threshold is not collapsed)", () => {
    const items = groupToolRuns([text("before"), tool("Read"), text("after")])
    expect(items.map((i) => i.kind)).toEqual(["block", "block", "block"])
  })

  it("breaks a run on any non-tool, non-transparent block", () => {
    const items = groupToolRuns([
      tool("Read"),
      tool("Grep"),
      text("narration"),
      tool("Edit"),
      tool("Write"),
    ])
    // group(2) · text · group(2)
    expect(items.map((i) => i.kind)).toEqual(["tool-group", "block", "tool-group"])
  })

  it("treats a raw event as TRANSPARENT — it does not fragment a burst", () => {
    const items = groupToolRuns([tool("Read"), raw(), tool("Grep"), tool("Edit")])
    expect(items).toHaveLength(1)
    const g = onlyGroup(items)
    expect(g.count).toBe(3) // count is TOOLS only
    expect(g.items).toHaveLength(4) // the raw is absorbed into the body, not lost
    expect(g.items.some((b) => b.kind === "raw")).toBe(true)
  })

  it("trims a run's TRAILING raws back into the main flow (group stays tool-bounded)", () => {
    const items = groupToolRuns([tool("Read"), tool("Grep"), raw(), text("done")])
    // group(2) ends at the last tool; the trailing raw + text render inline after it
    expect(items.map((i) => i.kind)).toEqual(["tool-group", "block", "block"])
    const g = onlyGroup(items)
    expect(g.items[g.items.length - 1].kind).toBe("tool")
  })

  it("does NOT start a run on a leading raw", () => {
    const items = groupToolRuns([raw(), tool("Read"), tool("Grep")])
    expect(items.map((i) => i.kind)).toEqual(["block", "tool-group"])
  })

  it("aggregates status: any error → error, else any running → running, else done", () => {
    expect(onlyGroup(groupToolRuns([tool("A", "done"), tool("B", "done")])).status).toBe("done")
    expect(onlyGroup(groupToolRuns([tool("A", "done"), tool("B", "running")])).status).toBe(
      "running",
    )
    expect(onlyGroup(groupToolRuns([tool("A", "running"), tool("B", "error")])).status).toBe(
      "error",
    )
    const g = onlyGroup(groupToolRuns([tool("A", "error"), tool("B", "error"), tool("C", "done")]))
    expect(g.errored).toBe(2)
  })

  it("builds a most-frequent-first name breakdown (ties alphabetical)", () => {
    const g = onlyGroup(
      groupToolRuns([tool("Read"), tool("Grep"), tool("Read"), tool("Edit"), tool("Read")]),
    )
    expect(g.breakdown).toEqual([
      { name: "Read", count: 3 },
      { name: "Edit", count: 1 },
      { name: "Grep", count: 1 },
    ])
  })

  it("respects a custom minRun", () => {
    // A 2-run stays inline when minRun is 3.
    const items = groupToolRuns([tool("Read"), tool("Grep")], 3)
    expect(items.map((i) => i.kind)).toEqual(["block", "block"])
  })

  it("returns an empty list for empty input and never throws", () => {
    expect(groupToolRuns([])).toEqual([])
  })

  it("default threshold is 2", () => {
    expect(TOOL_GROUP_MIN_RUN).toBe(2)
    expect(groupToolRuns([tool("Read"), tool("Grep")])).toHaveLength(1)
  })
})

describe("summarizeToolGroup", () => {
  it("renders a compact name ×count summary", () => {
    const g = onlyGroup(groupToolRuns([tool("Read"), tool("Read"), tool("Grep")]))
    expect(summarizeToolGroup(g)).toBe("Read ×2 · Grep ×1")
  })

  it("caps distinct names with a +N more tail", () => {
    const g = onlyGroup(
      groupToolRuns([tool("A"), tool("B"), tool("C"), tool("D"), tool("E"), tool("F")]),
    )
    expect(summarizeToolGroup(g, 4)).toBe("A ×1 · B ×1 · C ×1 · D ×1 · +2 more")
  })
})

describe("activeToolLabel", () => {
  it("names the most-recent running tool while the burst is live", () => {
    const g = onlyGroup(
      groupToolRuns([tool("Read", "done"), tool("Grep", "running"), tool("Bash", "running")]),
    )
    expect(activeToolLabel(g)).toBe("Bash")
  })

  it("is null once the burst has settled", () => {
    const g = onlyGroup(groupToolRuns([tool("Read"), tool("Grep")]))
    expect(activeToolLabel(g)).toBeNull()
  })
})
