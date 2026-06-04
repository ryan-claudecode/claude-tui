/**
 * UrlService — the no-shell URL toolkit: break a URL into its parts (with the
 * query already parsed into an object and the path split into segments), build
 * a URL back up from parts, and parse/stringify query strings on their own.
 * Pure and stateless, backed by the WHATWG URL / URLSearchParams APIs.
 * (For percent-encoding a single value, use the encode tools' url op.)
 */

export interface UrlParts {
  href: string
  protocol: string
  username: string
  password: string
  host: string
  hostname: string
  port: string
  pathname: string
  search: string
  hash: string
  origin: string
  query: Record<string, string | string[]>
  pathSegments: string[]
}

export interface UrlBuildInput {
  protocol?: string
  hostname?: string
  port?: string | number
  pathname?: string
  query?: Record<string, string | number | boolean | Array<string | number | boolean>>
  hash?: string
  username?: string
  password?: string
}

export class UrlService {
  /** Break a URL into all its components, with the query parsed into an object. */
  parse(url: string): UrlParts {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      throw new Error(`Invalid URL: ${url}`)
    }
    return {
      href: u.href,
      protocol: u.protocol,
      username: u.username,
      password: u.password,
      host: u.host,
      hostname: u.hostname,
      port: u.port,
      pathname: u.pathname,
      search: u.search,
      hash: u.hash,
      origin: u.origin,
      query: this.searchToObject(u.searchParams),
      pathSegments: u.pathname.split("/").filter(Boolean),
    }
  }

  /** Assemble a URL string from parts. Requires at least protocol + hostname. */
  build(parts: UrlBuildInput): { href: string } {
    if (!parts.protocol || !parts.hostname) {
      throw new Error("build requires at least 'protocol' and 'hostname'")
    }
    const proto = parts.protocol.replace(/:$/, "")
    const u = new URL(`${proto}://${parts.hostname}`)
    if (parts.port !== undefined && parts.port !== "") u.port = String(parts.port)
    if (parts.username) u.username = parts.username
    if (parts.password) u.password = parts.password
    if (parts.pathname) u.pathname = parts.pathname
    if (parts.hash) u.hash = parts.hash
    if (parts.query) {
      for (const [k, v] of Object.entries(parts.query)) {
        if (Array.isArray(v)) v.forEach((item) => u.searchParams.append(k, String(item)))
        else u.searchParams.set(k, String(v))
      }
    }
    return { href: u.href }
  }

  /**
   * Parse a query string (with or without a leading '?') into an object.
   * Repeated keys collapse into an array.
   */
  parseQuery(query: string): { query: Record<string, string | string[]> } {
    const qs = query.startsWith("?") ? query.slice(1) : query
    return { query: this.searchToObject(new URLSearchParams(qs)) }
  }

  /** Serialize an object into a query string (no leading '?'). */
  buildQuery(obj: Record<string, string | number | boolean | Array<string | number | boolean>>): {
    query: string
  } {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) v.forEach((item) => params.append(k, String(item)))
      else params.set(k, String(v))
    }
    return { query: params.toString() }
  }

  private searchToObject(params: URLSearchParams): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {}
    for (const key of new Set(params.keys())) {
      const all = params.getAll(key)
      out[key] = all.length > 1 ? all : all[0]
    }
    return out
  }
}
