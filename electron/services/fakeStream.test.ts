import { describe, it, expect } from "vitest"
import { assistantExpandUseful } from "@ryanhartwig/claude-agent-kit/core"
import { REPLY_TEXT } from "./fakeStream"

// CAPP-119 review (finding 4) — the e2e ↔ fixture LINKING PIN. The CAPP-111 spec
// (e2e/structured.spec.ts, "CAPP-111 / S4") drives a fakeStream turn and CLICKS the
// settled assistant block's `.agent-block-expand` — a button that only renders because
// the canned REPLY_TEXT passes the usefulness gate (it carries a fenced code block).
// If the fixture or the gate ever drift apart, this pin fails FIRST in the fast unit
// suite instead of as an opaque e2e timeout. Lives app-side because fakeStream does.
describe("fakeStream ↔ usefulness-gate linking pin (CAPP-119 review)", () => {
  it("the canned fake reply passes assistantExpandUseful (the CAPP-111 e2e depends on it)", () => {
    expect(assistantExpandUseful(REPLY_TEXT)).toBe(true)
  })
})
