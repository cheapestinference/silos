// useExecutions — every SDD execution, read from the built-in Executions
// silo's records route with ?values=1 (lib/executions.ts turns each row into
// an ExecutionView, hung from its task). ONE shared reading for every surface
// that draws executions (a task's page, the Tasks tree and footer, the
// PlanView's rows and header): fetched once per `silos` WS tick and again
// every minute while anything is mounted — a ledger moves on its own, with
// no plan file changing (the old usePlanExecutions' cadence, now one fetch
// for all instead of one per task).
//
// Honest states like useTasks: 'loading' before the first answer, 'absent'
// when the silo is not installed or active (its uninstall takes the
// executions off the tasks), 'error' with the server's words.
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api, ApiError } from '../lib/api'
import { EXECUTIONS_SILO, executionOfRow, type ExecutionView } from '../lib/executions'

export type ExecutionsReading =
  | { state: 'loading'; executions: ExecutionView[] }
  | { state: 'ready'; executions: ExecutionView[] }
  | { state: 'absent'; executions: ExecutionView[]; reason: string }
  | { state: 'error'; executions: ExecutionView[]; error: string }

const PAGE = 200
const MAX_PAGES = 10
const REFRESH_MS = 60_000

let cache: { tick: number; at: number; reading: ExecutionsReading } | null = null
let inflight: { tick: number; promise: Promise<ExecutionsReading> } | null = null
const listeners = new Set<(r: ExecutionsReading) => void>()

async function readAll(): Promise<ExecutionsReading> {
  try {
    const executions: ExecutionView[] = []
    let offset = 0
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await api.silos.records(EXECUTIONS_SILO, { values: true, folded: 'include', offset, limit: PAGE })
      for (const r of page.records) {
        const e = executionOfRow(r)
        if (e) executions.push(e)
      }
      offset += page.records.length
      if (page.records.length === 0 || offset >= page.matching) break
    }
    return { state: 'ready', executions }
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) return { state: 'absent', executions: [], reason: e.message }
    return { state: 'error', executions: cache?.reading.executions ?? [], error: e instanceof Error ? e.message : String(e) }
  }
}

function load(tick: number): Promise<ExecutionsReading> {
  if (inflight && inflight.tick === tick) return inflight.promise
  const promise = readAll().then((r) => {
    cache = { tick, at: Date.now(), reading: r }
    if (inflight?.promise === promise) inflight = null
    for (const l of listeners) l(r)
    return r
  })
  inflight = { tick, promise }
  return promise
}

export function useExecutions(): ExecutionsReading {
  const tick = useStore((s) => s.siloTick)
  const [reading, setReading] = useState<ExecutionsReading>(() => cache?.reading ?? { state: 'loading', executions: [] })
  useEffect(() => {
    listeners.add(setReading)
    if (!cache || cache.tick !== tick || Date.now() - cache.at > REFRESH_MS) void load(tick)
    else setReading(cache.reading)
    const t = setInterval(() => {
      if (!cache || Date.now() - cache.at >= REFRESH_MS) void load(tick)
    }, REFRESH_MS)
    return () => {
      listeners.delete(setReading)
      clearInterval(t)
    }
  }, [tick])
  return reading
}

// tests: forget the shared reading between cases
export function resetExecutionsCache(): void {
  cache = null
  inflight = null
}
