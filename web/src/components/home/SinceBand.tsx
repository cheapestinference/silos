// SinceBand — Home's «Since …»: one sentence under
// the pulse saying what moved while you were away — «Since Tuesday: 9 done,
// 1 automation ran 7 times, 1 stuck, X decided 2 things ›». The decided
// clause is the door: its sheet lists, agent by agent, what each decided
// without you, every row with its Undo (what an agent decides alone
// goes to its page and to Since — never to Needs you).
// The moment it serves: coming back and taking back, in one touch, what you
// don't want — reached from the pulse itself (Home, the first screen).
import { useState } from 'react'
import { api } from '../../lib/api'
import { MASTER_ID } from '../../lib/constants'
import { sinceWhen, sinceWords, type HomeSince } from '../../lib/since'
import type { AgentView } from '../../lib/types'
import { Decided } from '../agent/Decided'
import { Sheet } from '../Sheet'

export function SinceBand({ since, now, nameOf, onOpen }: { since: HomeSince; now: number; nameOf: (id: string) => string; onOpen: () => void }) {
  const w = sinceWords(since, now, nameOf)
  return (
    <p data-testid="home-since" className="mt-2 max-w-[62ch] text-[14px] leading-snug text-ink-2">
      {w.head}
      {w.decided ? (
        <button
          type="button"
          data-testid="home-since-decided"
          onClick={onOpen}
          className="text-ink underline decoration-terracotta/40 underline-offset-[3px] hover:text-terracotta hover:decoration-terracotta"
        >
          {w.decided} ›
        </button>
      ) : null}
    </p>
  )
}

export function SinceSheet({
  since,
  now,
  agents,
  onClose,
  onChanged,
}: {
  since: HomeSince
  now: number
  agents: readonly AgentView[]
  onClose: () => void
  // after an Undo / Restore / Unpause: what of this agent's still stands
  onChanged: (agentId: string, still: Set<string>) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const by = new Map<string, HomeSince['decided']>()
  for (const c of since.decided) by.set(c.by, [...(by.get(c.by) ?? []), c])
  const nameOf = (id: string): string => {
    const a = agents.find((x) => x.id === id)
    return a ? (a.id === MASTER_ID ? 'Anywhere' : a.name) : id
  }
  const reread = (agentId: string): void => {
    Promise.resolve(api.agents.heartbeat?.(agentId))
      .then((v) => {
        if (v) onChanged(agentId, new Set(v.decided.map((c) => c.id)))
        setError(null)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }
  const n = since.decided.length
  return (
    <Sheet
      testId="sheet-since"
      title={sinceWhen(since.from, now)}
      sub={n === 0 ? 'Nothing was decided without you.' : `${n} ${n === 1 ? 'thing' : 'things'} decided without you — each one undone here in one touch`}
      onClose={onClose}
    >
      {[...by].map(([agentId, items]) => (
        <section key={agentId} aria-label={nameOf(agentId)} className="mt-4 first:mt-2">
          <div className="grid grid-cols-[6.5rem_1fr] items-baseline gap-x-3 gap-y-2">
            <Decided
              agent={{ id: agentId, name: nameOf(agentId) }}
              items={items}
              reactive={0}
              onChanged={() => reread(agentId)}
              testId={`since-decided-${agentId}`}
            />
          </div>
        </section>
      ))}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-terracotta">
          {error}
        </p>
      ) : null}
    </Sheet>
  )
}
