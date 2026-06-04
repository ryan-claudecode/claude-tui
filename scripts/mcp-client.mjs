// Dev harness: connect to the running ClaudeTUI MCP server as a client and call
// a tool. Lets the outer agent drive/verify the app end-to-end.
//   node scripts/mcp-client.mjs <tool> '<jsonArgs>'
//   node scripts/mcp-client.mjs --list
import { readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"

const cfgPath = join(tmpdir(), "claudetui", "mcp-config.json")
const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"))
const url = cfg.mcpServers.claudetui.url

const [, , tool, argsJson] = process.argv

const client = new Client({ name: "dev-harness", version: "0.1.0" }, { capabilities: {} })
const transport = new SSEClientTransport(new URL(url))
await client.connect(transport)

let code = 0
try {
  if (!tool || tool === "--list") {
    const { tools } = await client.listTools()
    console.log(tools.map((t) => t.name).join("\n"))
  } else {
    // `@path` reads the JSON args from a file (avoids shell-quoting pain).
    const raw = argsJson?.startsWith("@") ? readFileSync(argsJson.slice(1), "utf-8") : argsJson
    const args = raw ? JSON.parse(raw) : {}
    const res = await client.callTool({ name: tool, arguments: args })
    console.log(JSON.stringify(res, null, 2))
  }
} catch (err) {
  console.error("MCP call failed:", err?.message ?? err)
  code = 1
} finally {
  await client.close()
  process.exit(code)
}
