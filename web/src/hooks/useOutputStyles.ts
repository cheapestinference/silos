// useOutputStyles.ts — the output styles an agent's engine offers (GET
// /api/agents/:id/output-styles): built-ins + the operator's and the
// folder's own style files. null while loading, [] for an engine without
// styles (the caller hides the field before asking — caps.outputStyles) or
// when the server cannot answer.
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { OutputStyleInfo } from '../lib/types'

export function useOutputStyles(agentId: string, enabled: boolean, session?: { folder: string; id: string } | null): OutputStyleInfo[] | null {
  const [styles, setStyles] = useState<OutputStyleInfo[] | null>(null)
  const folder = session?.folder
  const id = session?.id
  useEffect(() => {
    if (!enabled) {
      setStyles([])
      return
    }
    let cancelled = false
    setStyles(null)
    // Promise.resolve: an automocked api answers undefined, not a promise
    Promise.resolve(api.agents.outputStyles(agentId, folder && id ? { folder, id } : undefined))
      .then((v) => {
        if (!cancelled) setStyles(v ?? [])
      })
      .catch(() => {
        if (!cancelled) setStyles([])
      })
    return () => {
      cancelled = true
    }
  }, [agentId, enabled, folder, id])
  return styles
}
