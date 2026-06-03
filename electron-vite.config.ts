import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname_ = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname_, "electron/main.ts"),
        external: ["node-pty"],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname_, "electron/preload.ts"),
      },
    },
  },
  renderer: {
    root: ".",
    build: {
      rollupOptions: {
        input: resolve(__dirname_, "index.html"),
      },
    },
    plugins: [react()],
  },
})
