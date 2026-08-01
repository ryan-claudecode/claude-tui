// CAPP-134 — run a HOT-RELOADING dev instance alongside the packaged app.
//
// The whole point: you should not have to close your working copy to rebuild.
// This re-roots the dev instance's entire durable state (config, sessions,
// workspaces, schedules, logs, model catalog, and the MCP config handed to
// spawned agents) to a separate CLAUDE_TUI_HOME, so the two instances cannot
// fight over the same files — or, worse, over the same mcp-config path, which
// previously let one app's agents drive the other app's UI.
//
//   npm run dev:isolated
//
// electron-vite then gives you renderer HMR (no restart) and an automatic
// main-process restart on service/IPC edits. `package:desktop` becomes a rare
// "cut a release" step instead of part of every iteration.
import { spawn } from "child_process"
import { homedir } from "os"
import { join } from "path"
import { existsSync, mkdirSync, copyFileSync } from "fs"

const devHome = process.env.CLAUDE_TUI_HOME || join(homedir(), ".claude-tui-dev")
const realHome = join(homedir(), ".claude-tui")

// FIRST RUN ONLY: seed the preferences that make the instance usable, and
// NOTHING that spawns work. config.json (theme/model/engine prefs) and
// workspaces.json (your folders) are copied; sessions/ and schedules/ are
// deliberately NOT — restoring your real sessions here would spawn a second set
// of live agents against the same repos.
const firstRun = !existsSync(devHome)
if (firstRun) {
  mkdirSync(devHome, { recursive: true })
  for (const f of ["config.json", "workspaces.json"]) {
    const from = join(realHome, f)
    if (existsSync(from)) {
      try {
        copyFileSync(from, join(devHome, f))
        console.log(`[dev-isolated] seeded ${f}`)
      } catch {
        /* best-effort — an unseeded dev instance still boots, just empty */
      }
    }
  }
}

console.log(`[dev-isolated] CLAUDE_TUI_HOME=${devHome}${firstRun ? " (created)" : ""}`)
console.log("[dev-isolated] your packaged app's state is untouched; both can run at once")

const child = spawn("npx", ["electron-vite", "dev"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, CLAUDE_TUI_HOME: devHome },
})
child.on("exit", (code) => process.exit(code ?? 0))
