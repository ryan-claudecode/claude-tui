import { describe, it, expect } from "vitest"
import {
  BUILTIN_SLASH_COMMANDS,
  buildCatalogEntries,
  buildPickerEntries,
  filterCatalogEntries,
  isCatalogStale,
  slashQuery,
  type CatalogEntry,
} from "./slashCatalog"

describe("buildCatalogEntries — merge slash commands + skills (a unified system)", () => {
  it("dedups a name present in BOTH arrays into one entry", () => {
    const entries = buildCatalogEntries({
      slashCommands: ["clear", "chrome-live"],
      skills: ["chrome-live", "deep-research"],
    })
    const names = entries.map((e) => e.name)
    expect(names).toEqual(["chrome-live", "clear", "deep-research"]) // sorted, deduped
  })

  it("labels skill-backed names as skill and the rest as command", () => {
    const entries = buildCatalogEntries({
      slashCommands: ["clear", "chrome-live"],
      skills: ["chrome-live"],
    })
    const byName = Object.fromEntries(entries.map((e) => [e.name, e.kind]))
    expect(byName["chrome-live"]).toBe("skill")
    expect(byName["clear"]).toBe("command")
  })

  it("tolerates missing / empty / non-string members", () => {
    expect(buildCatalogEntries({ slashCommands: [], skills: [] })).toEqual([])
    expect(buildCatalogEntries(undefined as never)).toEqual([])
    const entries = buildCatalogEntries({
      slashCommands: ["ok", "", null as never, 5 as never],
      skills: [],
    })
    expect(entries.map((e) => e.name)).toEqual(["ok"])
  })
})

describe("buildPickerEntries — the builtin floor (CAPP-126)", () => {
  it("offers the full builtin floor when the catalog is empty/absent", () => {
    const names = buildPickerEntries({ slashCommands: [], skills: [] }).map((e) => e.name)
    expect(names).toEqual([...BUILTIN_SLASH_COMMANDS].sort((a, b) => a.localeCompare(b)))
    // The absent-catalog case degrades to the same floor (never empty).
    expect(buildPickerEntries(undefined).map((e) => e.name)).toEqual(names)
  })

  it("all floor entries are present and labeled as commands", () => {
    const byName = Object.fromEntries(buildPickerEntries(undefined).map((e) => [e.name, e.kind]))
    for (const n of BUILTIN_SLASH_COMMANDS) {
      expect(byName[n]).toBe("command")
    }
  })

  it("de-dupes when the live catalog overlaps a builtin — the LIVE entry wins", () => {
    // "compact" is a builtin; here the catalog reports it as a SKILL. The merged
    // list carries it exactly once, keeping the live (skill) kind.
    const entries = buildPickerEntries({ slashCommands: [], skills: ["compact"] })
    const compacts = entries.filter((e) => e.name === "compact")
    expect(compacts).toHaveLength(1)
    expect(compacts[0].kind).toBe("skill")
  })

  it("unions the live catalog with the floor (both appear, sorted, deduped)", () => {
    const names = buildPickerEntries({
      slashCommands: ["clear"], // overlaps the floor
      skills: ["deep-research"], // live-only skill
    }).map((e) => e.name)
    // floor ∪ {deep-research}; clear appears once.
    expect(names).toEqual(
      [...new Set([...BUILTIN_SLASH_COMMANDS, "deep-research"])].sort((a, b) =>
        a.localeCompare(b),
      ),
    )
  })
})

describe("isCatalogStale — the 'from last session' flag (CAPP-126)", () => {
  it("is stale until a live init has been seen this process", () => {
    expect(isCatalogStale(false)).toBe(true) // no fresh init yet → persisted/builtin
    expect(isCatalogStale(true)).toBe(false) // a live init landed → fresh
  })
})

describe("filterCatalogEntries — case-insensitive, prefix matches first", () => {
  const entries: CatalogEntry[] = [
    { name: "clear", kind: "command" },
    { name: "compact", kind: "command" },
    { name: "context", kind: "command" },
    { name: "unclear", kind: "command" },
  ]

  it("returns all entries for an empty query", () => {
    expect(filterCatalogEntries(entries, "")).toHaveLength(4)
  })

  it("matches by substring, case-insensitive", () => {
    // "co" is a substring of both compact and context (not clear/unclear).
    expect(filterCatalogEntries(entries, "CO").map((e) => e.name)).toEqual([
      "compact",
      "context",
    ])
  })

  it("ranks prefix matches above mid-string matches", () => {
    // "clear" (prefix) ranks before "unclear" (substring) for query "cl".
    expect(filterCatalogEntries(entries, "cl").map((e) => e.name)).toEqual([
      "clear",
      "unclear",
    ])
  })
})

describe("slashQuery — picker visibility + the live query", () => {
  it("returns the in-progress token after a leading slash", () => {
    expect(slashQuery("/")).toBe("")
    expect(slashQuery("/con")).toBe("con")
    expect(slashQuery("  /con")).toBe("con")
  })

  it("returns null once the command token is complete (a space was typed)", () => {
    expect(slashQuery("/config ")).toBeNull()
    expect(slashQuery("/clear now")).toBeNull()
  })

  it("returns null for non-slash text", () => {
    expect(slashQuery("")).toBeNull()
    expect(slashQuery("hello")).toBeNull()
  })
})
