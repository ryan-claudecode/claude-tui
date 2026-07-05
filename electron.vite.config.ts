import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { readFileSync } from "fs"
import { execSync } from "child_process"

const __dirname_ = dirname(fileURLToPath(import.meta.url))

// Build stamp baked into the renderer at build time (Sidebar footer). The git
// hash is what distinguishes "the packaged app I'm running" from "latest main" —
// package.json version alone doesn't move per build. Guarded: a build outside a
// git checkout (or without git on PATH) still succeeds with hash "unknown".
const pkgVersion = JSON.parse(readFileSync(resolve(__dirname_, "package.json"), "utf8")).version as string
let gitHash = "unknown"
try {
  gitHash = execSync("git rev-parse --short HEAD", { cwd: __dirname_, encoding: "utf8" }).trim()
} catch {
  /* not a git checkout — keep "unknown" */
}
const buildDefine = {
  __APP_VERSION__: JSON.stringify(pkgVersion),
  __GIT_HASH__: JSON.stringify(gitHash),
  __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
}

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      rollupOptions: {
        // CAPP-120 (STT-1) — TWO main-process entries: the app (`index`) and the STT
        // recognizer's utility-process worker (`sttWorker`, forked at runtime). Both emit
        // as `<name>.js` into out/main; the app stays `index.js` (package.json `main`).
        input: {
          index: resolve(__dirname_, "electron/main.ts"),
          sttWorker: resolve(__dirname_, "electron/stt/sttWorker.ts"),
        },
        external: [
          "electron",
          "node-pty",
          "@modelcontextprotocol/sdk",
          "@modelcontextprotocol/sdk/server/mcp.js",
          "@modelcontextprotocol/sdk/server/sse.js",
          "zod",
          "raw-body",
          "content-type",
          // CAPP-120 — native ASR addon (asar-unpacked) + the pure-JS .tar.bz2 extractor
          // deps; externalized so they resolve from node_modules at runtime (node-pty precedent).
          "sherpa-onnx-node",
          "tar-stream",
          "unbzip2-stream",
        ],
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      rollupOptions: {
        input: {
          index: resolve(__dirname_, "electron/preload.ts"),
          companion: resolve(__dirname_, "electron/companion-preload.ts"),
        },
        external: ["electron"],
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    root: ".",
    define: buildDefine,
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: {
          main: resolve(__dirname_, "index.html"),
          companion: resolve(__dirname_, "src/companion/index.html"),
        },
      },
    },
    plugins: [react()],
  },
})
