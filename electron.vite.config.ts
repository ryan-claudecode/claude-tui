import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname_ = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: resolve(__dirname_, "electron/main.ts"),
        external: [
          "electron",
          "node-pty",
          "@modelcontextprotocol/sdk",
          "@modelcontextprotocol/sdk/server/mcp.js",
          "@modelcontextprotocol/sdk/server/sse.js",
          "zod",
          "raw-body",
          "content-type",
        ],
        output: {
          format: "cjs",
          entryFileNames: "index.js",
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
