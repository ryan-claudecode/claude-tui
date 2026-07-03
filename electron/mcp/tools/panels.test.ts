import { describe, it, expect } from "vitest"
import { z } from "zod"
import { registerPanelTools } from "./panels"
import type { PanelService } from "../../services/panels"
import type { NotesService } from "../../services/notes"
import type { FileService } from "../../services/files"
import type { TerminalService } from "../../services/terminals"
import type { TerminalIdentity } from "./shared"

/**
 * CAPP-107 — ask_user → show_form composition. A fake McpServer captures each tool's
 * schema + handler; a fake PanelService captures the showForm call and lets the test
 * resolve the pending promise by hand (modeling the user submitting the question form).
 * Asserts: the composed form shape (kind:"question" + option handling), the 2-8 options
 * validation, the blocking resolve round-trip (selected labels + free text, verbatim),
 * a free-text-only question, and cancellation.
 */

function fakeServer() {
  const tools: Record<string, { schema: Record<string, z.ZodTypeAny>; handler: (a: any) => Promise<any> }> = {}
  const server = {
    tool: (name: string, _d: string, schema: any, handler: (a: any) => any) => {
      tools[name] = { schema, handler }
    },
  }
  return { server, tools }
}

/** A PanelService stub that captures the showForm args and hands back a resolver. */
function fakePanels() {
  let lastCall: { props: any; position?: string; origin: any } | undefined
  let resolver: ((d: Record<string, any>) => void) | undefined
  const panels = {
    showForm(props: any, position: string | undefined, origin: any) {
      lastCall = { props, position, origin }
      return new Promise<Record<string, any>>((res) => {
        resolver = res
      })
    },
  } as unknown as PanelService
  return {
    panels,
    getCall: () => lastCall,
    resolve: (d: Record<string, any>) => resolver!(d),
  }
}

function register(panels: PanelService, identity: TerminalIdentity = {}) {
  const { server, tools } = fakeServer()
  registerPanelTools(
    server as any,
    panels,
    {} as unknown as NotesService,
    {} as unknown as FileService,
    {} as unknown as TerminalService,
    identity,
  )
  return tools
}

describe("ask_user — options schema validation (2-8)", () => {
  it("accepts omitted options, and 2..8 options; rejects <2 or >8", () => {
    const tools = register(fakePanels().panels)
    const schema = z.object(tools.ask_user.schema)

    expect(schema.safeParse({ question: "Q?" }).success).toBe(true) // options optional
    expect(schema.safeParse({ question: "Q?", options: ["a", "b"] }).success).toBe(true)
    expect(schema.safeParse({ question: "Q?", options: Array(8).fill("x") }).success).toBe(true)

    expect(schema.safeParse({ question: "Q?", options: ["only-one"] }).success).toBe(false)
    expect(schema.safeParse({ question: "Q?", options: Array(9).fill("x") }).success).toBe(false)
    expect(schema.safeParse({ options: ["a", "b"] }).success).toBe(false) // question required
  })
})

describe("ask_user — showForm composition + blocking round-trip", () => {
  it("composes a kind:'question' form attributed to the caller's identity", async () => {
    const env = fakePanels()
    const tools = register(env.panels, { sessionId: "s1", terminalId: "t1" })

    const p = tools.ask_user.handler({
      question: "Deploy to prod now?",
      options: ["Yes", "No"],
      context: "prod is live",
    })

    const call = env.getCall()!
    expect(call.props).toMatchObject({
      kind: "question",
      question: "Deploy to prod now?",
      context: "prod is live",
      options: ["Yes", "No"],
      multiSelect: false,
      allowFreeText: false,
    })
    // Attributed to the caller's bound identity (drives the tier-1 attention entry).
    expect(call.origin).toEqual({ sessionId: "s1", terminalId: "t1" })

    // The user picks an option → the tool resolves with the verbatim label.
    env.resolve({ options: ["Yes"], text: "" })
    const res = await p
    expect(JSON.parse(res.content[0].text)).toEqual({
      answer: "Yes",
      selected: ["Yes"],
      free_text: undefined,
    })
  })

  it("multi-select + free text combine, verbatim", async () => {
    const env = fakePanels()
    const tools = register(env.panels)

    const p = tools.ask_user.handler({
      question: "Which areas?",
      options: ["api", "ui", "db"],
      multi_select: true,
      allow_free_text: true,
    })
    expect(env.getCall()!.props).toMatchObject({ multiSelect: true, allowFreeText: true })

    env.resolve({ options: ["api", "db"], text: "docs" })
    const res = await p
    expect(JSON.parse(res.content[0].text)).toEqual({
      answer: "api, db, docs",
      selected: ["api", "db"],
      free_text: "docs",
    })
  })

  it("with no options → free-text implied on; trims the answer", async () => {
    const env = fakePanels()
    const tools = register(env.panels)

    const p = tools.ask_user.handler({ question: "What should we name it?" })
    expect(env.getCall()!.props.options).toBeUndefined()
    expect(env.getCall()!.props.allowFreeText).toBe(true)

    env.resolve({ options: [], text: "  Nimbus  " })
    const res = await p
    expect(JSON.parse(res.content[0].text)).toEqual({
      answer: "Nimbus",
      selected: [],
      free_text: "Nimbus",
    })
  })

  it("cancellation resolves { cancelled: true }", async () => {
    const env = fakePanels()
    const tools = register(env.panels)

    const p = tools.ask_user.handler({ question: "Proceed?", options: ["Yes", "No"] })
    env.resolve({ cancelled: true })
    const res = await p
    expect(JSON.parse(res.content[0].text)).toEqual({ cancelled: true })
  })

  it("NIT 2 — duplicate options are de-duped (order preserved) before rendering", async () => {
    const env = fakePanels()
    const tools = register(env.panels)

    const p = tools.ask_user.handler({
      question: "Pick one",
      options: ["Yes", "No", "Yes", "Maybe"],
    })
    expect(env.getCall()!.props.options).toEqual(["Yes", "No", "Maybe"])
    expect(env.getCall()!.props.allowFreeText).toBe(false)
    env.resolve({ options: ["No"], text: "" })
    await p
  })

  it("NIT 2 — a single-item post-dedupe list falls back to free-text-implied (like no options)", async () => {
    const env = fakePanels()
    const tools = register(env.panels)

    const p = tools.ask_user.handler({
      question: "Pick one",
      options: ["Yes", "Yes"], // passes the 2-8 schema, collapses to 1 unique
    })
    expect(env.getCall()!.props.options).toBeUndefined()
    expect(env.getCall()!.props.allowFreeText).toBe(true)
    env.resolve({ options: [], text: "fine" })
    const res = await p
    expect(JSON.parse(res.content[0].text)).toEqual({
      answer: "fine",
      selected: [],
      free_text: "fine",
    })
  })
})
