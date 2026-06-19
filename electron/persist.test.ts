import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { loadVersioned, saveVersioned, type Migration } from "./persist"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ctui-persist-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("saveVersioned", () => {
  it("wraps data in a { schemaVersion, data } envelope and writes atomically", () => {
    const file = join(dir, "store.json")
    saveVersioned(file, 1, { hello: "world" })
    const onDisk = JSON.parse(readFileSync(file, "utf-8"))
    expect(onDisk).toEqual({ schemaVersion: 1, data: { hello: "world" } })
    // no leftover tmp file
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it("creates parent directories as needed", () => {
    const file = join(dir, "nested", "deep", "store.json")
    saveVersioned(file, 1, [1, 2, 3])
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ schemaVersion: 1, data: [1, 2, 3] })
  })
})

describe("loadVersioned", () => {
  it("round-trips a v1 file written by saveVersioned", () => {
    const file = join(dir, "store.json")
    saveVersioned(file, 1, { count: 42 })
    const loaded = loadVersioned<{ count: number }>(file, 1, [])
    expect(loaded).toEqual({ count: 42 })
  })

  it("returns undefined for a missing file without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const loaded = loadVersioned(join(dir, "nope.json"), 1, [])
    expect(loaded).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("reads a legacy (envelope-less) file as version 0 and rewrites it as v1 on disk", () => {
    const file = join(dir, "legacy.json")
    // pre-versioning shape: raw JSON, no schemaVersion envelope
    writeFileSync(file, JSON.stringify({ workspaceScanPaths: ["~/ws"] }))
    // identity migration 0→1 (today's shape verbatim)
    const loaded = loadVersioned<{ workspaceScanPaths: string[] }>(file, 1, [(d) => d])
    expect(loaded).toEqual({ workspaceScanPaths: ["~/ws"] })
    // read-repair: file now carries the v1 envelope
    const onDisk = JSON.parse(readFileSync(file, "utf-8"))
    expect(onDisk).toEqual({ schemaVersion: 1, data: { workspaceScanPaths: ["~/ws"] } })
  })

  it("applies a registered 0→1 migration that renames a field to a legacy file", () => {
    const file = join(dir, "rename.json")
    writeFileSync(file, JSON.stringify({ oldName: "v0-value" }))
    const renameField: Migration = (d) => ({ newName: d.oldName })
    const loaded = loadVersioned<{ newName: string }>(file, 1, [renameField])
    expect(loaded).toEqual({ newName: "v0-value" })
    // rewritten in the new shape under the v1 envelope
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
      schemaVersion: 1,
      data: { newName: "v0-value" },
    })
  })

  it("runs a chain of migrations in order for a multi-version jump", () => {
    const file = join(dir, "chain.json")
    writeFileSync(file, JSON.stringify({ n: 1 })) // version 0
    const migrations: Migration[] = [
      (d) => ({ n: d.n + 10 }), // 0 -> 1
      (d) => ({ n: d.n + 100 }), // 1 -> 2
    ]
    const loaded = loadVersioned<{ n: number }>(file, 2, migrations)
    expect(loaded).toEqual({ n: 111 })
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ schemaVersion: 2, data: { n: 111 } })
  })

  it("does not rewrite a file already at the current version", () => {
    const file = join(dir, "current.json")
    saveVersioned(file, 1, { a: 1 })
    const before = readFileSync(file, "utf-8")
    const mtimeBefore = statSync(file).mtimeMs
    // load with a migration that would mutate if it ran — proves it does NOT run
    const exploding: Migration = () => { throw new Error("migration should not run") }
    const loaded = loadVersioned<{ a: number }>(file, 1, [exploding])
    expect(loaded).toEqual({ a: 1 })
    expect(readFileSync(file, "utf-8")).toBe(before)
    expect(statSync(file).mtimeMs).toBe(mtimeBefore)
  })

  it("returns undefined + warns on corrupt JSON and leaves the file untouched", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const file = join(dir, "corrupt.json")
    writeFileSync(file, "{ this is not json ")
    const loaded = loadVersioned(file, 1, [])
    expect(loaded).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    // file left exactly as it was
    expect(readFileSync(file, "utf-8")).toBe("{ this is not json ")
    warn.mockRestore()
  })

  it("loads a newer-than-supported file as-is and warns (forward-compat)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const file = join(dir, "future.json")
    writeFileSync(file, JSON.stringify({ schemaVersion: 5, data: { x: 1 } }))
    const loaded = loadVersioned<{ x: number }>(file, 1, [])
    expect(loaded).toEqual({ x: 1 })
    expect(warn).toHaveBeenCalled()
    // not rewritten / downgraded
    expect(JSON.parse(readFileSync(file, "utf-8")).schemaVersion).toBe(5)
    warn.mockRestore()
  })

  it("treats a missing migration slot as an identity step (envelope-only bump)", () => {
    const file = join(dir, "gap.json")
    writeFileSync(file, JSON.stringify({ raw: true })) // version 0
    // currentVersion 2 but no migrations supplied — each step is identity, so the
    // payload is unchanged and just re-wrapped at the current version.
    const loaded = loadVersioned<{ raw: boolean }>(file, 2, [])
    expect(loaded).toEqual({ raw: true })
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
      schemaVersion: 2,
      data: { raw: true },
    })
  })
})
