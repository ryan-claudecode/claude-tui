import { createHash, randomUUID } from "crypto"
import { readFileSync, statSync } from "fs"

export type HashAlgo = "md5" | "sha1" | "sha256" | "sha512"

export interface JwtParts {
  header: Record<string, unknown>
  payload: Record<string, unknown>
  /** The raw (base64url) signature segment — not verified, just surfaced. */
  signature: string
}

/**
 * EncodeService — the dev "scratchpad" utilities Claude usually reaches for a
 * throwaway terminal one-liner to do: base64/URL encode-decode, hashing,
 * UUIDs, and JWT inspection. Pure, synchronous, no state, no session/renderer
 * changes — the no-shell counterpart to piping text through `base64`/`openssl`.
 */
export class EncodeService {
  base64Encode(text: string): string {
    return Buffer.from(text, "utf8").toString("base64")
  }

  base64Decode(text: string): string {
    return Buffer.from(text, "base64").toString("utf8")
  }

  urlEncode(text: string): string {
    return encodeURIComponent(text)
  }

  urlDecode(text: string): string {
    return decodeURIComponent(text)
  }

  /** Hex digest of a UTF-8 string. */
  hash(text: string, algo: HashAlgo = "sha256"): string {
    return createHash(algo).update(text, "utf8").digest("hex")
  }

  /** Hex digest of a file's bytes. Refuses files > 100MB. Path is pre-resolved by the caller. */
  hashFile(path: string, algo: HashAlgo = "sha256"): { hash: string; bytes: number } {
    const { size } = statSync(path)
    if (size > 100 * 1024 * 1024) {
      throw new Error(`File too large to hash (${size} bytes, max 100MB)`)
    }
    const buf = readFileSync(path)
    return { hash: createHash(algo).update(buf).digest("hex"), bytes: size }
  }

  /** RFC 4122 v4 UUID(s). */
  uuid(count = 1): string[] {
    const n = Math.max(1, Math.min(count, 100))
    return Array.from({ length: n }, () => randomUUID())
  }

  /**
   * Decode (NOT verify) a JWT — split on ".", base64url-decode header + payload.
   * Surfaces the signature segment verbatim. Throws on a malformed token.
   */
  decodeJwt(token: string): JwtParts {
    const parts = token.trim().split(".")
    if (parts.length < 2) {
      throw new Error("Not a JWT — expected at least header.payload segments")
    }
    const decodeSeg = (seg: string): Record<string, unknown> => {
      const json = Buffer.from(seg, "base64url").toString("utf8")
      return JSON.parse(json)
    }
    return {
      header: decodeSeg(parts[0]),
      payload: decodeSeg(parts[1]),
      signature: parts[2] ?? "",
    }
  }
}
