import { describe, it, expect } from "vitest"
import { pickActivePanel } from "./modalActivePanel"
import type { PanelLike } from "../components/panels/PanelContent"

/**
 * CAPP-109 / S2 — form-exclusivity unit tests for the ModalHost active-panel pick.
 *
 * The load-bearing rule: a visible `form` panel WINS the active slot regardless of
 * recency or explicit tab selection, so a later `show_panel` can NEVER silently
 * unmount a pending form (which would hang the MCP `show_form` call forever — it'd
 * have a tab but no way to be the active mounted panel without this rule).
 */

const p = (id: string, type: string): PanelLike => ({ id, type, props: {} })

describe("pickActivePanel — form exclusivity (CAPP-109 / S2)", () => {
  it("returns null for an empty visible set", () => {
    expect(pickActivePanel([])).toBeNull()
  })

  it("picks the most-recent (last) panel when there is no form", () => {
    const visible = [p("panel-1", "markdown"), p("panel-2", "diff"), p("panel-3", "table")]
    expect(pickActivePanel(visible)?.id).toBe("panel-3")
  })

  it("FORM WINS over a more-recent non-form panel (the M2 strand-guard)", () => {
    // show_form first, then a later show_panel(markdown). The markdown is most-recent,
    // but the form must stay active.
    const visible = [p("panel-1", "form"), p("panel-2", "markdown")]
    expect(pickActivePanel(visible)?.id).toBe("panel-1")
  })

  it("FORM WINS even when the markdown is explicitly tab-selected", () => {
    // The user clicked the markdown tab (preferredId), but a pending form is a blocking
    // obligation — it still takes the active slot. (It always has its own tab to return to.)
    const visible = [p("panel-1", "form"), p("panel-2", "markdown")]
    expect(pickActivePanel(visible, "panel-2")?.id).toBe("panel-1")
  })

  it("honors an explicit tab selection when no form is visible", () => {
    const visible = [p("panel-1", "markdown"), p("panel-2", "diff"), p("panel-3", "table")]
    expect(pickActivePanel(visible, "panel-1")?.id).toBe("panel-1")
  })

  it("ignores a stale preferredId that no longer points at a visible panel", () => {
    const visible = [p("panel-2", "diff"), p("panel-3", "table")]
    // panel-1 was closed; fall back to most-recent.
    expect(pickActivePanel(visible, "panel-1")?.id).toBe("panel-3")
  })

  it("when multiple forms stack, the OLDEST (first-shown) drains first", () => {
    const visible = [p("panel-1", "markdown"), p("panel-2", "form"), p("panel-3", "form")]
    expect(pickActivePanel(visible)?.id).toBe("panel-2")
  })
})
