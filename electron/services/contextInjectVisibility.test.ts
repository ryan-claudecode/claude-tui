import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseStreamLine } from "./streamEvents"

vi.mock("../log", () => ({ logWarn: vi.fn(), logError: vi.fn() }))

/**
 * CAPP-96 — VISIBILITY REGRESSION for the auto-load seam.
 *
 * Auto-load injects the curated brain via `--append-system-prompt-file`, which appends to
 * Claude's SYSTEM prompt. The owner-visibility guarantee is that our stream-json reducer
 * never bubbles that text as a turn — only `assistant`/`user` content blocks become
 * `assistant`/`user` events; a `system` line that is NOT `subtype:"init"` yields ZERO
 * events (streamEvents.ts:218-220), and the system prompt itself never appears as a
 * stream line at all. This test pins that property so a future reducer change can't
 * silently start surfacing injected system-prompt content in the renderer.
 *
 * It also asserts the COMMITTED spike NDJSON capture (docs/spikes/) contains the injected
 * sentinel ZERO times across every parsed event — the live evidence the design rested on.
 */
describe("auto-load visibility — the reducer never surfaces a system prompt as a turn", () => {
  it("a non-init `system` line emits ZERO events", () => {
    // The shape Claude Code emits for system housekeeping (hooks/status). Our injected
    // system prompt rides Claude's system context, NOT a stream line; the closest thing
    // that could ever carry it is a non-init system line, which we drop entirely.
    const line = JSON.stringify({
      type: "system",
      subtype: "status",
      // Even if a payload field carried the sentinel, a non-init system line emits nothing.
      note: "AUTOLOAD_SENTINEL_42 should never reach the renderer",
    })
    expect(parseStreamLine(line)).toHaveLength(0)
  })

  it("an `init` system line never echoes injected system-prompt text into a turn", () => {
    // init carries session metadata (model, tools, slash_commands, skills) — NOT the
    // system prompt body. A sentinel embedded only in the (non-modeled) system prompt
    // can't appear in any field the reducer reads.
    const init = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "s1",
      model: "claude-opus-4-8",
      cwd: "/tmp",
      tools: ["Read"],
      slash_commands: ["clear"],
      skills: [],
    })
    const events = parseStreamLine(init)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("init")
    expect(JSON.stringify(events[0])).not.toContain("AUTOLOAD_SENTINEL")
  })

  it("the committed spike NDJSON never surfaces the injected sentinel in ANY parsed event", () => {
    const ndjson = readFileSync(
      join(__dirname, "../../docs/spikes/capp96-append-system-prompt.ndjson"),
      "utf8",
    )
    let liveEvents = 0
    let sentinelHits = 0
    for (const line of ndjson.split("\n")) {
      if (!line.trim()) continue
      for (const e of parseStreamLine(line)) {
        // A real conversation produces init + a result (and assistant_delta blocks). Count
        // them as the liveness signal so the capture can't be a trivially-empty file.
        if (e.kind === "init" || e.kind === "result" || e.kind === "assistant_delta") liveEvents++
        if (JSON.stringify(e).includes("AUTOLOAD_SENTINEL_42")) sentinelHits++
      }
    }
    // The sentinel lives ONLY in the injected system prompt → it appears in NO parsed event.
    expect(sentinelHits).toBe(0)
    // The capture is a real stream (init + a completed turn), not an empty file.
    expect(liveEvents).toBeGreaterThan(0)
  })
})
