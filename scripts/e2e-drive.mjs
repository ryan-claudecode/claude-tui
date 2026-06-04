import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { writeFileSync } from "fs"

const port = process.argv[2]
const url = new URL(`http://127.0.0.1:${port}/sse`)

const client = new Client({ name: "e2e-driver", version: "1.0.0" }, { capabilities: {} })
const transport = new SSEClientTransport(url)
await client.connect(transport)

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  const txt = (r.content || []).map((c) => c.text ?? "").join("\n")
  return txt
}

const log = (...a) => console.log(...a)

// 1. Initial state — should be zero terminals (lazy spawn)
log("=== INITIAL STATE ===")
log(await call("get_app_state"))

// 2. Screenshot of the empty two-tier UI
const shot = async (file) => {
  const r = await client.callTool({ name: "take_screenshot", arguments: {} })
  const img = (r.content || []).find((c) => c.type === "image")
  if (img) { writeFileSync(file, Buffer.from(img.data, "base64")); log("saved", file) }
  else log("no image:", JSON.stringify(r.content))
}
log("=== SCREENSHOT (empty) ===")
await shot("scripts/shot-empty.png")

await client.close()
process.exit(0)
