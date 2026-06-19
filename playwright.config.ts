import { defineConfig } from "@playwright/test"

/**
 * Playwright config for the Electron E2E smoke suite.
 *
 * This suite is intentionally kept OUT of `npm test` (the unit suite) — run it
 * via `npm run e2e`, which builds first (the spec loads the built app from
 * `out/` via the package.json `main` field).
 *
 * Electron is driven via `_electron` (NOT chromium), so no browser download is
 * needed and there are no `projects` / `use.browserName` here.
 */
export default defineConfig({
  testDir: "e2e",
  // Electron is slow to boot; give each test generous headroom.
  timeout: 60_000,
  // The single Electron app instance must not be launched concurrently.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Fail fast in CI if a `.only` was left behind.
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
})
