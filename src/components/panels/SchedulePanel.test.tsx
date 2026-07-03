import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import SchedulePanel from "./SchedulePanel"

/**
 * CAPP-115 (SCHED-2) — the schedule detail panel. `renderToStaticMarkup` is the
 * established node-test render path here (no jsdom / RTL; effects like the 30s
 * countdown ticker don't run under SSR — the initial render is asserted). Covers the
 * statically-visible action buttons at rest and the per-status run-history tinting.
 */

const baseProps = {
  id: "sch-1",
  name: "Fable watch",
  prompt: "check the web for Fable 5",
  recurrence: { kind: "interval" as const, everyMinutes: 20, window: { start: "08:00", end: "22:00" } },
  enabled: true,
  nextRunAt: new Date(Date.now() + 14 * 60_000).toISOString(),
}

describe("SchedulePanel — controls at rest (no hover-reveal)", () => {
  it("renders the four TEXT action buttons statically", () => {
    const html = renderToStaticMarkup(<SchedulePanel {...baseProps} runHistory={[]} />)
    expect(html).toContain("schedule-panel")
    expect(html).toContain(">Edit<")
    expect(html).toContain(">Disable<") // enabled → offers Disable
    expect(html).toContain(">Run now<")
    expect(html).toContain(">Delete<")
    // Two-step confirm: the "Confirm delete" label is NOT present at rest.
    expect(html).not.toContain("Confirm delete")
    // Recurrence rendered in words; prompt shown.
    expect(html).toContain("every 20m")
    expect(html).toContain("check the web for Fable 5")
  })

  it("offers Enable (not Disable) when the schedule is paused", () => {
    const html = renderToStaticMarkup(
      <SchedulePanel {...baseProps} enabled={false} nextRunAt={null} runHistory={[]} />,
    )
    expect(html).toContain(">Enable<")
    expect(html).not.toContain(">Disable<")
    expect(html).toContain("chip-paused")
    // describeNext → "paused" for a disabled schedule.
    expect(html).toContain("paused")
  })

  it("shows the empty-history placeholder when there are no runs", () => {
    const html = renderToStaticMarkup(<SchedulePanel {...baseProps} runHistory={[]} />)
    expect(html).toContain("Run history (0)")
    expect(html).toContain("No runs yet")
  })
})

describe("SchedulePanel — run history per-status tinting", () => {
  it("tints each status class (ok/error/timeout/killed/skipped-*) correctly", () => {
    const runHistory = [
      { at: new Date().toISOString(), status: "ok", durationMs: 3200, note: "found a hit" },
      { at: new Date().toISOString(), status: "error", note: "boom" },
      { at: new Date().toISOString(), status: "timeout", durationMs: 1_800_000 },
      { at: new Date().toISOString(), status: "killed" },
      { at: new Date().toISOString(), status: "skipped-overlap" },
      { at: new Date().toISOString(), status: "skipped-missed" },
    ]
    const html = renderToStaticMarkup(<SchedulePanel {...baseProps} runHistory={runHistory} />)
    expect(html).toContain("Run history (6)")
    // ok → tone-ok; error/timeout/killed → tone-error; skipped-* → tone-skipped.
    expect(html).toContain("tone-ok")
    expect(html).toContain("tone-error")
    expect(html).toContain("tone-skipped")
    // Prettier skipped labels + the note payloads.
    expect(html).toContain("skipped · overlap")
    expect(html).toContain("skipped · missed")
    expect(html).toContain("found a hit")
    // Duration formatting: 3200ms → "3s"; 30-min timeout → "30m".
    expect(html).toContain(">3s<")
    expect(html).toContain(">30m<")
  })

  it("renders without ANY callbacks — degrades gracefully (api-less harness render)", () => {
    // The click DECISIONS are exhaustively covered in src/lib/scheduleActions.test.ts
    // (the panel is a thin shell over that pure machine — SSR can't click). What THIS
    // render proves: with no api-derived callbacks at all, the panel still renders its
    // full static surface and never throws (mirrors RecallPanel's negative control).
    const html = renderToStaticMarkup(<SchedulePanel {...baseProps} runHistory={[]} />)
    expect(html).toContain("schedule-panel-actions")
    expect(html).toContain(">Edit<")
    expect(html).toContain(">Run now<")
    expect(html).toContain(">Delete<")
  })
})
