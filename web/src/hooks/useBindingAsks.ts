// useBindingAsks — the bindings agents propose on their asks to the owner
// (server/src/binding-asks.ts), checked against the Vault, by task key.
// Read only while some task says it waits on a binding (lib/tasks.ts
// waitingOn.binding) — Home and a task's page cost nothing otherwise — and
// again on every `silos` WS tick (a plan moved, a save resolved an ask).
// ONE shared reading per tick, however many rows ask (useTasks' discipline).
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import type { BindingAsk } from '../lib/types'

let shared: { tick: number; promise: Promise<BindingAsk[]> } | null = null

function read(tick: number): Promise<BindingAsk[]> {
  if (shared && shared.tick === tick) return shared.promise
  const promise = Promise.resolve(api.vault.asks())
    .then((r) => (Array.isArray(r) ? r : []))
    .catch(() => [] as BindingAsk[])
  shared = { tick, promise }
  return promise
}

// tests: forget the shared reading between cases
export function resetBindingAsks(): void {
  shared = null
}

export function useBindingAsks(wanted: boolean): Map<string, BindingAsk> {
  const tick = useStore((s) => s.siloTick)
  const [asks, setAsks] = useState<BindingAsk[]>([])
  useEffect(() => {
    if (!wanted) {
      setAsks([])
      return
    }
    let cancelled = false
    void read(tick).then((r) => {
      if (!cancelled) setAsks(r)
    })
    return () => {
      cancelled = true
    }
  }, [wanted, tick])
  return useMemo(() => new Map(asks.map((a) => [a.key, a])), [asks])
}
