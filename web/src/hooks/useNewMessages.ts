// useNewMessages.ts — how many messages wait unread in an agent's inbox,
// polled (a message is written by another agent's turn: no event reaches this
// page for it). The conversation header's messages mark reads it.
import { useEffect, useState } from 'react'
import { api } from '../lib/api'

const REFRESH_MS = 30_000

export function useNewMessages(agentId: string | null): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    setN(0)
    if (!agentId) return
    let cancelled = false
    const poll = (): void => {
      Promise.resolve()
        .then(() => api.messages.list(agentId, 'new'))
        .then((m) => {
          if (!cancelled) setN(Array.isArray(m) ? m.length : 0)
        })
        .catch(() => {})
    }
    poll()
    const t = setInterval(poll, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [agentId])
  return n
}
