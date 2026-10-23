import { describe, it, expect } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

// `streamEvents.fixtures.ts` — the AUTHORITATIVE live-captured stream-json shapes —
// exists TWICE until Phase 4 moves the parser into the kit: here (for
// streamEvents.test.ts / terminalsHeadless.test.ts) and in the kit's src/engine (for
// the kit's agentTranscript.test.ts, the largest moved test corpus). A new captured
// shape added to one copy only would let the other suite keep folding stale shapes
// and stay green. This pin fails the instant the two copies differ. Skipped when the
// sibling kit checkout is absent.
const APP_COPY = resolve(__dirname, "streamEvents.fixtures.ts")
const KIT_COPY = resolve(__dirname, "../../../claude-agent-kit/src/engine/streamEvents.fixtures.ts")
const lf = (s: string) => s.replace(/\r\n/g, "\n")

describe("streamEvents.fixtures.ts — the app and kit copies are byte-identical (until Phase 4)", () => {
  it.skipIf(!existsSync(KIT_COPY))("app copy === kit copy", () => {
    expect(lf(readFileSync(APP_COPY, "utf8"))).toBe(lf(readFileSync(KIT_COPY, "utf8")))
  })
})
