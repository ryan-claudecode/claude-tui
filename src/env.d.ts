/// <reference types="vite/client" />

declare module "*.css" {
  const content: string
  export default content
}

// Build stamp injected by electron.vite.config.ts `define` at build time.
// Absent under vitest (no vite define) — read via `typeof` guards only.
declare const __APP_VERSION__: string
declare const __GIT_HASH__: string
declare const __BUILD_TIME__: string
