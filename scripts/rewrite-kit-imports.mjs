// Rewrites RELATIVE imports of modules that moved into @ryanhartwig/claude-agent-kit.
//
//   node scripts/rewrite-kit-imports.mjs scripts/kit-moves.phase1.json
//
// The map's keys are repo-relative module paths WITHOUT extension (the file that
// moved); values are the package specifier that now provides it. For every .ts/.tsx
// under electron/, src/, e2e/, each `from "./x"`, `import("./x")`, or `vi.mock("./x")`
// whose resolved target is a key is rewritten to the value. Nothing else is touched,
// so the diff is reviewable as "specifiers only".
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, dirname, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const mapPath = process.argv[2]
if (!mapPath) {
  console.error("usage: node scripts/rewrite-kit-imports.mjs <map.json>")
  process.exit(2)
}
const map = JSON.parse(readFileSync(resolve(root, mapPath), "utf8"))
const norm = (p) => p.replace(/\\/g, "/").toLowerCase()
const moved = new Map(Object.entries(map).map(([k, v]) => [norm(resolve(root, k)), v]))

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(p)
  }
  return out
}

const files = ["electron", "src", "e2e"].flatMap((d) => walk(join(root, d)))
const re = /(from\s+|import\s*\(\s*|vi\.mock\(\s*)(["'])(\.{1,2}\/[^"']+)\2/g
let changed = 0
for (const file of files) {
  const src = readFileSync(file, "utf8")
  const next = src.replace(re, (whole, lead, quote, spec) => {
    const target = norm(resolve(dirname(file), spec)).replace(/\.(ts|tsx|js)$/, "")
    const pkg = moved.get(target)
    return pkg ? `${lead}${quote}${pkg}${quote}` : whole
  })
  if (next !== src) {
    writeFileSync(file, next)
    changed++
    console.log("rewrote", relative(root, file))
  }
}
console.log(`${changed} file(s) rewritten`)
