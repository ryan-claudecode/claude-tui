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
        external: ["node-pty"],
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
        input: resolve(__dirname_, "electron/preload.ts"),
        output: {
          format: "cjs",
          entryFileNames: "index.js",
        },
      },
    },
  },
  renderer: {
    root: ".",
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: resolve(__dirname_, "index.html"),
      },
    },
    plugins: [react()],
  },
})
