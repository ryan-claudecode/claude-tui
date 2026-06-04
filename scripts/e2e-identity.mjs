import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"

const port = process.argv[2]
const base = `http://127.0.0.1:${port}/sse`

const connect = async (url) => {
  const c = new Client({ name: "e2e", version: "1.0.0" }, { capabilities: {} })
  await c.connect(new SSEClientTransport(new URL(url)))
  return c
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args })
  return (r.content || []).map((x) => x.text ?? "").join("\n")
}
const log = (...a) => console.log(...a)

// 1) Admin connection (no identity): create a work session + register a terminal ref.
const admin = await connect(base)
const session = JSON.parse(await call(admin, "create_work_session"))
const sid = session.id
const tid = "term-e2e-1"
await call(admin, "register_terminal", { session_id: sid, terminal_id: tid, name: "e2e-term", cwd: "/repo" })
log("created session", sid, "with terminal", tid)

// 2) Identity-bound connection: call set_terminal_activity with NO ids.
const term = await connect(`${base}?sid=${encodeURIComponent(sid)}&tid=${encodeURIComponent(tid)}`)
log("=== set_terminal_activity (no ids) ===")
log(await call(term, "set_terminal_activity", { activity: "running the test suite" }))

log("=== session_note (no ids) ===")
log(await call(term, "session_note", { text: "the bug is a boot race in spawnInto" }))

// 3) Read back via work_session_status with NO id — should default to our session.
log("=== work_session_status (no id) ===")
const status = JSON.parse(await call(term, "work_session_status"))
const ref = status.terminals.find((t) => t.id === tid)
log("terminal activity bound correctly:", ref?.activity === "running the test suite", "->", ref?.activity)
log("note recorded:", status.notes?.[0]?.text)

// 4) get_session_context with NO id.
log("=== get_session_context (no id) ===")
log(await call(term, "get_session_context"))

await admin.close()
await term.close()
process.exit(0)
