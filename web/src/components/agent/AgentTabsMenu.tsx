// AgentTabsMenu.tsx — the agent's part of the conversation header (owner
// 23-11, after four review rounds with Fable + design): the header's first
// line is the AGENT's, its title line the conversation's.
//
//   acme › [⚡ Builder │▾]  ✉ 1 new                ⑂ branch
//   billing-retry                                [Real console] [Chat]
//
// - AgentPill: one visible control. Its seal + name open the agent's page
//   (Now) with the way back; its ▾ unfolds the agent's sections.
// - AgentFold: folded by default, remembered per viewer. At the header's
//   foot, under the conversation's title and facts: one row of the agent
//   page's OWN sections (no name or role line: the pill already names it —
//   owner 24-11) (lib/agent-tabs.ts — the same list, order and
//   figures as its tab bar) as plain links, Profile after a «·». Not a
//   band, nothing selected (we are not on that page). A fold is not a popup:
//   no Esc handling — Esc always reaches the engine.
// - Phone: the ▾ opens a sheet of the same, headed by name and role (a row
//   there would hide half of them behind a scroll).
// What this conversation used of each stays in the column (its house); the
// fold says the agent's totals.
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { agentTabs, agentToolsFigure, type AgentTabDef } from '../../lib/agent-tabs'
import { effectiveVaultFor } from '../../lib/vault-view'
import { MASTER_ID } from '../../lib/constants'
import type { AgentView } from '../../lib/types'
import { useKnowsSources } from '../knows/KnowsAnatomy'
import { leadMode, useAgentStartedWith } from './AtStart'
import { tabSignal } from './tab-signal'
import { useAgentAutomationsFigure } from './Automations'

const FOLD_KEY = 'silos.conversation.agentTabs'

/** «I keep the agent's sections open» — one per-viewer preference, browser
 *  storage behind try/catch (a blocked store: folded, the page still works) */
export function useAgentRowPref(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(FOLD_KEY) === 'open'
    } catch {
      return false
    }
  })
  const set = (v: boolean): void => {
    setOpen(v)
    try {
      if (v) localStorage.setItem(FOLD_KEY, 'open')
      else localStorage.removeItem(FOLD_KEY)
    } catch {
      /* the choice lasts this page */
    }
  }
  return [open, set]
}

const isPhone = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && !window.matchMedia('(min-width: 768px)').matches
const openAgentPage = (): void => useStore.getState().openDossier('threads')

/** the agent, as one control: [seal name │ ▾] */
export function AgentPill({
  agent,
  name,
  role,
  inboxNew,
  open,
  onOpen,
}: {
  agent: AgentView
  name: string
  role: string | null
  inboxNew: number
  open: boolean
  onOpen: (open: boolean) => void
}) {
  const [sheet, setSheet] = useState(false)
  const Icon = open ? ChevronUp : ChevronDown
  return (
    <>
      <span
        data-testid="agent-pill"
        className="inline-flex min-w-0 items-stretch overflow-hidden rounded-md border border-line bg-panel text-[12.5px] text-ink"
      >
        <button
          type="button"
          onClick={openAgentPage}
          title={`${name}’s page`}
          aria-label={`${name}’s page`}
          className="flex min-w-0 items-center gap-1.5 py-0.5 pl-1 pr-2 hover:bg-canvas focus-visible:bg-canvas focus-visible:outline-none max-md:py-1.5"
        >
          <span
            aria-hidden="true"
            className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-terracotta-soft text-[11px] leading-none"
          >
            {agent.emoji}
          </span>
          <span className="max-w-[11rem] truncate">{name}</span>
        </button>
        <button
          type="button"
          data-testid="agent-tabs-trigger"
          aria-expanded={open || sheet}
          aria-controls="agent-fold"
          aria-label={open ? `Fold ${name}’s sections` : `Unfold ${name}’s sections`}
          title={open ? `Fold ${name}’s sections` : `Unfold ${name}’s sections`}
          // a mouse click leaves the focus where it was (the console, the composer)
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (isPhone()) setSheet(true)
            else onOpen(!open)
          }}
          className={`flex items-center border-l border-line px-1.5 text-ink-3 hover:bg-canvas hover:text-ink focus-visible:bg-canvas focus-visible:outline-none max-md:px-2.5 ${open ? 'bg-canvas text-ink' : ''}`}
        >
          <Icon size={12} aria-hidden="true" />
        </button>
      </span>
      {sheet ? <SectionsSheet agent={agent} name={name} role={role} inboxNew={inboxNew} onDone={() => setSheet(false)} /> : null}
    </>
  )
}

/** the agent's tab defs with their figures, read while mounted */
function useAgentTabDefs(agent: AgentView, inboxNew: number): AgentTabDef[] {
  const src = useKnowsSources(agent)
  const atStart = useAgentStartedWith(agent.id)
  const lead = leadMode(atStart)
  const automationsFigure = useAgentAutomationsFigure(agent.id)
  const [secrets, setSecrets] = useState<number | null>(null)
  useEffect(() => {
    if (agent.id === MASTER_ID) return
    let cancelled = false
    Promise.resolve(api.vault.list())
      .then((v) => {
        if (!cancelled && v) setSecrets(effectiveVaultFor(v, agent.id, agent.folder).length)
      })
      .catch(() => {
        /* the section shows without a figure */
      })
    return () => {
      cancelled = true
    }
  }, [agent.id, agent.folder])
  return agentTabs({
    agentId: agent.id,
    live: agent.sessions.some((s) => s.live),
    inboxNew,
    src,
    secrets,
    tools: agentToolsFigure(src),
    automations: automationsFigure,
    atStartTotal: lead ? atStart![lead]!.total : null,
  })
}

const go = (t: AgentTabDef): void => useStore.getState().openDossier(t.facet)

/** desktop: the agent's sections, unfolded at the header's foot */
export function AgentFold({ agent, name, inboxNew }: { agent: AgentView; name: string; inboxNew: number }) {
  const tabs = useAgentTabDefs(agent, inboxNew)
  return (
    <div id="agent-fold" data-testid="agent-fold" className="mt-2.5 border-t border-line pt-2 max-md:hidden">
      <nav aria-label={`${name}’s page`} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px]">
        {tabs.map((t) => (
          <span key={t.id} className="flex items-baseline gap-4">
            {t.apart ? (
              <span aria-hidden="true" className="text-ink-3">
                ·
              </span>
            ) : null}
            <button
              type="button"
              data-testid={`agent-section-${t.id}`}
              onClick={() => go(t)}
              className="flex items-baseline gap-1.5 rounded-sm text-ink-2 hover:text-terracotta focus-visible:outline focus-visible:outline-1 focus-visible:outline-terracotta"
            >
              <span>{t.label}</span>
              {t.signal ? <span className="font-mono text-[10.5px] tabular-nums text-ink-3">{tabSignal(t.signal)}</span> : null}
            </button>
          </span>
        ))}
      </nav>
    </div>
  )
}

/** a phone: the same sections as a sheet from the bottom */
function SectionsSheet({ agent, name, role, inboxNew, onDone }: { agent: AgentView; name: string; role: string | null; inboxNew: number; onDone: () => void }) {
  const tabs = useAgentTabDefs(agent, inboxNew)
  return (
    <>
      <div aria-hidden="true" className="fixed inset-0 z-40 bg-ink/10" onClick={onDone} />
      <nav aria-label={`${name}’s page`} className="fixed inset-x-0 bottom-0 z-50 rounded-t-xl border border-line bg-panel pb-4 shadow-lg">
        <div className="px-3 pb-2 pt-3">
          <p className="text-[14px] text-ink">{name}</p>
          {role ? <p className="line-clamp-2 text-[12.5px] text-ink-2">{role}</p> : null}
        </div>
        {tabs.map((t) => (
          <div key={t.id}>
            {t.apart ? <div role="separator" className="my-1 border-t border-line" /> : null}
            <button
              type="button"
              data-testid={`agent-section-${t.id}`}
              onClick={() => {
                onDone()
                go(t)
              }}
              className="flex min-h-[48px] w-full items-center justify-between gap-6 px-3 text-left text-[14px] text-ink hover:bg-canvas focus-visible:bg-canvas focus-visible:outline-none"
            >
              <span>{t.label}</span>
              <span className="min-w-[3ch] text-right font-mono text-[10.5px] tabular-nums text-ink-3">{tabSignal(t.signal)}</span>
            </button>
          </div>
        ))}
      </nav>
    </>
  )
}
