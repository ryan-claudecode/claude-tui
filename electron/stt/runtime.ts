import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { utilityProcess } from "electron"
import { extract as tarExtract } from "tar-stream"
import unbzip2 from "unbzip2-stream"
import type { SttDeps } from "../services/stt"
import type { SttFromWorker, SttWorkerLike } from "./protocol"

/**
 * CAPP-120 (STT-1) — the REAL {@link SttDeps} implementations (electron `utilityProcess`,
 * a streaming `fetch` download, a pure-JS `.tar.bz2` extractor, fs helpers). Isolated in
 * its own module — imported ONLY by `ipc.ts` — so the SttService stays pure + hermetically
 * testable (the unit suite injects fakes and never loads electron / native code / the net).
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

/** Stream `url` -> `dest`, reporting byte progress, abortable via `signal`. */
async function download(opts: {
  url: string
  dest: string
  signal: AbortSignal
  onProgress: (receivedBytes: number, totalBytes?: number) => void
}): Promise<void> {
  const { url, dest, signal, onProgress } = opts
  const res = await fetch(url, { signal, redirect: "follow" })
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`)
  }
  const lenHeader = res.headers.get("content-length")
  const totalBytes = lenHeader ? Number(lenHeader) : undefined
  mkdirSync(dirname(dest), { recursive: true })
  const out = createWriteStream(dest)
  let received = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal.aborted) throw abortError()
      received += value.byteLength
      // Backpressure: wait for the write to drain before pulling more.
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((r) => out.once("drain", r))
      }
      onProgress(received, totalBytes && Number.isFinite(totalBytes) ? totalBytes : undefined)
    }
    await new Promise<void>((res2, rej) => {
      out.end(() => res2())
      out.on("error", rej)
    })
  } catch (err) {
    out.destroy()
    throw err
  }
}

function abortError(): Error {
  const e = new Error("aborted")
  e.name = "AbortError"
  return e
}

/** Extract a `.tar.bz2` into `destDir` (pure JS: bunzip2 -> tar entries). */
async function extractTarBz2(archivePath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true })
  const root = resolve(destDir)
  await new Promise<void>((resolvePromise, reject) => {
    const ex = tarExtract()
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
      ws.on("error", reject)
      stream.on("error", reject)
    })
    ex.on("finish", () => resolvePromise())
    ex.on("error", reject)
    const src = createReadStream(archivePath)
    src.on("error", reject)
    const bz = unbzip2()
    bz.on("error", reject)
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
    download,
    extract: extractTarBz2,
    logWarn: opts.logWarn,
  }
}
