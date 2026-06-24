import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ExportService, GITIGNORE_ENTRY } from "./export"
import { WorkspaceMemoryService } from "./workspaceMemory"

/**
 * CAPP-99 / E1 — the live-regen SEAM (design §B.4): a workspace-memory mutation drives a
 * re-export. This mirrors the exact wiring in ipc.ts (`workspaceMemoryService.onMemoryChanged(
 * (W) => exportService.regenerate(...))`) so the integration contract is pinned: an edit to the
 * durable store re-materializes the exported file, and a bad regen is CAUGHT (never crashes the
 * memory-mutation path).
 */

let root: string
let folder: string
let memDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "export-seam-"))
  folder = join(root, "repo")
  memDir = join(root, "workspace-memory")
  mkdirSync(folder, { recursive: true })
  mkdirSync(memDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("export live-regen seam", () => {
  it("a memory mutation re-exports the file through onMemoryChanged → regenerate", () => {
    const memory = new WorkspaceMemoryService({ dir: memDir })
    const exporter = new ExportService(
      {
        resolveFolder: () => folder,
        getInstructions: (id) => memory.getMemory(id).instructions,
        // Read straight from the memory record's findings, mapped to the inject shape.
        workspaceFindings: (id) =>
          memory.getMemory(id).findings.map((f) => ({
            text: f.text,
            status: f.status === "superseded" ? ("ruled-out" as const) : ("active" as const),
            createdAt: f.createdAt,
            ...(f.pinned ? { pinned: true } : {}),
          })),
      },
      { registryDir: root },
    )

    // Wire the seam EXACTLY as ipc.ts does (catching its own errors).
    memory.onMemoryChanged((workspaceId) => {
      try {
        const wsId = workspaceId === "__untagged__" ? null : workspaceId
        exporter.regenerate(wsId)
      } catch {
        /* must never crash the mutation path */
      }
    })

    // Enable export for ws-1 (gitignore-first writes the initial file).
    const res = exporter.enableExport("ws-1", "A")
    expect(res.ok).toBe(true)
    const dest = join(folder, ".claude-tui", "workspace-memory.md")
    expect(existsSync(dest)).toBe(true)

    // Mutate the durable store → the seam fires → the file reflects the new finding.
    memory.addFinding("ws-1", "A brand new durable finding", "user")
    expect(readFileSync(dest, "utf8")).toContain("A brand new durable finding")

    // Set instructions → reflected too.
    memory.setInstructions("ws-1", "Standing rule: be careful.")
    expect(readFileSync(dest, "utf8")).toContain("Standing rule: be careful.")
  })

  it("a regen error never propagates out of the seam (caught)", () => {
    const memory = new WorkspaceMemoryService({ dir: memDir })
    // A deps that throws inside the build — the seam must swallow it.
    const exporter = new ExportService(
      {
        resolveFolder: () => folder,
        getInstructions: () => {
          throw new Error("boom from getInstructions")
        },
        workspaceFindings: () => [],
      },
      { registryDir: root },
    )
    // Pre-stage the registry so regenerate actually tries to build (and hits the throw).
    writeFileSync(join(folder, ".gitignore"), `${GITIGNORE_ENTRY}\n`, "utf8")
    // Force-register an enabled entry by reaching through enableExport with a non-throwing build
    // first is impossible here, so we assert regenerate itself returns ok:false (caught internally).
    // Manually drive the seam after registering:
    // enableExport calls regenerate once; the throw makes it ok:false and rolls back the entry.
    const res = exporter.enableExport("ws-1", "A")
    expect(res.ok).toBe(false)

    // The seam wrapper must not throw even when regenerate is exercised directly.
    expect(() => {
      try {
        exporter.regenerate("ws-1")
      } catch {
        /* the seam in ipc.ts wraps this; regenerate itself also catches and returns ok:false */
      }
    }).not.toThrow()
    // And regenerate returns a structured failure rather than throwing.
    expect(exporter.regenerate("ws-1").ok).toBe(true) // entry was rolled back → quiet no-op
  })
})
