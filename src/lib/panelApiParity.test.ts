import { describe, it, expect } from "vitest"
import type { PanelApiAccessors } from "./panelApi"
import type { MainApi } from "../../electron/preload"
import type { CompanionApi } from "../../electron/companion-preload"

/**
 * CAPP-106 / S1 — the TYPE-PARITY GATE.
 *
 * The shared `PanelContent` switch (`src/components/panels/PanelContent.tsx`) derives every
 * behavior-panel callback from a single `PanelApi`. Two windows must each be able to build it
 * over their native bridge: the companion over `window.companionApi`, and (S2) the main-window
 * ModalHost over `window.api`. The panel-INTERNAL accessors (`PanelApiAccessors` — recall,
 * overview, promote, workspace-memory, export, adoption, inspect) map
 * 1:1 to a RAW bridge method with the SAME signature, and the bridge crosses the preload
 * boundary UNTYPED (`any`), so without a pin a drift (an accessor on one bridge but not the
 * other) compiles clean and only blows up at the call site.
 *
 * This compile-time pin closes that gap: it asserts BOTH `MainApi` (the inferred shape of
 * `electron/preload.ts`'s exposed object) AND `CompanionApi` (`electron/companion-preload.ts`)
 * structurally satisfy every accessor in `PanelApiAccessors`. `tsc -b` FAILS the moment either
 * bridge drops/renames/narrows one — exactly the guard that would have caught F1
 * (`openSessionOverview` / `promoteSessionToWorkspace` having been companion-only). Type-only;
 * no preload runtime is imported. (The caller-WRAPPED member — sendToSession — is excluded
 * by `PanelApiAccessors`; see its doc in panelApi.ts.)
 *
 * Mirrors the `workspaceMemoryViewSync` / `contextInspectorViewSync` parity pins.
 */

/** Compile-time assertion: `T` (a bridge's accessor subset) satisfies `PanelApiAccessors`.
 *  The `extends` constraint fails to compile if any accessor is missing/renamed/narrowed. */
type SatisfiesAccessors<T extends PanelApiAccessors> = T

describe("PanelApi bridge parity (CAPP-106 / S1)", () => {
  it("window.api (MainApi) supplies every PanelApi accessor — F1 guard", () => {
    // `Pick<MainApi, keyof PanelApiAccessors>` fails to compile if MainApi LACKS a key; the
    // `SatisfiesAccessors` constraint fails if a present key has the wrong signature.
    type _MainOk = SatisfiesAccessors<Pick<MainApi, keyof PanelApiAccessors>>
    const _proof: _MainOk extends PanelApiAccessors ? true : never = true
    expect(_proof).toBe(true)
  })

  it("window.companionApi (CompanionApi) supplies every PanelApi accessor", () => {
    type _CompanionOk = SatisfiesAccessors<Pick<CompanionApi, keyof PanelApiAccessors>>
    const _proof: _CompanionOk extends PanelApiAccessors ? true : never = true
    expect(_proof).toBe(true)
  })
})
