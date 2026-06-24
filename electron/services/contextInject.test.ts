import { describe, it, expect } from "vitest"
import {
  buildInjectedContext,
  byteLength,
  RESUME_POINTER,
  computeContextStamp,
  buildContextDelta,
  NO_DELTA_HEADER,
  type InjectContextInput,
  type InjectWorkspaceFinding,
  type InjectSessionTier,
} from "./contextInject"

/**
 * CAPP-96 (Slice 1) — the pure auto-load payload builder. These tests pin the markdown
 * shape (design §B.1), the resume-vs-fresh fork (DECISION 6), the byte cap + value-ordered
 * truncation (§B.3 — pinned never evicted, active findings oldest-first), the per-item caps,
 * and the omission marker.
 */

function wf(text: string, extra: Partial<InjectWorkspaceFinding> = {}): InjectWorkspaceFinding {
  return { text, status: "active", createdAt: 1000, ...extra }
}

describe("buildInjectedContext — shape", () => {
  it("renders both tiers with the labeled headers + the launch-snapshot header", () => {
    const session: InjectSessionTier = {
      name: "Refactor auth",
      summary: "Migrating to JWT.",
      active: [{ text: "Tokens live in httpOnly cookies" }],
      ruledOut: [{ text: "localStorage tokens", correction: "XSS-prone, use cookies" }],
    }
    const out = buildInjectedContext({
      instructions: "Always run the gate before commit.",
      workspaceFindings: [wf("DB pool maxes at 20")],
      session,
    })
    expect(out).toContain("# Context for this session")
    expect(out).toContain("call get_session_context for the live view")
    expect(out).toContain("## Workspace standing instructions")
    expect(out).toContain("Always run the gate before commit.")
    expect(out).toContain("## Durable workspace findings")
    expect(out).toContain("- DB pool maxes at 20")
    expect(out).toContain("## This session: Refactor auth")
    expect(out).toContain("### Summary")
    expect(out).toContain("Migrating to JWT.")
    expect(out).toContain("### Findings")
    expect(out).toContain("- Tokens live in httpOnly cookies")
    expect(out).toContain("### Ruled out / corrected")
    expect(out).toContain("- ~~localStorage tokens~~ → XSS-prone, use cookies")
  })

  it("marks a pinned finding with 📌 and renders ruled-out workspace findings struck-through", () => {
    const out = buildInjectedContext({
      instructions: "",
      workspaceFindings: [
        wf("NEVER kill inferred processes", { pinned: true }),
        wf("old API was REST", { status: "ruled-out", correction: "now GraphQL" }),
      ],
    })
    expect(out).toContain("- 📌 NEVER kill inferred processes")
    expect(out).toContain("- ~~old API was REST~~ → now GraphQL")
  })

  it("omits an empty instructions section and an empty session tier", () => {
    const out = buildInjectedContext({
      instructions: "   ",
      workspaceFindings: [wf("only a finding")],
    })
    expect(out).not.toContain("## Workspace standing instructions")
    expect(out).not.toContain("## This session")
    expect(out).toContain("- only a finding")
  })

  it("returns '' when there is nothing durable to inject (fresh spawn)", () => {
    expect(buildInjectedContext({ instructions: "", workspaceFindings: [] })).toBe("")
    expect(
      buildInjectedContext({
        instructions: "",
        workspaceFindings: [],
        session: { name: "x", summary: "", active: [], ruledOut: [] },
      }),
    ).toBe("")
  })
})

describe("buildInjectedContext — resume fork (DECISION 6)", () => {
  it("returns the SHORT pointer on resume, ignoring all data", () => {
    const out = buildInjectedContext(
      {
        instructions: "lots of standing context here",
        workspaceFindings: [wf("a"), wf("b")],
        session: { name: "S", summary: "big summary", active: [{ text: "x" }], ruledOut: [] },
      },
      { resume: true },
    )
    expect(out).toBe(RESUME_POINTER)
    expect(out).toContain("Durable context may have changed")
    expect(out).toContain("get_session_context")
    expect(out).not.toContain("standing context here")
    expect(out).not.toContain("big summary")
  })
})

describe("buildInjectedContext — byte cap + value-ordered truncation (§B.3)", () => {
  it("stays under the cap and emits an omission marker when findings overflow", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      wf(`finding number ${i} with some descriptive padding text to take up bytes`, { createdAt: 1000 + i }),
    )
    const out = buildInjectedContext(
      { instructions: "", workspaceFindings: many },
      { maxBytes: 1024 },
    )
    expect(byteLength(out)).toBeLessThanOrEqual(1024)
    expect(out).toMatch(/older finding(s)? omitted — call get_session_context/)
  })

  it("NEVER evicts a pinned finding, even when unpinned findings are dropped", () => {
    const pinned = wf("PINNED foundational rule", { pinned: true, createdAt: 5000 })
    const filler = Array.from({ length: 100 }, (_, i) =>
      wf(`disposable finding ${i} padded out with extra words to consume budget`, { createdAt: 1000 + i }),
    )
    const out = buildInjectedContext(
      { instructions: "", workspaceFindings: [...filler, pinned] },
      { maxBytes: 700 },
    )
    expect(out).toContain("📌 PINNED foundational rule")
    expect(out).toMatch(/omitted/)
  })

  it("keeps OLDEST active workspace findings first (foundational survive truncation)", () => {
    const oldest = wf("OLDEST foundational finding", { createdAt: 100 })
    const newer = Array.from({ length: 50 }, (_, i) =>
      wf(`newer finding ${i} padded with words to consume the byte budget quickly`, { createdAt: 10000 + i }),
    )
    const out = buildInjectedContext(
      { instructions: "", workspaceFindings: [...newer, oldest] },
      { maxBytes: 600 },
    )
    // The oldest is kept; the newest are the first to be evicted.
    expect(out).toContain("OLDEST foundational finding")
    expect(out).not.toContain("newer finding 49")
  })

  it("caps a single essay-finding so it can't dominate the budget", () => {
    const essay = "word ".repeat(2000) // ~10 KB
    const out = buildInjectedContext({ instructions: "", workspaceFindings: [wf(essay)] })
    expect(byteLength(out)).toBeLessThan(2000)
    expect(out).toContain("…")
  })

  it("caps long instructions to ~1.5 KB", () => {
    const longInstr = "x".repeat(5000)
    const out = buildInjectedContext({ instructions: longInstr, workspaceFindings: [] })
    expect(out).toContain("…")
    // The instructions block alone is well under 5 KB after the cap.
    expect(byteLength(out)).toBeLessThan(2500)
  })
})

/**
 * CAPP-97 — the get_session_context DELTA. `computeContextStamp` folds the launch input
 * into finding signatures + the summary/instructions; `buildContextDelta` returns only
 * what changed since (or the stable "no changes" header). Pure over (input, stamp).
 */
describe("computeContextStamp + buildContextDelta (CAPP-97)", () => {
  const session: InjectSessionTier = {
    name: "Refactor auth",
    summary: "Migrating to JWT.",
    active: [{ text: "Tokens live in httpOnly cookies" }],
    ruledOut: [{ text: "localStorage tokens", correction: "XSS-prone" }],
  }
  const launchInput: InjectContextInput = {
    instructions: "Always run the gate before commit.",
    workspaceFindings: [wf("DB pool maxes at 20")],
    session,
  }

  it("returns the stable 'no changes' header when nothing changed since launch", () => {
    const stamp = computeContextStamp(launchInput)
    // Re-assemble an identical input (a fresh object, same content).
    const current: InjectContextInput = {
      instructions: "Always run the gate before commit.",
      workspaceFindings: [wf("DB pool maxes at 20")],
      session: { ...session, active: [...session.active], ruledOut: [...session.ruledOut] },
    }
    expect(buildContextDelta(current, stamp)).toBe(NO_DELTA_HEADER)
  })

  it("surfaces a NEW workspace finding in the delta, nothing else", () => {
    const stamp = computeContextStamp(launchInput)
    const current: InjectContextInput = {
      ...launchInput,
      workspaceFindings: [wf("DB pool maxes at 20"), wf("New: cache TTL is 60s")],
    }
    const delta = buildContextDelta(current, stamp)
    expect(delta).toContain("# Context updates since launch")
    expect(delta).toContain("New: cache TTL is 60s")
    // The unchanged finding is NOT re-emitted.
    expect(delta).not.toContain("DB pool maxes at 20")
  })

  it("treats an EDITED finding (changed text) as new in the delta", () => {
    const stamp = computeContextStamp(launchInput)
    const current: InjectContextInput = {
      ...launchInput,
      workspaceFindings: [wf("DB pool maxes at 50")], // edited from 20 → 50
    }
    const delta = buildContextDelta(current, stamp)
    expect(delta).toContain("DB pool maxes at 50")
  })

  it("surfaces a changed SUMMARY + a new session finding under the session header", () => {
    const stamp = computeContextStamp(launchInput)
    const current: InjectContextInput = {
      ...launchInput,
      session: {
        ...session,
        summary: "Migrating to JWT — phase 2 done.",
        active: [{ text: "Tokens live in httpOnly cookies" }, { text: "Refresh tokens rotate" }],
      },
    }
    const delta = buildContextDelta(current, stamp)
    expect(delta).toContain("## This session: Refactor auth")
    expect(delta).toContain("phase 2 done")
    expect(delta).toContain("Refresh tokens rotate")
  })

  it("surfaces a newly ruled-out finding (a status flip reads as a changed signature)", () => {
    // Launch: an ACTIVE finding. Current: it's now ruled-out → its signature changed.
    const launch: InjectContextInput = {
      instructions: "",
      workspaceFindings: [wf("use library X")],
    }
    const stamp = computeContextStamp(launch)
    const current: InjectContextInput = {
      instructions: "",
      workspaceFindings: [{ ...wf("use library X"), status: "ruled-out", correction: "deprecated" }],
    }
    const delta = buildContextDelta(current, stamp)
    expect(delta).toContain("~~use library X~~")
    expect(delta).toContain("deprecated")
  })
})
