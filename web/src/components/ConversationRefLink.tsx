// ConversationRefLink.tsx — a session name or id written in a message, shown
// as the conversation's title and opening it (lib/conversation-refs.ts).
// Unknown → the token as written (in code style when it came as code).
import type { ReactNode } from 'react'
import { useConversationRef, type Found } from '../lib/conversation-refs'
import { useStore } from '../store'

export function ConversationRefLink({ token, kind, code = false }: { token: string; kind: Found['kind']; code?: boolean }): ReactNode {
  const ref = useConversationRef(token, kind)
  const agent = useStore((s) => (ref ? s.agents.find((a) => a.id === ref.agentId) : undefined))
  if (!ref) {
    return code ? <code className="break-words rounded bg-panel px-1 font-mono text-[0.9em]">{token}</code> : <>{token}</>
  }
  const who = agent ? `${agent.emoji ? `${agent.emoji} ` : ''}${agent.name}` : ref.agentId
  return (
    <button
      type="button"
      data-testid="conversation-ref"
      title={`${who} · ${ref.live ? 'open now' : 'conversation'} (${token})`}
      onClick={(e) => {
        e.preventDefault()
        void useStore.getState().openSession(ref.folder, ref.sessionId)
      }}
      className="inline rounded-sm text-left text-ink underline decoration-ink-3/60 decoration-1 underline-offset-[3px] hover:text-terracotta hover:decoration-terracotta focus-visible:outline-2 focus-visible:outline-terracotta"
    >
      {ref.live ? <span aria-hidden="true" className="mr-1 inline-block h-1.5 w-1.5 -translate-y-px rounded-full bg-terracotta align-middle" /> : null}
      {ref.title}
    </button>
  )
}
