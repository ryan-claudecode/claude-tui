import { describe, it, expect } from "vitest"
import { existsSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

// The kit is a `file:` link to a SIBLING checkout, and the app resolves it through
// the package's `exports` map to BUILT `dist/` — never to kit source. npm does not
// build a `file:` link, so a kit edit that is not rebuilt silently runs the OLD code
// here, and a green app suite then proves nothing. `npm test` chains `kit:build`
// first; this pin is what makes that guard self-verifying: it fails whenever the
// newest kit source file is newer than the newest built output. Skipped when the
// sibling checkout is absent (a git-tag consumer has only `dist/`).
const KIT = resolve(__dirname, "../../../claude-agent-kit")

function newestUnder(dir: string, skip: RegExp): number {
  let newest = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()!
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (!skip.test(e.name)) newest = Math.max(newest, statSync(p).mtimeMs)
    }
  }
  return newest
}

describe("kit freshness — built dist/ is at least as new as kit source", () => {
  it.skipIf(!existsSync(join(KIT, "src")))(
    "no file under ../claude-agent-kit/src is newer than the newest file under dist/",
    () => {
      const src = newestUnder(join(KIT, "src"), /\.(test|fixtures)\.tsx?$/)
      const dist = existsSync(join(KIT, "dist")) ? newestUnder(join(KIT, "dist"), /^$/) : 0
      expect(dist, "kit dist/ is older than kit src/ — run the kit's `npm run build` (npm test chains kit:build; `vitest` alone does not)").toBeGreaterThanOrEqual(src)
    },
  )
})
