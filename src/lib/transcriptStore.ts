/**
 * THE TRUST FIX — the always-on renderer transcript store.
 *
 * Before this, AgentView folded `window.api.onStreamEvent` pushes into
 * COMPONENT-LOCAL state and subscribed to the stream in a `useEffect`. App.tsx only
 * mounts AgentView for the ACTIVE session's terminals, so switching away UNMOUNTED
 * the component, killed its listener, and permanently lost every event for that
 * terminal during the away period (assistant text, tool blocks, and the synthetic
 * `user_message` echo — the only source of the user's own chat bubble). Seeding
 * couldn't heal the hole (cache keyed on a late-arriving convo id; the disk-seed
 * guard discarded the whole seed if any live event folded first).
 *
 * This store lives as long as the WINDOW (one instance in App.tsx, subscribed once
 * at mount). It folds every terminal's stream continuously — mounted or not — so a
 * switched-away terminal keeps accumulating its transcript, and AgentView becomes a
 * thin `useSyncExternalStore` reader that always paints the full history on return.
 *
 * Framework-free + dependency-free (only the pure `agentTranscript` reducer): unit-
 * testable without React or Electron, the same seam pattern as transcriptWindow.ts.
 */
import type { StreamEvent } from "../../electron/services/streamProtocol"
import {
  emptyTranscript,
  reduceTranscript,
  type TranscriptBlock,
  type TranscriptState,
} from "./agentTranscript"

/** The renderer-side stream push shape (mirrors TerminalStreamPayload). */
export interface TranscriptStreamPayload {
  terminalId: string
  event: StreamEvent
}

interface Entry {
  state: TranscriptState
  version: number
  /** True once history has been merged in — makes seeding idempotent. */
  seeded: boolean
  listeners: Set<() => void>
}

export interface TranscriptStore {
  /** Fold ONE stream event into a terminal's transcript, notifying its subscribers.
   *  Retained even when nobody is subscribed (the switched-away terminal). */
  ingest(payload: TranscriptStreamPayload): void
  /** Merge restored history (cache or disk) BENEATH whatever live blocks already
   *  exist for the terminal. Idempotent — a second seed is a no-op. */
  seedHistory(terminalId: string, seeded: TranscriptState): void
  /** The current folded state for a terminal. Returns a STABLE shared empty state
   *  for an unknown terminal (referentially stable so useSyncExternalStore's
   *  Object.is snapshot compare never loops). */
  get(terminalId: string): TranscriptState
  /** A monotonic per-terminal version, bumped on every state change (a cheap
   *  change signal / test seam). 0 for an unknown terminal. */
  getVersion(terminalId: string): number
  /** Whether history has already been seeded for this terminal. */
  hasSeeded(terminalId: string): boolean
  /** Subscribe to a terminal's changes; returns a disposer. */
  subscribe(terminalId: string, cb: () => void): () => void
  /** Drop a terminal's state + listeners (GC on terminal/session close). */
  remove(terminalId: string): void
  /** Bulk GC: drop every terminal NOT in `live` (called alongside the App-level
   *  transcriptCache GC when the session/terminal set changes). */
  gc(live: Set<string>): void
}

/** The shared, frozen empty snapshot returned for terminals with no entry. A single
 *  stable reference so repeated `get` calls compare equal under Object.is. */
const EMPTY: TranscriptState = Object.freeze({ blocks: [] as TranscriptBlock[], seq: 0 })

/**
 * A content-identity key for a block, IGNORING its seq-minted id (which differs
 * between the seeded fold and the live fold). Used only for the conservative
 * single-block boundary dedupe in {@link mergeSeededHistory}.
 */
function blockContentKey(b: TranscriptBlock): string {
  switch (b.kind) {
    case "user":
    case "assistant":
    case "thinking":
      return `${b.kind} ${b.text}`
    case "tool":
      return `tool ${b.toolUseId} ${b.name}`
    case "result":
      return `result ${b.text ?? ""} ${b.subtype ?? ""} ${b.isError}`
    case "error":
      return `error ${b.message}`
    case "needs_auth":
      return `needs_auth ${b.message}`
    case "model_error":
      return `model_error ${b.message} ${b.model ?? ""}`
    case "injected":
      return `injected ${b.wrapper} ${b.raw}`
    case "raw":
      try {
        return `raw ${JSON.stringify(b.raw)}`
      } catch {
        return "raw "
      }
  }
}

/** Renumber a block list to contiguous, unique `b0..bN` ids and return a state whose
 *  `seq` sits just past the end — so subsequent `reduceTranscript` appends never
 *  collide with the merged ids, and React keys stay unique. Pure. */
function renumber(blocks: TranscriptBlock[]): TranscriptState {
  return {
    blocks: blocks.map((b, i) => ({ ...b, id: `b${i}` })),
    seq: blocks.length,
  }
}

/**
 * Merge restored `seeded` history BENEATH `live` blocks. PURE — never mutates inputs.
 *
 * Rules (each acceptance-bearing):
 *  - live empty → the seeded state, unchanged (the app-restart restore path).
 *  - live non-empty → seeded blocks PREPENDED to live blocks.
 *  - conservative boundary dedupe: if the seeded TAIL block content-duplicates the
 *    live HEAD block (same kind + content, ignoring ids), drop that one seeded tail
 *    block so the shared turn renders exactly once.
 *  - NEVER discards live blocks; NEVER discards the whole seed. Merged ids are
 *    renumbered to be unique (both folds mint `b0..` independently and would collide).
 */
export function mergeSeededHistory(
  seeded: TranscriptState,
  live: TranscriptState,
): TranscriptState {
  if (live.blocks.length === 0) return seeded
  if (seeded.blocks.length === 0) return live

  let seedBlocks = seeded.blocks
  // Conservative single-block boundary dedupe: the seeded tail == the live head.
  const seedTail = seedBlocks[seedBlocks.length - 1]
  const liveHead = live.blocks[0]
  if (blockContentKey(seedTail) === blockContentKey(liveHead)) {
    seedBlocks = seedBlocks.slice(0, -1)
  }

  return renumber([...seedBlocks, ...live.blocks])
}

export function createTranscriptStore(): TranscriptStore {
  const entries = new Map<string, Entry>()

  function ensure(terminalId: string): Entry {
    let e = entries.get(terminalId)
    if (!e) {
      e = { state: emptyTranscript(), version: 0, seeded: false, listeners: new Set() }
      entries.set(terminalId, e)
    }
    return e
  }

  function notify(e: Entry): void {
    for (const cb of e.listeners) {
      try {
        cb()
      } catch {
        // A misbehaving subscriber must never break the fold or sibling subscribers.
      }
    }
  }

  return {
    ingest({ terminalId, event }) {
      const e = ensure(terminalId)
      const next = reduceTranscript(e.state, event)
      if (next === e.state) return // reducer returned the same state (no-op) → no churn
      e.state = next
      e.version++
      notify(e)
    },

    seedHistory(terminalId, seeded) {
      const e = ensure(terminalId)
      if (e.seeded) return // idempotent — never merge history twice
      e.seeded = true
      const merged = mergeSeededHistory(seeded, e.state)
      // Merge is a no-op only when seeded is empty AND live is unchanged; guard the
      // reference so an empty seed doesn't bump the version / notify needlessly.
      if (merged === e.state) return
      e.state = merged
      e.version++
      notify(e)
    },

    get(terminalId) {
      return entries.get(terminalId)?.state ?? EMPTY
    },

    getVersion(terminalId) {
      return entries.get(terminalId)?.version ?? 0
    },

    hasSeeded(terminalId) {
      return entries.get(terminalId)?.seeded ?? false
    },

    subscribe(terminalId, cb) {
      const e = ensure(terminalId)
      e.listeners.add(cb)
      return () => {
        // The entry may have been removed (GC) between subscribe and dispose.
        entries.get(terminalId)?.listeners.delete(cb)
      }
    },

    remove(terminalId) {
      const e = entries.get(terminalId)
      if (!e) return
      e.listeners.clear()
      entries.delete(terminalId)
    },

    gc(live) {
      for (const id of [...entries.keys()]) {
        if (!live.has(id)) {
          entries.get(id)!.listeners.clear()
          entries.delete(id)
        }
      }
    },
  }
}
