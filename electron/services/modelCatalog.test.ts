import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  parseModelsPayload,
  catalogXhigh,
  catalogIds,
  resolveModelsAuth,
  ModelCatalogService,
  type CatalogModel,
} from "./modelCatalog"
import { modelSupportsXhigh, resolveModelOptions, MODEL_ALIASES } from "@ryanhartwig/claude-agent-kit/protocol"

/** A trimmed but SHAPE-FAITHFUL `GET /v1/models` payload (captured from a live call). */
const PAYLOAD = {
  data: [
    {
      type: "model",
      id: "claude-opus-5",
      display_name: "Claude Opus 5",
      created_at: "2026-07-24T00:00:00Z",
      max_input_tokens: 1000000,
      max_tokens: 128000,
      capabilities: {
        effort: { supported: true, xhigh: { supported: true }, max: { supported: true } },
        thinking: { supported: true, types: { adaptive: { supported: true } } },
      },
    },
    {
      type: "model",
      id: "claude-opus-4-6",
      display_name: "Claude Opus 4.6",
      created_at: "2026-02-04T00:00:00Z",
      capabilities: {
        // 4.6 predates xhigh — the API says so explicitly.
        effort: { supported: true, xhigh: { supported: false }, max: { supported: true } },
        thinking: { supported: true, types: { adaptive: { supported: true } } },
      },
    },
    {
      type: "model",
      id: "claude-haiku-4-5-20251001",
      display_name: "Claude Haiku 4.5",
      capabilities: { effort: { supported: false } },
    },
  ],
  has_more: false,
}

const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response

describe("parseModelsPayload", () => {
  it("projects ids and capability flags", () => {
    const models = parseModelsPayload(PAYLOAD)
    expect(models.map((m) => m.id)).toEqual([
      "claude-opus-5",
      "claude-opus-4-6",
      "claude-haiku-4-5-20251001",
    ])
    expect(models[0]).toMatchObject({
      displayName: "Claude Opus 5",
      maxInputTokens: 1000000,
      maxTokens: 128000,
      xhigh: true,
      effortMax: true,
      adaptiveThinking: true,
    })
    expect(models[1].xhigh).toBe(false)
    expect(models[2].xhigh).toBe(false)
    expect(models[2].adaptiveThinking).toBe(false)
  })

  it("is tolerant: drops entries without a usable id, keeps the rest", () => {
    const models = parseModelsPayload({
      data: [{ id: "" }, { id: 42 }, null, "nope", { id: "  claude-x  " }],
    })
    expect(models.map((m) => m.id)).toEqual(["claude-x"])
  })

  it("returns [] for malformed payloads instead of throwing", () => {
    for (const bad of [null, undefined, {}, { data: "nope" }, 7, []]) {
      expect(parseModelsPayload(bad)).toEqual([])
    }
  })
})

describe("catalogXhigh — tri-state", () => {
  const catalog = parseModelsPayload(PAYLOAD)

  it("returns the authoritative flag for a known id (both directions)", () => {
    expect(catalogXhigh("claude-opus-5", catalog)).toBe(true)
    expect(catalogXhigh("claude-opus-4-6", catalog)).toBe(false)
  })

  it("is case/whitespace insensitive", () => {
    expect(catalogXhigh("  CLAUDE-OPUS-5 ", catalog)).toBe(true)
  })

  it("returns undefined (NOT false) for an unknown model — aliases must fall through", () => {
    expect(catalogXhigh("opus", catalog)).toBeUndefined()
    expect(catalogXhigh("best", catalog)).toBeUndefined()
    expect(catalogXhigh("claude-opus-5", null)).toBeUndefined()
    expect(catalogXhigh(undefined, catalog)).toBeUndefined()
  })

  it("catalogIds lists ids in payload order", () => {
    expect(catalogIds(catalog)[0]).toBe("claude-opus-5")
    expect(catalogIds(null)).toEqual([])
  })
})

describe("modelSupportsXhigh + catalog (CAPP-133 regression)", () => {
  const catalog = parseModelsPayload(PAYLOAD)

  it("fixes the false NEGATIVE: claude-opus-5 was hidden from the ultracode gate", () => {
    // The heuristic alone misses it: not a "opus" prefix, no "opus-4" substring.
    expect(modelSupportsXhigh("claude-opus-5")).toBe(false)
    expect(modelSupportsXhigh("claude-opus-5", undefined, catalog)).toBe(true)
  })

  it("fixes the false POSITIVE: claude-opus-4-6 does not support xhigh", () => {
    expect(modelSupportsXhigh("claude-opus-4-6")).toBe(true) // "opus-4" substring
    expect(modelSupportsXhigh("claude-opus-4-6", undefined, catalog)).toBe(false)
  })

  it("leaves ALIASES on the heuristic (they are never in the catalog)", () => {
    expect(modelSupportsXhigh("opus", undefined, catalog)).toBe(true)
    expect(modelSupportsXhigh("best", undefined, catalog)).toBe(true)
    expect(modelSupportsXhigh("sonnet", undefined, catalog)).toBe(false)
  })

  it("is byte-unchanged when no catalog is supplied", () => {
    for (const m of ["opus", "sonnet", "haiku", "claude-opus-4-8", "claude-fable-5", ""]) {
      expect(modelSupportsXhigh(m, undefined, null)).toBe(modelSupportsXhigh(m))
    }
  })
})

describe("resolveModelOptions + discovered ids", () => {
  it("orders aliases, then discovered, then config extra — de-duped", () => {
    const out = resolveModelOptions(["opus", "sonnet"], { extra: ["my-custom"] }, [
      "claude-opus-5",
      "opus", // already an alias — must not duplicate
    ])
    expect(out).toEqual(["opus", "sonnet", "claude-opus-5", "my-custom"])
  })

  it("hidden suppresses a DISCOVERED id just like an alias", () => {
    const out = resolveModelOptions(["opus"], { hidden: ["claude-opus-5"] }, ["claude-opus-5"])
    expect(out).toEqual(["opus"])
  })

  it("is byte-unchanged when no discovered list is supplied", () => {
    expect(resolveModelOptions(MODEL_ALIASES, { extra: ["x"] })).toEqual(
      resolveModelOptions(MODEL_ALIASES, { extra: ["x"] }, null),
    )
  })
})

describe("resolveModelsAuth", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "capp133-auth-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const credsAt = (name: string, body: unknown) => {
    const p = join(dir, name)
    writeFileSync(p, JSON.stringify(body))
    return p
  }

  it("prefers ANTHROPIC_API_KEY as x-api-key", () => {
    const h = resolveModelsAuth({ ANTHROPIC_API_KEY: "sk-ant-test" }, join(dir, "none.json"))
    expect(h).toMatchObject({ "x-api-key": "sk-ant-test", "anthropic-version": "2023-06-01" })
    expect(h).not.toHaveProperty("Authorization")
  })

  it("falls back to the Claude Code OAuth grant with the required beta header", () => {
    const p = credsAt("c.json", {
      claudeAiOauth: { accessToken: "sk-ant-oat01-abc", expiresAt: 5_000 },
    })
    const h = resolveModelsAuth({}, p, 1_000)
    expect(h).toMatchObject({
      Authorization: "Bearer sk-ant-oat01-abc",
      "anthropic-beta": "oauth-2025-04-20",
    })
  })

  it("skips an EXPIRED grant rather than spending a guaranteed 401", () => {
    const p = credsAt("c.json", {
      claudeAiOauth: { accessToken: "sk-ant-oat01-abc", expiresAt: 1_000 },
    })
    expect(resolveModelsAuth({}, p, 5_000)).toBeNull()
  })

  it("returns null (never throws) for missing / malformed / tokenless files", () => {
    expect(resolveModelsAuth({}, join(dir, "missing.json"))).toBeNull()
    writeFileSync(join(dir, "bad.json"), "{not json")
    expect(resolveModelsAuth({}, join(dir, "bad.json"))).toBeNull()
    expect(resolveModelsAuth({}, credsAt("empty.json", { claudeAiOauth: {} }))).toBeNull()
  })
})

describe("ModelCatalogService", () => {
  let dir: string
  let cacheFile: string
  const auth = () => ({ "x-api-key": "k" })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "capp133-svc-"))
    cacheFile = join(dir, "model-catalog.json")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("refreshes, caches to disk, and reloads across instances", async () => {
    const svc = new ModelCatalogService({
      cacheFile,
      auth,
      now: () => 1_000,
      fetchImpl: (async () => okResponse(PAYLOAD)) as unknown as typeof fetch,
    })
    const res = await svc.refresh()
    expect(res).toMatchObject({ ok: true, count: 3 })
    expect(svc.supportsXhigh("claude-opus-5")).toBe(true)
    expect(existsSync(cacheFile)).toBe(true)

    // A fresh instance reads the cache synchronously — no network on boot.
    const reloaded = new ModelCatalogService({ cacheFile })
    reloaded.load()
    expect(reloaded.list().map((m) => m.id)).toContain("claude-opus-5")
    expect(reloaded.fetchedAt()).toBe(1_000)
  })

  it("NEVER SHRINKS: an HTTP error keeps the previous catalog", async () => {
    let reply: () => Response = () => okResponse(PAYLOAD)
    const svc = new ModelCatalogService({
      cacheFile,
      auth,
      fetchImpl: (async () => reply()) as unknown as typeof fetch,
    })
    await svc.refresh()
    expect(svc.list()).toHaveLength(3)

    reply = () => ({ ok: false, status: 401 }) as unknown as Response
    const res = await svc.refresh()
    expect(res).toMatchObject({ ok: false, reason: "http-error", count: 3 })
    expect(svc.list()).toHaveLength(3)
    expect(svc.supportsXhigh("claude-opus-5")).toBe(true)
  })

  it("NEVER SHRINKS: an empty payload keeps the previous catalog", async () => {
    let body: unknown = PAYLOAD
    const svc = new ModelCatalogService({
      cacheFile,
      auth,
      fetchImpl: (async () => okResponse(body)) as unknown as typeof fetch,
    })
    await svc.refresh()
    body = { data: [] }
    const res = await svc.refresh()
    expect(res).toMatchObject({ ok: false, reason: "empty-payload", count: 3 })
    expect(svc.list()).toHaveLength(3)
  })

  it("NEVER THROWS: a network failure is reported, not raised", async () => {
    const svc = new ModelCatalogService({
      cacheFile,
      auth,
      fetchImpl: (async () => {
        throw new Error("ENOTFOUND")
      }) as unknown as typeof fetch,
    })
    await expect(svc.refresh()).resolves.toMatchObject({
      ok: false,
      reason: "network-error",
      count: 0,
    })
  })

  it("reports no-credential without attempting a fetch", async () => {
    let called = 0
    const svc = new ModelCatalogService({
      cacheFile,
      auth: () => null,
      fetchImpl: (async () => {
        called++
        return okResponse(PAYLOAD)
      }) as unknown as typeof fetch,
    })
    expect(await svc.refresh()).toMatchObject({ ok: false, reason: "no-credential" })
    expect(called).toBe(0)
  })

  it("maybeRefresh honors the TTL and isStale tracks the clock", async () => {
    let clock = 10_000
    let calls = 0
    const svc = new ModelCatalogService({
      cacheFile,
      auth,
      now: () => clock,
      fetchImpl: (async () => {
        calls++
        return okResponse(PAYLOAD)
      }) as unknown as typeof fetch,
    })
    expect(svc.isStale(1_000)).toBe(true) // never fetched
    await svc.maybeRefresh(1_000)
    expect(calls).toBe(1)

    expect(await svc.maybeRefresh(1_000)).toBeNull() // still fresh
    expect(calls).toBe(1)

    clock += 5_000
    expect(svc.isStale(1_000)).toBe(true)
    await svc.maybeRefresh(1_000)
    expect(calls).toBe(2)
  })

  it("shares one in-flight request across concurrent refreshes", async () => {
    let calls = 0
    const svc = new ModelCatalogService({
      cacheFile,
      auth,
      fetchImpl: (async () => {
        calls++
        await new Promise((r) => setTimeout(r, 5))
        return okResponse(PAYLOAD)
      }) as unknown as typeof fetch,
    })
    const [a, b] = await Promise.all([svc.refresh(), svc.refresh()])
    expect(calls).toBe(1)
    expect(a).toEqual(b)
  })

  it("a corrupt cache file degrades to an empty catalog", () => {
    writeFileSync(cacheFile, "{{{ not json")
    const svc = new ModelCatalogService({ cacheFile })
    expect(svc.load()).toBeNull()
    expect(svc.list()).toEqual([])
    expect(svc.supportsXhigh("claude-opus-5")).toBeUndefined()
  })
})

describe("CatalogModel type surface", () => {
  it("keeps the picker contract structural (id + xhigh) for streamProtocol", () => {
    const m: CatalogModel = {
      id: "claude-opus-5",
      xhigh: true,
      effortMax: true,
      adaptiveThinking: true,
    }
    expect(modelSupportsXhigh("claude-opus-5", undefined, [m])).toBe(true)
  })
})
