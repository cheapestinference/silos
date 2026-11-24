// compose.ts — the boot seam: every registered harness's runtime, built once
// and merged for the composition root (index.ts), which names no engine. The
// phases keep the order index.ts has always used: boot() right after the
// agent-state and asks stores (the readers, the index, the probes; ready()
// awaited there, before anything async has started),
// beforeServer() where the OpenCode registrar was (after the terminals,
// before buildServer), afterServer() where the Claude transcript watcher was
// (after the catalogue's boot refresh), indexReady() inside index.init()'s
// then, and stop() first in the shutdown allSettled. Harnesses are visited
// in registration order (the fallback, Claude Code, first today).

import type { HarnessBootContext, HarnessId, HarnessRuntime, HarnessStartContext } from './harnesses/contract.js'
import { fallbackHarness, harnessForId, registeredHarnesses } from './harnesses/registry.js'
import { SessionIndex } from './session-index.js'
import type { FetchModels } from './model-catalog.js'

export interface Booted {
  runtimes: ReadonlyMap<HarnessId, HarnessRuntime>
  /** The fallback's reader, plus every other reader (addReader, registration order). */
  index: SessionIndex
  /** agentOfDb: the first non-null answer; isContested: asked of the harness that owns the id. */
  ownership: { agentOfDb(id: string): string | null; isContested(id: string): boolean }
  /** Every runtime's ready, settled together (a rejection rejects). */
  ready(): Promise<void>
  modelSources(): Partial<Record<HarnessId, FetchModels>>
  versionOptions(): Partial<Record<HarnessId, unknown>>
  headlessOptions(): Partial<Record<HarnessId, unknown>>
  /** Each runtime's beforeServer, in order; their serverOptions → ServerDeps.engines. */
  beforeServer(ctx: HarnessStartContext): Partial<Record<HarnessId, unknown>>
  afterServer(ctx: HarnessStartContext): void
  /** Each onIndexReady, in order; a throw is logged and the next still runs. */
  indexReady(): void
  /** Every start phase's stop, called now, in the order they started. */
  stop(): Promise<void>[]
}

export function bootHarnesses(ctx: HarnessBootContext): Booted {
  const runtimes = new Map<HarnessId, HarnessRuntime>()
  for (const h of registeredHarnesses()) runtimes.set(h.id, h.boot?.(ctx) ?? {})

  const fallback = fallbackHarness()
  const fallbackReader = runtimes.get(fallback.id)?.reader
  if (!fallbackReader) throw new Error(`fallback harness ${fallback.id} booted no reader`)
  const index = new SessionIndex(fallbackReader)
  for (const [id, rt] of runtimes) if (id !== fallback.id && rt.reader) index.addReader(rt.reader)

  const pick = <T>(f: (rt: HarnessRuntime) => T | undefined): Partial<Record<HarnessId, T>> => {
    const out: Partial<Record<HarnessId, T>> = {}
    for (const [id, rt] of runtimes) {
      const v = f(rt)
      if (v !== undefined) out[id] = v
    }
    return out
  }

  const stops: Array<() => void | Promise<void>> = []

  return {
    runtimes,
    index,
    ownership: {
      agentOfDb: (id) => {
        for (const rt of runtimes.values()) {
          const agent = rt.ownership?.agentOfDb(id) ?? null
          if (agent !== null) return agent
        }
        return null
      },
      // owner-routed: only the harness the id belongs to may contest it
      isContested: (id) => runtimes.get(harnessForId(id))?.ownership?.isContested(id) ?? false,
    },
    ready: () => Promise.all([...runtimes.values()].map((rt) => rt.ready)).then(() => undefined),
    modelSources: () => pick((rt) => rt.modelFetcher),
    versionOptions: () => pick((rt) => rt.versionOptions),
    headlessOptions: () => pick((rt) => rt.headlessOptions),
    beforeServer: (start) => {
      const engines: Partial<Record<HarnessId, unknown>> = {}
      for (const [id, rt] of runtimes) {
        const r = rt.beforeServer?.(start)
        if (!r) continue
        if (r.serverOptions !== undefined) engines[id] = r.serverOptions
        if (r.stop) stops.push(r.stop)
      }
      return engines
    },
    afterServer: (start) => {
      for (const rt of runtimes.values()) {
        const r = rt.afterServer?.(start)
        if (r?.stop) stops.push(r.stop)
      }
    },
    indexReady: () => {
      for (const [id, rt] of runtimes) {
        try {
          rt.onIndexReady?.()
        } catch (err) {
          console.warn(`${id}: onIndexReady failed —`, err instanceof Error ? err.message : err)
        }
      }
    },
    stop: () => stops.map((s) => Promise.resolve(s()).then(() => undefined)),
  }
}
