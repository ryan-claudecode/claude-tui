import { describe, it, expect } from "vitest"
import { EventEmitter } from "events"
import { createServer, type Server } from "http"
import { listenOnLoopback } from "./server"

describe("listenOnLoopback", () => {
  it("resolves with the bound port on success", async () => {
    const server = createServer()
    try {
      const port = await listenOnLoopback(server)
      expect(port).toBeGreaterThan(0)
      const addr = server.address()
      expect(typeof addr === "object" && addr ? addr.port : 0).toBe(port)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("rejects (instead of hanging) when the server emits an error", async () => {
    // Fake server: listen() never invokes its callback; instead an async error
    // event fires — modeling a bind failure (e.g. EADDRINUSE / EACCES).
    const fake = new EventEmitter() as unknown as Server
    ;(fake as unknown as { listen: Server["listen"] }).listen = (() => {
      setImmediate(() => fake.emit("error", new Error("EADDRINUSE")))
      return fake
    }) as Server["listen"]

    await expect(listenOnLoopback(fake)).rejects.toThrow("EADDRINUSE")
  })

  it("rejects when the bound port is invalid (address() yields no port)", async () => {
    // Fake server: listen() fires its callback synchronously-ish, but address()
    // returns null — the silent `port = 0` case the helper now guards against.
    const fake = new EventEmitter() as unknown as Server
    ;(fake as unknown as { address: Server["address"] }).address = (() =>
      null) as Server["address"]
    ;(fake as unknown as { removeListener: Server["removeListener"] }).removeListener = (() =>
      fake) as Server["removeListener"]
    ;(fake as unknown as { listen: Server["listen"] }).listen = ((
      _port: number,
      _host: string,
      cb: () => void,
    ) => {
      setImmediate(cb)
      return fake
    }) as Server["listen"]

    await expect(listenOnLoopback(fake)).rejects.toThrow("invalid port")
  })
})
