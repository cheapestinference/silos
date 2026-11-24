// MessagesTab.tsx — the agent page's Messages tab: everything that passed
// between this agent and the others, in ONE list — what it received (its
// inbox) and what it sent (gathered from every recipient's inbox, GET
// …/messages/sent) — each row with its direction (↙ received, ↗ sent), the
// other side, its first line, where it stands and when.
//
// The moment it serves: «what did it ask, what was it asked, and who still
// owes an answer?» — across all its conversations (a conversation's column
// shows only what THAT conversation sent). It scales by narrowing, not by
// scrolling: the house's filter grammar (OwnerFilter) — a segmented
// direction and state with counts, «with» chips for the people it talks to,
// a search, and ONE sentence that says what the list is — then date bands
// and pages of PAGE rows.
//
// What waits on YOU (a message handed to you — needs_owner, either way) is
// pinned above the filters with its two settles; no filter hides it. No
// message wakes anyone: a message is read at the recipient's next
// conversation, and «read» is marked by Silos, not by the agent.
import { useEffect, useMemo, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, Search, X } from 'lucide-react'
import { api } from '../../lib/api'
import { useStore } from '../../store'
import { relTime } from '../../lib/rel-time'
import { MASTER_ID, ANYWHERE_LABEL } from '../../lib/constants'
import type { AgentMessage, AgentMessageState, AgentView } from '../../lib/types'
import {
  applyFilters,
  bands,
  caption,
  mergeMessages,
  NO_FILTERS,
  stateWord,
  tallies,
  waitsOnOwner,
  type DirFilter,
  type MessageFilters,
  type MessageRow,
  type StateFilter,
} from '../../lib/messages-view'
import { Section } from './Section'

const PAGE = 25

function nameIn(agents: AgentView[], self: string, id: string): string {
  if (id === 'owner') return 'you'
  if (id === self) return 'itself'
  if (id === MASTER_ID) return ANYWHERE_LABEL
  return agents.find((a) => a.id === id)?.name ?? id
}

export function MessagesTab({ agent }: { agent: AgentView }) {
  const agents = useStore((s) => s.agents)
  const [inbox, setInbox] = useState<AgentMessage[] | null>(null)
  const [sent, setSent] = useState<AgentMessage[] | null>(null)
  // a failed read is NOT an empty list: said in one line
  const [loadFailed, setLoadFailed] = useState(false)
  const [actionNote, setActionNote] = useState<string | null>(null)
  const [f, setF] = useState<MessageFilters>(NO_FILTERS)
  const [limit, setLimit] = useState(PAGE)
  useEffect(() => {
    let cancelled = false
    setInbox(null)
    setSent(null)
    setLoadFailed(false)
    setF(NO_FILTERS)
    Promise.all([api.messages.list(agent.id), api.messages.sent(agent.id)])
      .then(([i, s]) => {
        if (!cancelled) {
          setInbox(Array.isArray(i) ? i : [])
          setSent(Array.isArray(s) ? s : [])
        }
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [agent.id])
  // a narrower list starts again at its first page
  useEffect(() => {
    setLimit(PAGE)
  }, [f])

  const nameOf = (id: string): string => nameIn(agents, agent.id, id)
  const rows = useMemo(() => (inbox && sent ? mergeMessages(agent.id, inbox, sent) : []), [agent.id, inbox, sent])

  if (loadFailed) {
    return (
      <Section id="messages" label="Messages">
        <p className="text-[12px] text-ink-3">Its messages couldn’t be read — reload to see them.</p>
      </Section>
    )
  }
  if (!inbox || !sent) return null

  // a settle lands in the inbox that holds the message — the recipient's
  const settle = (m: AgentMessage, state: AgentMessageState): void => {
    setActionNote(null)
    Promise.resolve(api.messages.setState(m.to, m.id, state))
      .then((next) => {
        if (!next) return
        const swap = (all: AgentMessage[] | null): AgentMessage[] | null => (all ? all.map((o) => (o.id === next.id ? next : o)) : all)
        setInbox(swap)
        setSent(swap)
      })
      .catch(() => setActionNote('That didn’t save — try again.'))
  }

  const now = Date.now()
  const pinned = rows.filter(waitsOnOwner)
  const shown = applyFilters(rows, f, nameOf)
  const t = tallies(rows, f, nameOf)
  const page = shown.slice(0, limit)
  const filtered = f.dir !== 'all' || f.state !== 'any' || f.with !== null || f.q.trim() !== ''

  return (
    <div className="flex flex-col gap-4">
      {pinned.length > 0 ? (
        <Section id="messages-needs-you" label="Waiting on you" live>
          <ul className="flex flex-col gap-2.5">
            {pinned.map((r) => (
              <li key={r.m.id} className="flex items-start gap-3">
                <span className="min-w-0 flex-1">
                  <RowHead r={r} nameOf={nameOf} now={now} />
                  <MessageText text={r.m.text} />
                </span>
                <span className="flex shrink-0 items-center gap-3 self-center text-[12px]">
                  <button type="button" onClick={() => settle(r.m, 'answered')} className="text-terracotta hover:underline">
                    Answered
                  </button>
                  <button type="button" onClick={() => settle(r.m, 'read')} className="text-ink-2 hover:text-terracotta">
                    Seen
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {actionNote ? <p className="mt-2 text-[12px] text-ink-3">{actionNote}</p> : null}
        </Section>
      ) : null}

      <Section id="messages" label="Messages">
        <div className="flex flex-col gap-3">
          {rows.length > 0 ? (
            <div role="group" aria-label="Filter messages" className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                <Segmented<DirFilter>
                  label="Direction"
                  value={f.dir}
                  onChange={(dir) => setF({ ...f, dir })}
                  options={[
                    ['all', 'All', t.dir.all],
                    ['received', 'Received', t.dir.received],
                    ['sent', 'Sent', t.dir.sent],
                  ]}
                />
                <Segmented<StateFilter>
                  label="State"
                  value={f.state}
                  onChange={(state) => setF({ ...f, state })}
                  options={[
                    ['any', 'Any state', t.state.any],
                    ['open', 'Open', t.state.open],
                    ['answered', 'Answered', t.state.answered],
                  ]}
                />
                <label className="ml-auto flex min-w-[12rem] max-w-[18rem] flex-1 items-center gap-1.5 rounded-md border border-line bg-canvas px-2 py-0.5 focus-within:border-ink-3">
                  <Search size={12} aria-hidden="true" className="shrink-0 text-ink-3" />
                  <input
                    type="search"
                    value={f.q}
                    onChange={(e) => setF({ ...f, q: e.target.value })}
                    placeholder="Search messages and answers"
                    aria-label="Search messages"
                    className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-3"
                  />
                </label>
              </div>
              {t.people.length > 1 || f.with !== null ? (
                <div role="group" aria-label="With" className="flex flex-wrap items-center gap-1">
                  <span className="mr-0.5 font-mono text-[10.5px] text-ink-3">with</span>
                  {t.people.map(({ id, n }) => {
                    const on = f.with === id
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setF({ ...f, with: on ? null : id })}
                        className={`flex items-center gap-1 rounded-full border px-2 py-px text-[12px] transition-colors ${on ? 'border-ink-3 bg-canvas text-ink shadow-sm' : 'border-transparent text-ink-2 hover:border-line hover:text-ink'}`}
                      >
                        {nameOf(id)}
                        <span className="font-mono text-[10.5px] tabular-nums text-ink-3">{n}</span>
                      </button>
                    )
                  })}
                </div>
              ) : null}
              <p
                className="flex max-w-[62ch] flex-wrap items-baseline gap-x-2 text-[11.5px] leading-snug text-ink-2"
                data-testid="messages-caption"
                aria-live="polite"
              >
                <span>{caption(shown.length, rows.length, f, agent.name, nameOf)}</span>
                {filtered ? (
                  <button
                    type="button"
                    onClick={() => setF(NO_FILTERS)}
                    className="inline-flex items-center gap-0.5 font-mono text-[10.5px] text-ink-3 hover:text-terracotta"
                  >
                    <X size={10} aria-hidden="true" />
                    clear
                  </button>
                ) : null}
              </p>
            </div>
          ) : (
            <p className="text-[12px] text-ink-3">{caption(0, 0, f, agent.name, nameOf)}</p>
          )}

          {rows.length > 0 && shown.length === 0 ? (
            <p className="text-[12px] text-ink-3">
              Nothing matches —{' '}
              <button type="button" onClick={() => setF(NO_FILTERS)} className="underline hover:text-terracotta">
                clear the filters
              </button>
              .
            </p>
          ) : null}

          {bands(page, now).map((b) => (
            <div key={b.label} role="group" aria-label={b.label}>
              <h4 className="mb-0.5 border-b border-line pb-1 font-mono text-[10.5px] text-ink-3">{b.label}</h4>
              <ul className="divide-y divide-line/60">
                {b.rows.map((r) => (
                  <MessageLine key={r.m.id} r={r} nameOf={nameOf} now={now} />
                ))}
              </ul>
            </div>
          ))}

          {shown.length > page.length ? (
            <button type="button" onClick={() => setLimit((n) => n + PAGE)} className="self-start font-mono text-[11px] text-ink-2 hover:text-terracotta">
              Show {Math.min(PAGE, shown.length - page.length)} more · {shown.length - page.length} left
            </button>
          ) : null}
        </div>
      </Section>
    </div>
  )
}

function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: T
  onChange: (v: T) => void
  options: [T, string, number][]
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md border border-line bg-panel p-px">
      {options.map(([v, word, n]) => {
        const on = value === v
        return (
          <button
            key={v}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(v)}
            className={`flex items-baseline gap-1 rounded-[5px] px-2 py-0.5 text-[12px] transition-colors ${on ? 'bg-canvas text-ink shadow-sm' : n === 0 ? 'text-ink-3 hover:text-ink-2' : 'text-ink-2 hover:text-ink'}`}
          >
            {word}
            <span className="font-mono text-[10.5px] tabular-nums text-ink-3">{n}</span>
          </button>
        )
      })}
    </div>
  )
}

function DirGlyph({ dir }: { dir: MessageRow['dir'] }) {
  return dir === 'received' ? (
    <ArrowDownLeft size={12} aria-label="received" className="shrink-0 text-ink-3" />
  ) : (
    <ArrowUpRight size={12} aria-label="sent" className="shrink-0 text-terracotta" />
  )
}

function RowHead({ r, nameOf, now }: { r: MessageRow; nameOf: (id: string) => string; now: number }) {
  return (
    <span className="flex items-center gap-1.5 font-mono text-[11px] text-ink-2">
      <DirGlyph dir={r.dir} />
      <span>
        {r.dir === 'received' ? 'from' : 'to'} {nameOf(r.with)} · {relTime(Date.parse(r.m.at) || 0, now)}
      </span>
    </span>
  )
}

// one line until clicked: direction, the other side, the first words,
// where it stands, when. Open: the whole body, then the answer.
function MessageLine({ r, nameOf, now }: { r: MessageRow; nameOf: (id: string) => string; now: number }) {
  const [open, setOpen] = useState(false)
  const firstLine = r.m.text.split('\n').find((l) => l.trim() !== '') ?? ''
  const waiting = r.m.state === 'needs_owner'
  const unanswered = r.m.state !== 'answered'
  return (
    <li data-testid="message-row" data-dir={r.dir} className="py-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="grid w-full grid-cols-[auto_minmax(4rem,9rem)_1fr_auto] items-baseline gap-x-2 rounded text-left text-[12.5px] hover:bg-canvas focus-visible:outline focus-visible:outline-1 focus-visible:outline-ink-3"
      >
        <span className="self-center">
          <DirGlyph dir={r.dir} />
        </span>
        <span className="truncate text-ink">{nameOf(r.with)}</span>
        <span className={`truncate ${unanswered ? 'text-ink' : 'text-ink-2'}`}>{firstLine}</span>
        <span className="whitespace-nowrap font-mono text-[10.5px] tabular-nums text-ink-3">
          {/* a phone keeps the first words: the state goes, unless it waits on you */}
          <span className={waiting ? 'text-terracotta' : `max-sm:hidden ${r.m.state === 'new' ? 'text-ink-2' : ''}`}>
            {stateWord(r)}
            <span> · </span>
          </span>
          {relTime(Date.parse(r.m.at) || 0, now)}
        </span>
      </button>
      {open ? (
        <div className="mb-1 mt-1 pl-5">
          <span className="block max-w-[68ch] whitespace-pre-wrap text-[13px] leading-snug text-ink">{r.m.text}</span>
          <Answer m={r.m} />
        </div>
      ) : null}
    </li>
  )
}

// what the recipient said when it closed the message (PATCH state + answer)
// — two lines until asked: an answer can be a paragraph
export function Answer({ m }: { m: Pick<AgentMessage, 'answer'> }) {
  const [open, setOpen] = useState(false)
  if (!m.answer) return null
  const long = m.answer.length > 160
  return (
    <span className="mt-1 block max-w-[68ch] border-l-2 border-line pl-2">
      <span data-testid="message-answer" className={`text-[12.5px] leading-snug text-ink-2 ${long && !open ? 'line-clamp-2' : 'block'}`}>
        <span className="font-mono text-[11px] text-ink-3">answered: </span>
        {m.answer}
      </span>
      {long ? (
        <button type="button" onClick={() => setOpen((v) => !v)} className="font-mono text-[11px] text-ink-3 hover:text-terracotta">
          {open ? 'less' : 'read all ›'}
        </button>
      ) : null}
    </span>
  )
}

// a pinned message is three lines until you ask for the rest
function MessageText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 280 || text.split('\n').length > 3
  return (
    <>
      <span className={`max-w-[62ch] whitespace-pre-wrap text-[13.5px] leading-snug text-ink ${long && !open ? 'line-clamp-3' : 'block'}`}>{text}</span>
      {long ? (
        <button type="button" onClick={() => setOpen((v) => !v)} className="font-mono text-[11px] text-ink-3 hover:text-terracotta">
          {open ? 'less' : 'read all ›'}
        </button>
      ) : null}
    </>
  )
}
