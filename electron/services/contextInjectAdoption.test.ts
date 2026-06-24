import { describe, it, expect } from "vitest"
import {
  buildInjectedContext,
  assembleInjectInput,
  computeContextStamp,
  buildContextDelta,
  type InjectContextInput,
  type InjectSourceEntry,
  type InjectSessionTier,
  type SessionInjectDeps,
} from "./contextInject"

/**
 * CAPP-100 / E2 — the double-load reconcile (split-tiers) + promoted-twin suppression.
 *
 * Pins the HARD INVARIANTS a reviewer probes:
 *   1. NON-adopted inject == BYTE-IDENTICAL to the pre-E2 (no `adopted` field) output.
 *   2. ADOPTED inject == SESSION-ONLY (no workspace instructions / findings).
 *   3. PROMOTED-TWIN: promote N to W, adopt → N (the origin note) is NOT in the inject's
 *      session section (its twin rides the @import), but the workspace findings are STILL
 *      passed in to compute the suppression.
 *   4. The launch stamp + the get_session_context DELTA stay consistent under adoption.
 */

const baseInput: InjectContextInput = {
  instructions: "Always use TypeScript.",
  workspaceFindings: [
    { text: "WS finding alpha", status: "active", createdAt: 100 },
    { text: "WS finding pinned", status: "active", createdAt: 200, pinned: true },
  ],
  session: {
    name: "My Session",
    summary: "Working on the parser.",
    active: [{ text: "session note one" }, { text: "session note two" }],
    ruledOut: [],
  },
}

describe("split-tiers (E2)", () => {
  it("NON-adopted inject is byte-identical to the pre-E2 output (no adopted field)", () => {
    const withoutFlag = buildInjectedContext(baseInput)
    const withFalseFlag = buildInjectedContext({ ...baseInput, adopted: false })
    expect(withFalseFlag).toBe(withoutFlag)
    // It carries BOTH tiers.
    expect(withoutFlag).toContain("Workspace standing instructions")
    expect(withoutFlag).toContain("Durable workspace findings")
    expect(withoutFlag).toContain("WS finding alpha")
    expect(withoutFlag).toContain("This session: My Session")
  })

  it("ADOPTED inject is session-only — no workspace instructions or findings", () => {
    const adopted = buildInjectedContext({ ...baseInput, adopted: true })
    expect(adopted).not.toContain("Workspace standing instructions")
    expect(adopted).not.toContain("Durable workspace findings")
    expect(adopted).not.toContain("WS finding alpha")
    expect(adopted).not.toContain("WS finding pinned")
    // The session tier is ALWAYS present.
    expect(adopted).toContain("This session: My Session")
    expect(adopted).toContain("session note one")
    expect(adopted).toContain("Working on the parser.")
  })

  it("ADOPTED with ONLY a workspace tier (no session) → nothing to inject", () => {
    const out = buildInjectedContext({
      instructions: "Always use TypeScript.",
      workspaceFindings: [{ text: "WS finding", status: "active", createdAt: 1 }],
      adopted: true,
    })
    // No session, and the workspace tier is dropped under adoption → empty payload.
    expect(out).toBe("")
  })
})

describe("promoted-twin suppression survives the session-only build", () => {
  // A finding promoted from session S1 / note N1 exists as BOTH a workspace finding AND the
  // origin session note. Under adoption the workspace twin rides the @import; the origin note
  // MUST be suppressed from the inject's session section (so it shows exactly once).
  const promotedKey = "S1|N1"
  const input: InjectContextInput = {
    instructions: "",
    workspaceFindings: [{ text: "Promoted truth", status: "active", createdAt: 10 }],
    promotedOriginKeys: [promotedKey],
    session: {
      name: "S1",
      summary: "",
      active: [
        { text: "Promoted truth", originKey: promotedKey },
        { text: "Unpromoted note", originKey: "S1|N2" },
      ],
      ruledOut: [],
    },
  }

  it("ADOPTED → the origin note is NOT in the session section (twin in the @import)", () => {
    const out = buildInjectedContext({ ...input, adopted: true })
    // The promoted finding's origin note is suppressed → appears ZERO times in the inject.
    expect(out).not.toContain("Promoted truth")
    // The un-promoted note still shows.
    expect(out).toContain("Unpromoted note")
  })

  it("NON-adopted → the origin note is NOT suppressed (today's behavior, byte-unchanged)", () => {
    const out = buildInjectedContext({ ...input, adopted: false })
    // Non-adopted carries the workspace twin AND the origin note (the pre-existing same-channel
    // shape — suppression is ONLY for the adopted cross-channel case).
    expect(out).toContain("Promoted truth")
    expect(out).toContain("Unpromoted note")
  })
})

describe("assembleInjectInput threads adoption + promotedOriginKeys (E2)", () => {
  const wsEntries: InjectSourceEntry[] = [
    { text: "Promoted truth", status: "active", createdAt: 10, originSessionId: "S1", originNoteId: "N1" },
    { text: "Authored fact", status: "active", createdAt: 20 },
  ]
  const sessionSections: InjectSessionTier = {
    name: "S1",
    summary: "",
    active: [{ text: "Promoted truth", originKey: "S1|N1" }],
    ruledOut: [],
  }
  function deps(adopted: boolean): SessionInjectDeps {
    return {
      workspaceIdOf: () => "ws-1",
      getInstructions: () => "",
      workspaceTierEntries: () => wsEntries,
      getSessionSections: () => sessionSections,
      isAdopted: () => adopted,
    }
  }

  it("derives promotedOriginKeys from the workspace findings' origins", () => {
    const input = assembleInjectInput("S1", deps(true))!
    expect(input.promotedOriginKeys).toContain("S1|N1")
    expect(input.adopted).toBe(true)
  })

  it("a throwing isAdopted is default-SAFE → adopted=false (inject the workspace tier)", () => {
    const d: SessionInjectDeps = {
      ...deps(false),
      isAdopted: () => {
        throw new Error("scan blew up")
      },
    }
    const input = assembleInjectInput("S1", d)!
    expect(input.adopted).toBe(false)
  })

  it("end-to-end: adopted assembly → session-only payload, promoted twin suppressed", () => {
    const input = assembleInjectInput("S1", deps(true))!
    const payload = buildInjectedContext(input)
    expect(payload).not.toContain("Authored fact") // workspace tier dropped
    expect(payload).not.toContain("Promoted truth") // origin note suppressed
  })
})

describe("launch stamp + delta consistency under adoption", () => {
  it("an adopted launch stamp carries no workspace signatures; the delta never resurfaces them", () => {
    const launch: InjectContextInput = { ...baseInput, adopted: true }
    const stamp = computeContextStamp(launch)
    expect(stamp.workspaceSignatures).toHaveLength(0)
    // Even if a workspace finding is ADDED later, the adopted delta must not surface it (it
    // rides the user's @import, not our inject).
    const current: InjectContextInput = {
      ...launch,
      workspaceFindings: [
        ...baseInput.workspaceFindings,
        { text: "brand new ws finding", status: "active", createdAt: 999 },
      ],
    }
    const delta = buildContextDelta(current, stamp)
    expect(delta).not.toContain("brand new ws finding")
    expect(delta).not.toContain("Durable workspace findings")
  })

  it("a non-adopted delta DOES surface a new workspace finding (unchanged behavior)", () => {
    const stamp = computeContextStamp(baseInput)
    const current: InjectContextInput = {
      ...baseInput,
      workspaceFindings: [
        ...baseInput.workspaceFindings,
        { text: "brand new ws finding", status: "active", createdAt: 999 },
      ],
    }
    const delta = buildContextDelta(current, stamp)
    expect(delta).toContain("brand new ws finding")
  })
})
