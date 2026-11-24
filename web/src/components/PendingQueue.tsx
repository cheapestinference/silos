// PendingQueue.tsx — queued messages, INSIDE the conversation as dimmed
// user bubbles ("shadowed in the conversation like claude.ai", not chips
// above the input). Written while a turn streams and drained one by one as
// each turn finishes (see send()/chat-done in store.ts). The queue is
// global to the store but each item carries its agentId — only the ones
// for the agent currently being viewed get painted. Each bubble carries
// its × to pull it out of the queue; the index passed to removeFromQueue
// is the REAL one in `queue`, not the position in the filtered list.
import { X } from 'lucide-react'
import { useStore } from '../store'
import { stripAgentContext } from '../lib/agent-context'

export function PendingQueue() {
  const queue = useStore((s) => s.queue)
  const selectedAgentId = useStore((s) => s.selectedAgentId)
  const selected = useStore((s) => s.selected)
  const removeFromQueue = useStore((s) => s.removeFromQueue)

  // an item freezes its destination at queue time (QueueItem.session) — the
  // bubble paints only inside THAT conversation. Same agent, two topics:
  // showing topic-2's queued reply inside topic-1 promises a message that
  // will actually land elsewhere (drainNext sends to item.session, not to
  // whatever is open). session null = a new conversation: only the
  // new-chat view (no open session) may paint it.
  const inThisConversation = (s: { folder: string; id: string } | null): boolean =>
    s === null ? selected === null : s.folder === selected?.folder && s.id === selected?.id

  const visible = queue.map((item, i) => ({ item, i })).filter(({ item }) => item.agentId === selectedAgentId && inThisConversation(item.session))

  if (visible.length === 0) return null

  return (
    <>
      {visible.map(({ item, i }) => (
        <div key={i} className="group ml-auto flex max-w-[85%] items-start gap-1.5">
          <button
            type="button"
            aria-label="remove from queue"
            onClick={() => removeFromQueue(i)}
            className="mt-2 shrink-0 text-ink-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100 hover:text-terracotta"
          >
            <X size={14} />
          </button>
          {/* the same bubble as the user's turn (Turn.tsx) but dimmed: this
              is a message NOT yet sent — a fainter bg, text in ink-2, and
              a discreet "queued" mark bottom-right. */}
          <div className="rounded-2xl bg-panel/50 px-4 py-2 text-[15px] whitespace-pre-wrap break-words text-ink-2">
            {stripAgentContext(item.text)}
            <div className="mt-1 text-right text-[10px] uppercase tracking-wider text-ink-2/70">queued</div>
          </div>
        </div>
      ))}
    </>
  )
}
