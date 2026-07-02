/** Minimal ambient type for the pure-JS `unbzip2-stream` (no bundled @types). */
declare module "unbzip2-stream" {
  import type { Duplex } from "node:stream"
  /** Returns a Duplex that bunzip2-decompresses piped input. */
  export default function unbzip2Stream(): Duplex
}
