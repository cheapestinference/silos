// NowCard.tsx — what is alive in this agent's conversations RIGHT NOW.
// Three honest states, from the same signals the sidebar's dot reads
// (lib/live.ts): the agent ASKED you something and is waiting (pendingAsk
// — the real "needs you"), it is WORKING (open turn with recent activity),
// or it REPLIED recently and you haven't looked (durable unread, but only
// within RECENT_MS — a conversation you left unread ten days ago is not
// "now"; it keeps its dot in Conversations and the sidebar). Nothing
// alive → no card: an idle agent's page opens on who it is.
// Nested runs (births — the agent's own `claude -p`, plugin 0.7.0) are not
// conversations: never a row here. The ones with no parent conversation to
// fold under are the agent's, so Now counts them in one line that opens
// the newest; the rest live in their parent's context column.
import { useStore } from '../../store'
import { sessionSignal, type SessionSignal } from '../../lib/live'
import { relTime } from '../../lib/rel-time'
import { SessionDot } from '../SessionDot'
import { countsOf, plural } from '../../lib/counts'
import { causeWords, conversationCause } from '../../lib/sidebar-show'
import { useOpenTasksBySession } from '../../hooks/useTasks'
import { Section } from './Section'
import type { AgentView, SessionView } from '../../lib/types'

export const RECENT_MS = 24 * 60 * 60_000

export type NowState = 'asks' | 'working' | 'replied'
export interface NowRow {
  s: SessionView
  state: NowState
  signal: SessionSignal
}

export function liveSessions(agent: AgentView, now: number): NowRow[] {
  const out: NowRow[] = []
  for (const s of agent.sessions) {
    if (s.origin?.kind === 'nested') continue
    const signal = sessionSignal(s, now, false)
    if (!signal) continue
    if (s.pendingAsk === true) out.push({ s, state: 'asks', signal })
    else if (signal === 'working') out.push({ s, state: 'working', signal })
    // a finished automation run is not a reply waiting for you:
    // its "unread" never reaches the agent's seal or Now card —
    // a run that asks (above) or works (above) still does.
    else if (now - s.mtime < RECENT_MS && s.origin === undefined) out.push({ s, state: 'replied', signal })
  }
  const rank: Record<NowState, number> = { asks: 0, working: 1, replied: 2 }
  return out.sort((a, b) => rank[a.state] - rank[b.state] || b.s.mtime - a.s.mtime)
}

// the agent-level signal for the plaque's seal: a question beats work,
// work beats an unread reply.
export function agentSignal(agent: AgentView, now: number): SessionSignal {
  const live = liveSessions(agent, now)
  if (live.some((x) => x.state === 'asks')) return 'attention'
  if (live.some((x) => x.state === 'working')) return 'working'
  // a nested run at work is the agent at work (it just isn't a conversation)
  if (agent.sessions.some((s) => s.origin?.kind === 'nested' && sessionSignal(s, now, false) === 'working')) return 'working'
  if (live.length > 0) return 'attention'
  return null
}

const STATE_LABEL: Record<NowState, string> = { asks: 'asks you', working: 'working', replied: 'replied' }

// the agent's loose nested runs: how many (the server's uncapped count) and
// the newest one the overview carries.
export function looseNested(agent: AgentView): { count: number; newest: SessionView | null } {
  const ids = new Set(agent.sessions.map((s) => s.id))
  let newest: SessionView | null = null
  for (const s of agent.sessions) {
    if (s.origin?.kind !== 'nested' || (s.origin.parent !== null && ids.has(s.origin.parent))) continue
    if (!newest || s.mtime > newest.mtime) newest = s
  }
  return { count: countsOf(agent).nestedLoose ?? 0, newest }
}

export function NowCard({ agent }: { agent: AgentView }) {
  const nowTick = useStore((s) => s.nowTick)
  const openSession = useStore((s) => s.openSession)
  const automations = useStore((s) => s.automations)
  const live = liveSessions(agent, nowTick)
  // C1: each live row says why it exists (a wake, a run, a heartbeat…) —
  // these conversations are not sidebar rows, so this is where they are read
  const tasksBySession = useOpenTasksBySession(live.length > 0)
  const causeOf = (s: SessionView): string | null =>
    causeWords(
      conversationCause(s, {
        tasks: tasksBySession.get(s.id),
        keptBy: (() => {
          const m = new Map<string, string>()
          for (const a of automations) if (a.agentId === agent.id && a.thread.mode === 'keep' && a.thread.sessionId) m.set(a.thread.sessionId, a.name)
          return m
        })(),
        automationName: (id) => automations.find((a) => a.id === id)?.name ?? null,
        parentTitle: (pid) => agent.sessions.find((x) => x.id === pid)?.title ?? null,
      }),
    )
  const nested = looseNested(agent)
  const newestNested = nested.count > 0 ? nested.newest : null
  if (live.length === 0 && newestNested === null) return null
  const count = (st: NowState): number => live.filter((x) => x.state === st).length
  const asks = count('asks'),
    working = count('working'),
    replied = count('replied')
  const summary = [
    asks > 0 ? `${asks} ask${asks === 1 ? 's' : ''} you` : null,
    working > 0 ? `${working} working` : null,
    replied > 0 ? `${replied} unread` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Section label="Live" action={<span className="font-mono text-[11px] text-ink-2">{summary}</span>}>
      <ul className="-mx-2">
        {live.map(({ s, state, signal }) => (
          <li key={`${s.folder}/${s.id}`}>
            <button
              type="button"
              onClick={() => void openSession(s.folder, s.id)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-canvas/70"
            >
              <SessionDot signal={signal} />
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{s.title}</span>
              <span className="shrink-0 font-mono text-[11px] text-ink-2">
                {(() => {
                  const c = causeOf(s)
                  return c !== null ? `${c} · ` : ''
                })()}
                {STATE_LABEL[state]} · {relTime(s.mtime, nowTick)}
              </span>
            </button>
          </li>
        ))}
        {newestNested ? (
          <li>
            <button
              type="button"
              onClick={() => void openSession(newestNested.folder, newestNested.id)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-canvas/70"
            >
              <SessionDot signal={sessionSignal(newestNested, nowTick, false) === 'working' ? 'working' : undefined} />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-2">{plural(nested.count, 'nested run')}</span>
              <span className="shrink-0 font-mono text-[11px] text-ink-3">newest · {relTime(newestNested.mtime, nowTick)}</span>
            </button>
          </li>
        ) : null}
      </ul>
    </Section>
  )
}
