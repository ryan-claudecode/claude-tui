// Deploy the packaged unpacked app to the user's Desktop as `ClaudeTUI/`.
//
// electron-builder writes the `--win dir` tree to `dist/win-unpacked` (see
// electron-builder.yml `directories.output: dist`). The owner runs the app from
// `Desktop\ClaudeTUI`, so packaging alone doesn't update what they launch — this
// mirrors the fresh unpacked tree there. Wired as the tail of `npm run package:desktop`
// so "build the app" lands on the Desktop automatically, not in dist/.
//
// The old Desktop copy is removed first so stale files never linger. If the app is
// still running its exe/DLLs are locked and the copy fails — close it and re-run.

import { cpSync, rmSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const src = resolve(process.cwd(), "dist", "win-unpacked")
const dest = join(homedir(), "Desktop", "ClaudeTUI")

if (!existsSync(src)) {
  console.error(
    `[deploy-desktop] ${src} not found — run \`npm run package\` first (or use \`npm run package:desktop\`).`,
  )
  process.exit(1)
}

try {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(src, dest, { recursive: true })
  console.log(`[deploy-desktop] Deployed ${src} -> ${dest}`)
} catch (err) {
  if (err && (err.code === "EBUSY" || err.code === "EPERM")) {
    console.error(
      `[deploy-desktop] Could not write ${dest} — is ClaudeTUI still running? Close it and re-run.`,
    )
  } else {
    console.error(`[deploy-desktop] Failed:`, err)
  }
  process.exit(1)
}
