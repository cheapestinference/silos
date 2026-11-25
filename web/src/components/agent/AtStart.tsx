// AtStart.tsx — the agent page's «At start» tab: what a NEW conversation of
// this agent starts with, MEASURED — the
// median first-reply total over its last conversations of each mode
// (console · chat · automation runs never mixed: one agent measured
// ~87k in the console, ~44k in its runs), split by owner, then the parts of
// its newest conversation of that mode, each opening the exact text it got.
// No measurement in any mode → one sentence, never an estimate.
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { OWNER_ORDER, ownerTone, type Owner, type OwnerContext } from '../../lib/owners'
import type { AgentStartedWith, AgentStartedWithMode, AgentView, StartedWithMode } from '../../lib/types'
import { SubNav } from '../SubNav'
import { OwnerBar, StartedWithBlock } from '../StartedWithBlock'
import { OwnerLabel } from '../OwnerLabel'

const MODE_WORD: Record<StartedWithMode, string> = { console: 'in the console', chat: 'in chat', run: 'in an automation run' }
const MODE_TAB: Record<StartedWithMode, string> = { console: 'Console', chat: 'Chat', run: 'Automation runs' }
const fmt = (n: number): string => n.toLocaleString('en-US')
const short = (n: number): string => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`)

export function useAgentStartedWith(agentId: string): AgentStartedWith | null | undefined {
  const [v, setV] = useState<AgentStartedWith | null | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    setV(undefined)
    Promise.resolve()
      .then(() => api.agents.startedWith(agentId))
      .then((r) => {
        if (!cancelled) setV(r ?? null)
      })
      .catch(() => {
        if (!cancelled) setV(null)
      })
    return () => {
      cancelled = true
    }
  }, [agentId])
  return v
}

/** the mode a summary leads with: the console if measured, else the first present */
export function leadMode(sw: AgentStartedWith | null | undefined): StartedWithMode | null {
  if (!sw) return null
  return (['console', 'chat', 'run'] as StartedWithMode[]).find((m) => sw[m]) ?? null
}

export function AtStart({ agent, sw }: { agent: AgentView; sw: AgentStartedWith | null | undefined }) {
  const modes = (['console', 'chat', 'run'] as StartedWithMode[]).filter((m) => sw?.[m])
  const [mode, setMode] = useState<StartedWithMode | null>(null)
  const current = mode && sw?.[mode] ? mode : (modes[0] ?? null)
  const ctx: OwnerContext = { agentName: agent.name, agentEmoji: agent.emoji, folder: agent.folder, offConversation: true }
  if (sw === undefined) return <p className="text-[13px] text-ink-2">Measuring its recent conversations…</p>
  if (!current)
    return (
      <p className="text-[13px] text-ink-2">
        Nothing measured for {agent.name} — a start is read from a conversation's first reply, on engines that record one.
      </p>
    )
  const m = sw![current] as AgentStartedWithMode
  const owners = OWNER_ORDER.filter((o) => (m.owners[o] ?? 0) > 0) as Owner[]
  return (
    <div className="flex flex-col gap-4" data-testid="at-start">
      {modes.length > 1 ? (
        <SubNav
          label="Mode"
          value={current}
          onChange={setMode}
          items={modes.map((x) => [
            x,
            <>
              {MODE_TAB[x]} <span className="font-mono text-[10.5px] text-ink-3">~{short(sw![x]!.total)}</span>
            </>,
          ])}
        />
      ) : null}
      <section aria-label="At start" className="rounded-lg border border-line bg-panel px-4 py-3">
        <p className="text-[13px] text-ink-2">A new conversation of {agent.name} starts with</p>
        <p className="mt-0.5 font-display text-[24px] leading-none tabular-nums text-ink">
          ~{fmt(m.total)} <span className="text-[14px] text-ink-2">tokens {MODE_WORD[current]}</span>
        </p>
        <p className="mt-1 font-mono text-[11px] text-ink-3">
          median of its last {m.n} {m.n === 1 ? 'conversation' : 'conversations'}
          {m.n > 1 ? ` · ${fmt(m.range[0])}–${fmt(m.range[1])}` : ''} · measured on each first reply
        </p>
        <div className="mt-3">
          <OwnerBar byOwner={m.owners} own="agent" total={m.total} tall />
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
          {owners.map((o) => (
            <li key={o} className="flex items-baseline gap-1.5 text-[12.5px]">
              {/* the bar's key: its tone beside the label (no glyph) */}
              <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-[2px] ${ownerTone(o, 'agent')}`} />
              <OwnerLabel owner={o} ctx={ctx} size="sm" />
              <span className="font-mono text-[11px] tabular-nums text-ink-2">~{short(m.owners[o]!)}</span>
            </li>
          ))}
        </ul>
        {(m.owners.agent ?? 0) === 0 ? (
          <p className="mt-2 text-[12px] text-ink-3">
            None of it is {agent.name}’s own — it has no mission or memory of its own; everything above it inherits.
          </p>
        ) : null}
      </section>
      <div className="rounded-lg border border-line bg-canvas">
        <p className="px-3 pt-2.5 text-[12px] text-ink-2">
          Its newest {current === 'run' ? 'automation run' : `${current} conversation`}
          {m.latest.at || m.latest.login ? (
            <span className="text-ink-3">
              {' — '}
              {m.latest.at ? new Date(m.latest.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : null}
              {m.latest.at && m.latest.login ? ', ' : null}
              {m.latest.login ? (
                <>
                  on <span className="font-mono text-[11px]">{m.latest.login}</span>
                </>
              ) : null}
              {' — '}
            </span>
          ) : (
            ', '
          )}
          part by part:
        </p>
        <StartedWithBlock key={`${m.latest.folder}/${m.latest.id}`} folder={m.latest.folder} id={m.latest.id} ctx={ctx} initiallyOpen own="agent" />
      </div>
    </div>
  )
}
