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

const admin = await connect(base)
const session = JSON.parse(await call(admin, "create_work_session"))
const sid = session.id
const tid = "term-resume-e2e"
await call(admin, "register_terminal", { session_id: sid, terminal_id: tid, name: "e2e", cwd: "/repo" })

const term = await connect(`${base}?sid=${encodeURIComponent(sid)}&tid=${encodeURIComponent(tid)}`)
await call(term, "session_note", { text: "root cause is the boot race" })
await call(term, "set_session_summary", { summary: "Fixing the boot race; root cause found." })

const ctx = await call(term, "get_session_context")
console.log("context primer contains summary:", ctx.includes("boot race"))
console.log("context primer contains finding:", ctx.includes("root cause"))

await admin.close()
await term.close()
process.exit(0)
