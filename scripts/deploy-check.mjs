// Freshness gate for scripts/deploy.cmd.
//
// The silent failure this exists to prevent: agents commit, work gets merged,
// but nobody re-runs `npm run package` — so the double-click deploy ships the
// PREVIOUS build and the fix "doesn't work", with nothing on screen to say why.
//
// Compares the packaged exe's mtime against the newest source file under
// electron/ and src/. Prints one line: "FRESH …", "STALE …", or "UNKNOWN …".
// Exit code 0 = fresh, 1 = stale, 2 = can't tell — deploy.cmd branches on it.
import { statSync, readdirSync } from "node:fs"
import { join } from "node:path"

const EXE = "dist/win-unpacked/ClaudeTUI.exe"
const SRC_DIRS = ["electron", "src"]
const SRC_EXT = /\.(ts|tsx|js|jsx|css|html)$/
const SKIP = new Set(["node_modules", "out", "dist", ".git"])

function newestUnder(dir) {
  let newest = 0
  let newestFile = ""
  let stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue
      const p = join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (SRC_EXT.test(e.name) && !e.name.includes(".test.")) {
        try {
          const m = statSync(p).mtimeMs
          if (m > newest) {
            newest = m
            newestFile = p
          }
        } catch {
          /* ignore unreadable file */
        }
      }
    }
  }
  return { newest, newestFile }
}

let builtAt
try {
  builtAt = statSync(EXE).mtimeMs
} catch {
  console.log(`UNKNOWN no packaged build at ${EXE}`)
  process.exit(2)
}

let newest = 0
let newestFile = ""
for (const d of SRC_DIRS) {
  const r = newestUnder(d)
  if (r.newest > newest) {
    newest = r.newest
    newestFile = r.newestFile
  }
}

if (!newest) {
  console.log("UNKNOWN could not scan sources")
  process.exit(2)
}

const fmt = (ms) => new Date(ms).toLocaleString()
if (newest > builtAt) {
  console.log(`STALE build ${fmt(builtAt)} is older than ${newestFile} (${fmt(newest)})`)
  process.exit(1)
}
console.log(`FRESH build ${fmt(builtAt)} is newer than all sources`)
process.exit(0)
