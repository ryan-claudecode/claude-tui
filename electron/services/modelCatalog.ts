import { readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { loadVersioned, saveVersioned } from "../persist"
import { logWarn } from "../log"

// ---------------------------------------------------------------------------
// CAPP-133 — the DYNAMIC model catalog.
//
// The CAPP-113 premise ("Claude Code exposes NO dynamic model discovery") was
// true of the *CLI*, but NOT of the platform: `GET /v1/models` enumerates every
// model the caller's account can reach, with a per-model capability tree. The
// hand-maintained MODEL_ALIASES list can therefore stop being the only source of
// truth — it degrades to the ALIAS floor (aliases like `opus`/`sonnet` are a
// Claude Code concept and deliberately absent from the API), while concrete ids
// (`claude-opus-5`, …) and their capabilities are discovered at runtime.
//
// Three invariants, in priority order — every design choice below follows from
// these:
//   1. NEVER BLOCK. The picker renders from the static aliases + the on-disk
//      cache, synchronously. The network fetch is background-only.
//   2. NEVER SHRINK. A failed/expired/unauthenticated fetch leaves the last good
//      cache in place. The catalog is purely ADDITIVE to the alias floor, so the
//      worst case is exactly today's behavior — never worse.
//   3. NEVER THROW. Same best-effort posture as {@link claudeDefaultModel} in
//      config.ts: any read/parse/network/shape miss degrades to "no catalog".
// ---------------------------------------------------------------------------

/** One model as reported by `GET /v1/models`, projected to what the app uses. */
export interface CatalogModel {
  /** The full, pinnable model id (e.g. `claude-opus-5`). */
  id: string
  /** Human label from the API (e.g. "Claude Opus 5"). Display-only. */
  displayName?: string
  /** ISO release date — used to sort newest-first in the picker. */
  createdAt?: string
  /** Context window. */
  maxInputTokens?: number
  /** Output cap. */
  maxTokens?: number
  /** `capabilities.effort.xhigh.supported` — AUTHORITATIVE for the ultracode gate. */
  xhigh: boolean
  /** `capabilities.effort.max.supported`. */
  effortMax: boolean
  /** `capabilities.thinking.types.adaptive.supported`. */
  adaptiveThinking: boolean
}

/** The cached catalog envelope persisted to `~/.claude-tui/model-catalog.json`. */
export interface ModelCatalog {
  /** Epoch ms of the fetch that produced `models` — drives the TTL. */
  fetchedAt: number
  models: CatalogModel[]
}

const CATALOG_FILE = join(homedir(), ".claude-tui", "model-catalog.json")
const SCHEMA_VERSION = 1

/** Default staleness window before a background refresh is attempted (6h). */
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000

const MODELS_URL = "https://api.anthropic.com/v1/models?limit=1000"
const API_VERSION = "2023-06-01"
/** Required alongside a `Bearer` OAuth token (vs an `x-api-key` API key). */
const OAUTH_BETA = "oauth-2025-04-20"

// ---------------------------------------------------------------------------
// Pure helpers (no filesystem, no network) — the Node-testable core
// ---------------------------------------------------------------------------

/** Narrow an unknown to a plain object without throwing. */
function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/** Read `<node>.supported === true` from the capability tree, defaulting false. */
function supported(node: unknown): boolean {
  return obj(node)?.supported === true
}

/**
 * PURE — project a raw `GET /v1/models` payload into {@link CatalogModel}[].
 *
 * Deliberately TOLERANT: the capability tree is a living schema, so every field
 * is optional and any entry without a usable string `id` is dropped rather than
 * failing the whole parse. A malformed payload yields `[]`, which the caller
 * treats as "refresh failed" and therefore keeps the previous cache (invariant 2).
 * Order is preserved — the API already returns newest-first.
 */
export function parseModelsPayload(raw: unknown): CatalogModel[] {
  const data = obj(raw)?.data
  if (!Array.isArray(data)) return []
  const out: CatalogModel[] = []
  for (const entry of data) {
    const m = obj(entry)
    const id = typeof m?.id === "string" ? m.id.trim() : ""
    if (!id) continue
    const caps = obj(m?.capabilities)
    const effort = obj(caps?.effort)
    const thinking = obj(obj(caps?.thinking)?.types)
    out.push({
      id,
      displayName: typeof m?.display_name === "string" ? m.display_name : undefined,
      createdAt: typeof m?.created_at === "string" ? m.created_at : undefined,
      maxInputTokens:
        typeof m?.max_input_tokens === "number" ? m.max_input_tokens : undefined,
      maxTokens: typeof m?.max_tokens === "number" ? m.max_tokens : undefined,
      xhigh: supported(effort?.xhigh),
      effortMax: supported(effort?.max),
      adaptiveThinking: supported(thinking?.adaptive),
    })
  }
  return out
}

/**
 * PURE — the catalog's verdict on whether `model` supports `xhigh` reasoning.
 *
 * Returns `undefined` for an UNKNOWN model (not in the catalog) — the caller must
 * then fall back to the static heuristic. This tri-state is the whole point: an
 * ALIAS (`opus`, `best`) is never in the API's list, so "not found" must mean
 * "I don't know", NOT "unsupported" — collapsing it to false would hide the
 * ultracode toggle for every alias. Matched case-insensitively on the exact id.
 */
export function catalogXhigh(
  model: string | undefined,
  catalog?: readonly CatalogModel[] | null,
): boolean | undefined {
  const m = typeof model === "string" ? model.trim().toLowerCase() : ""
  if (!m || !Array.isArray(catalog)) return undefined
  return catalog.find((c) => c.id.toLowerCase() === m)?.xhigh
}

/** PURE — the discovered ids, newest-first, for merging into the picker list. */
export function catalogIds(catalog?: readonly CatalogModel[] | null): string[] {
  return Array.isArray(catalog) ? catalog.map((c) => c.id) : []
}

// ---------------------------------------------------------------------------
// Credentials — best-effort, read-only, never logged
// ---------------------------------------------------------------------------

/**
 * Best-effort resolve request headers for the Models API. Mirrors the SDK's
 * credential precedence, limited to what we can read WITHOUT prompting:
 *
 *   1. `ANTHROPIC_API_KEY`  → `x-api-key`
 *   2. Claude Code's own OAuth token (`~/.claude/.credentials.json` →
 *      `claudeAiOauth.accessToken`, an `sk-ant-oat01-…`) → `Authorization: Bearer`
 *      plus the `oauth-2025-04-20` beta header, which that grant requires.
 *
 * (2) is what makes this work with ZERO setup for a subscription user: the app
 * already best-effort reads `~/.claude/settings.json` for the default model, so
 * reading the sibling credential file is the same posture and the same trust
 * boundary — the user's own machine, their own token, a read-only GET.
 *
 * We NEVER refresh, rewrite, or log the token: an expired grant simply returns
 * null (Claude Code owns the refresh), and the caller keeps the cached catalog.
 * Returns null when no credential is usable — never throws.
 */
export function resolveModelsAuth(
  env: NodeJS.ProcessEnv = process.env,
  credentialsPath: string = join(homedir(), ".claude", ".credentials.json"),
  now: number = Date.now(),
): Record<string, string> | null {
  const apiKey = typeof env.ANTHROPIC_API_KEY === "string" ? env.ANTHROPIC_API_KEY.trim() : ""
  if (apiKey) {
    return { "x-api-key": apiKey, "anthropic-version": API_VERSION }
  }
  try {
    const raw = JSON.parse(readFileSync(credentialsPath, "utf8"))
    const oauth = obj(obj(raw)?.claudeAiOauth)
    const token = typeof oauth?.accessToken === "string" ? oauth.accessToken.trim() : ""
    if (!token) return null
    // Skip a known-expired grant rather than spending a guaranteed 401. Claude
    // Code refreshes the file in place, so the next tick picks up a fresh token.
    const expiresAt = typeof oauth?.expiresAt === "number" ? oauth.expiresAt : undefined
    if (expiresAt !== undefined && expiresAt <= now) return null
    return {
      Authorization: `Bearer ${token}`,
      "anthropic-version": API_VERSION,
      "anthropic-beta": OAUTH_BETA,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface RefreshResult {
  ok: boolean
  /** Number of models in the catalog after the attempt (0 when never fetched). */
  count: number
  /** Why a refresh did not happen / failed — diagnostic only, never thrown. */
  reason?: "no-credential" | "http-error" | "empty-payload" | "network-error"
}

/**
 * ModelCatalogService — owns the discovered model list + its on-disk cache.
 *
 * Lifecycle: {@link load} synchronously on boot (cheap, local), then
 * {@link maybeRefresh} fire-and-forget. Consumers read {@link list} /
 * {@link supportsXhigh} synchronously and never await the network.
 *
 * All collaborators (fetch, clock, cache path) are injectable so the unit suite
 * stays hermetic — no real HTTP, no real home directory.
 */
export class ModelCatalogService {
  private catalog: ModelCatalog | null = null
  private inflight: Promise<RefreshResult> | null = null

  constructor(
    private readonly opts: {
      cacheFile?: string
      fetchImpl?: typeof fetch
      now?: () => number
      auth?: () => Record<string, string> | null
    } = {},
  ) {}

  private get cacheFile(): string {
    return this.opts.cacheFile ?? CATALOG_FILE
  }

  private get now(): number {
    return (this.opts.now ?? Date.now)()
  }

  /** Read the cached catalog from disk. Best-effort; a miss leaves it empty. */
  load(): ModelCatalog | null {
    try {
      const cached = loadVersioned<ModelCatalog>(this.cacheFile, SCHEMA_VERSION, [])
      if (cached && Array.isArray(cached.models)) this.catalog = cached
    } catch {
      /* best-effort — a corrupt cache is simply "no catalog" */
    }
    return this.catalog
  }

  /** The discovered models (empty when never successfully fetched). */
  list(): CatalogModel[] {
    return this.catalog?.models ?? []
  }

  /** Epoch ms of the last successful fetch, or undefined. */
  fetchedAt(): number | undefined {
    return this.catalog?.fetchedAt
  }

  /**
   * The catalog's xhigh verdict, or `undefined` when the model is unknown (an
   * alias, or a catalog that never loaded) — see {@link catalogXhigh}.
   */
  supportsXhigh(model?: string): boolean | undefined {
    return catalogXhigh(model, this.catalog?.models)
  }

  /** True when the cache is missing or older than `ttlMs`. */
  isStale(ttlMs: number = DEFAULT_TTL_MS): boolean {
    const at = this.catalog?.fetchedAt
    return typeof at !== "number" || this.now - at >= ttlMs
  }

  /** Refresh only when stale. Returns null when the cache was still fresh. */
  async maybeRefresh(ttlMs: number = DEFAULT_TTL_MS): Promise<RefreshResult | null> {
    if (!this.isStale(ttlMs)) return null
    return this.refresh()
  }

  /**
   * Fetch `GET /v1/models` and replace the cache on success.
   *
   * Invariant 2 (NEVER SHRINK) is enforced here: the in-memory catalog and the
   * cache file are written ONLY on a successful, non-empty parse. Every failure
   * path returns a reason and leaves the previous catalog untouched.
   *
   * Concurrent callers share one in-flight request (the boot refresh and a user
   * -triggered refresh can race).
   */
  refresh(): Promise<RefreshResult> {
    if (this.inflight) return this.inflight
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async doRefresh(): Promise<RefreshResult> {
    const headers = (this.opts.auth ?? resolveModelsAuth)()
    if (!headers) return { ok: false, count: this.list().length, reason: "no-credential" }
    const doFetch = this.opts.fetchImpl ?? globalThis.fetch
    try {
      const res = await doFetch(MODELS_URL, { headers })
      if (!res.ok) {
        // Deliberately does NOT log the status body — it can echo auth material.
        logWarn("model-catalog", `models request failed (HTTP ${res.status})`)
        return { ok: false, count: this.list().length, reason: "http-error" }
      }
      const models = parseModelsPayload(await res.json())
      if (!models.length) {
        return { ok: false, count: this.list().length, reason: "empty-payload" }
      }
      this.catalog = { fetchedAt: this.now, models }
      try {
        saveVersioned(this.cacheFile, SCHEMA_VERSION, this.catalog)
      } catch {
        /* an unwritable cache still leaves a valid in-memory catalog */
      }
      return { ok: true, count: models.length }
    } catch {
      // Offline / DNS / TLS — expected and non-fatal; keep the previous catalog.
      return { ok: false, count: this.list().length, reason: "network-error" }
    }
  }
}
