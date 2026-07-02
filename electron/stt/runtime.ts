import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { dirname, resolve, sep } from "node:path"
import { utilityProcess } from "electron"
import { extract as tarExtract } from "tar-stream"
import unbzip2 from "unbzip2-stream"
import type { SttDeps } from "../services/stt"
import { downloadToFile } from "./download"
import {
  MODEL_ARCHIVE_SHA256,
  MODEL_ARCHIVE_BYTES,
  type SttFromWorker,
  type SttWorkerLike,
} from "./protocol"

/**
 * CAPP-120 (STT-1) — the REAL {@link SttDeps} implementations (electron `utilityProcess`,
 * the hardened streaming download from `download.ts`, a pure-JS `.tar.bz2` extractor, fs
 * helpers). Isolated in its own module — imported ONLY by `ipc.ts` — so the SttService
 * stays pure + hermetically testable (the unit suite injects fakes and never loads
 * electron / native code / the net). The download itself lives in the electron-free
 * `download.ts` so ITS failure paths (review MAJOR 1 + finding 6) are unit-tested too.
 */

/** Wrap an Electron UtilityProcess in the {@link SttWorkerLike} the service drives. */
function createSttWorker(workerPath: string): SttWorkerLike {
  const child = utilityProcess.fork(workerPath, [], {
    serviceName: "claudetui-stt",
    // Keep the worker's stdout/stderr on the parent for crash diagnostics.
    stdio: "inherit",
  })
  return {
    postMessage: (msg) => child.postMessage(msg),
    onMessage: (cb) => {
      child.on("message", (msg: SttFromWorker) => cb(msg))
    },
    onExit: (cb) => {
      child.on("exit", (code: number) => cb(code))
    },
    kill: () => {
      child.kill()
    },
  }
}

function abortError(): Error {
  const e = new Error("aborted")
  e.name = "AbortError"
  return e
}

/**
 * Extract a `.tar.bz2` into `destDir` (pure JS: bunzip2 -> tar entries).
 *
 * Review finding 7 — honors the AbortSignal: an abort destroys the source/bunzip2/tar
 * streams so the promise rejects promptly with an AbortError (cancel stays responsive
 * mid-extract). The temp-dir cleanup on abort/failure is the CALLER's job
 * (SttService.acquire wipes the extraction dir on both paths).
 */
async function extractTarBz2(archivePath: string, destDir: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError()
  mkdirSync(destDir, { recursive: true })
  const root = resolve(destDir)
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const ex = tarExtract()
    const src = createReadStream(archivePath)
    const bz = unbzip2()
    let settled = false
    const done = (err?: Error) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", onAbort)
      if (err) rejectPromise(err)
      else resolvePromise()
    }
    const onAbort = () => {
      const err = abortError()
      // Destroy the whole pipeline so no more entries are written after a cancel.
      try {
        src.destroy(err)
      } catch {
        /* best-effort */
      }
      try {
        bz.destroy(err)
      } catch {
        /* best-effort */
      }
      try {
        ex.destroy(err)
      } catch {
        /* best-effort */
      }
      done(err)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    ex.on("entry", (header, stream, next) => {
      // Path-traversal guard: never let an entry escape destDir.
      const outPath = resolve(root, header.name)
      if (outPath !== root && !outPath.startsWith(root + sep)) {
        stream.resume()
        next(new Error(`unsafe tar entry: ${header.name}`))
        return
      }
      if (header.type === "directory") {
        mkdirSync(outPath, { recursive: true })
        stream.resume()
        stream.on("end", next)
        return
      }
      mkdirSync(dirname(outPath), { recursive: true })
      const ws = createWriteStream(outPath)
      stream.pipe(ws)
      ws.on("finish", next)
      ws.on("error", (e) => done(e))
      stream.on("error", (e) => done(e))
    })
    ex.on("finish", () => done())
    ex.on("error", (e) => done(e))
    src.on("error", (e) => done(e))
    bz.on("error", (e) => done(e))
    src.pipe(bz).pipe(ex)
  })
}

/** Build the real SttDeps (minus modelDir/sttRoot, supplied by the caller). */
export function createSttRuntimeDeps(opts: {
  modelDir: string
  sttRoot: string
  workerPath: string
  logWarn?: (m: string) => void
}): SttDeps {
  return {
    modelDir: opts.modelDir,
    sttRoot: opts.sttRoot,
    spawnWorker: () => createSttWorker(opts.workerPath),
    exists: (p) => existsSync(p),
    ensureDir: (p) => {
      mkdirSync(p, { recursive: true })
    },
    remove: (p) => {
      try {
        rmSync(p, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    },
    rename: (from, to) => renameSync(from, to),
    // Review finding 6 — the archive is PINNED (exact bytes + SHA-256, hashed streaming
    // during the download): a truncated/corrupted/silently-re-uploaded asset fails loudly.
    download: (o) =>
      downloadToFile({
        ...o,
        expectedSha256: MODEL_ARCHIVE_SHA256,
        expectedBytes: MODEL_ARCHIVE_BYTES,
      }),
    extract: extractTarBz2,
    logWarn: opts.logWarn,
  }
}
