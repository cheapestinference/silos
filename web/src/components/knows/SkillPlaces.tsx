// SkillPlaces — a skill's row, opened by its ▾ (spec scopes T9): «Where it
// loads», WhereItLoads' grammar with the skill's three positions on each
// line that can take them (on · name only · off), and — for a name several
// copies share — which copies a line's entry reaches, said on the line.
//
// Which lines switch on which page:
//  · «This machine» — the user's own settings, every project and every login
//    Silos connects; its «off» says first what it reaches and waits for a
//    yes; the answer names any login that did not follow;
//  · «This project» on a project's page — the page's own place (`onProject`:
//    the project's position, or a folder copy's hold, with their own asks);
//  · «Only <agent>» — kept by Silos and carried into that agent's launches:
//    every agent line on a project's page, the page's own on an agent's;
//  · «Conversation · <title>» on its agent's page opened from it — that
//    conversation's own position, with when it takes effect.
// Every other line reads: a fact, the account's door, a locked line.
import { useState } from 'react'
import { api } from '../../lib/api'
import type { SkillCatalogEntry, SkillLine, SkillPosition } from '../../lib/types'
import {
  conversationLabel,
  machineOffSentence,
  missedWords,
  positionWord,
  skillBlockLines,
  skillLineWords,
  type PlacesFrom,
  type PlacesPage,
} from '../../lib/loads-places'
import { skillWhenWords } from '../../lib/here-tools'
import { useStore } from '../../store'

const AMBER = 'text-[var(--health-amber)]'
const HINT: Record<SkillPosition, string> = {
  on: 'listed with its description in every new conversation it reaches',
  'name-only': 'listed without its description — lighter, still callable',
  off: 'not loaded in the new conversations it reaches',
}

/** The copy a switch names: where this row's skill comes from. */
export const skillFrom = (s: SkillCatalogEntry): 'account' | 'personal' | 'project' =>
  s.source === 'account' ? 'account' : s.source === 'user' ? 'personal' : 'project'

// A line's positions: each one it can take, the result drawn in ink — the
// row's own control, smaller. A value found by hand sits first, kept.
export function LinePositions({
  line,
  label,
  busy,
  pending,
  onPick,
}: {
  line: SkillLine
  label: string
  busy: boolean
  pending: SkillPosition | null
  onPick: (to: SkillPosition) => void
}) {
  const positions = line.positions ?? []
  const own = line.entry !== undefined
  const known = (positions as string[]).includes(line.result)
  return (
    <span
      role="radiogroup"
      aria-label={label}
      data-testid="line-positions"
      className={`flex shrink-0 items-baseline gap-px rounded-full border px-0.5 text-[10.5px] ${own ? 'border-ink-3/60' : 'border-line'}`}
    >
      {!known ? (
        <span
          title={`set to "${line.result}" — kept until you pick a position`}
          className="max-w-[7rem] truncate rounded-full bg-canvas px-1.5 font-mono leading-[16px] text-ink"
        >
          {positionWord(line.result)}
        </span>
      ) : null}
      {positions.map((p) => {
        const on = p === line.result
        const asked = pending === p
        return (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={busy || on}
            title={HINT[p]}
            onClick={() => onPick(p)}
            className={`rounded-full px-1.5 font-mono leading-[16px] transition-colors disabled:cursor-default ${
              on
                ? p === 'off'
                  ? own
                    ? 'bg-terracotta/10 text-terracotta'
                    : 'bg-ink-3/15 text-ink'
                  : own
                    ? 'bg-ink text-canvas'
                    : 'bg-ink-3/15 text-ink'
                : asked
                  ? 'text-terracotta'
                  : 'text-ink-3 hover:text-ink'
            }`}
          >
            {busy && asked ? '…' : positionWord(p)}
          </button>
        )
      })}
    </span>
  )
}

export function SkillPlaces({
  skill,
  page,
  indent,
  folder,
  onProject,
  onChanged,
}: {
  skill: SkillCatalogEntry
  page: PlacesPage
  indent: boolean
  /** the folder whose machine and agent lines this block writes (null: they read) */
  folder: string | null
  /** «This project» picked (a project's page): the page's own place */
  onProject?: (to: SkillPosition) => void
  /** after a machine or agent line wrote: the page reads the catalog again */
  onChanged: () => void
}) {
  const all = skill.at ?? []
  const { lines, more } = skillBlockLines(all, page)
  const agentNames = all.filter((l) => l.place === 'agent').map((l) => l.agentName ?? l.agent ?? '')
  const [asking, setAsking] = useState<string | null>(null)
  const [busy, setBusy] = useState<{ key: string; to: SkillPosition } | null>(null)
  const [said, setSaid] = useState<{ error?: string; missed?: string } | null>(null)
  const from = skillFrom(skill)
  // the conversation this agent's page was opened from: its own line
  const here: PlacesFrom | null = page.scope === 'agent' ? (page.from ?? null) : null

  async function write(l: SkillLine, key: string, to: SkillPosition): Promise<void> {
    if (folder === null) return
    setBusy({ key, to })
    setSaid(null)
    try {
      const a = await api.folders.skillPositionAt(
        folder,
        skill.name,
        from,
        to,
        l.place === 'machine'
          ? { scope: 'machine' }
          : l.place === 'conversation' && here
            ? { scope: 'conversation', conversation: here.id }
            : { scope: 'agent', agent: l.agent! },
      )
      setAsking(null)
      const missed = missedWords(a.logins?.missed ?? [])
      if (missed) setSaid({ missed })
      onChanged()
    } catch (e) {
      setSaid({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  /** what a line's click does on this page — null: it reads */
  const actOf = (l: SkillLine): 'machine' | 'project' | 'agent' | 'conversation' | null => {
    if (!l.positions || l.locked || l.refused) return null
    if (l.place === 'machine') return folder !== null ? 'machine' : null
    if (l.place === 'project') return page.scope === 'project' && onProject ? 'project' : null
    if (l.place === 'agent') return folder !== null && (page.scope === 'project' || l.agent === page.agentId) ? 'agent' : null
    if (l.place === 'conversation') return folder !== null && here !== null && l.conversation === here.thread ? 'conversation' : null
    return null
  }

  return (
    <div data-testid="skill-places" className={`pb-2.5 ${indent ? 'pl-3 pr-4' : 'pl-[34px] pr-4'}`}>
      <div className="border-l border-line/80 pl-3">
        <p className="flex items-baseline justify-between gap-2 pb-1 text-[11px] text-ink-3">
          <span className="font-serif text-[12.5px] text-ink-2">Where {skill.name} loads</span>
          <span>new conversations</span>
        </p>
        <ul className="divide-y divide-line/60">
          {lines.map((l, i) => {
            const w = skillLineWords(l, i, lines, agentNames, page.names)
            const own = l.entry !== undefined
            const act = actOf(l)
            const key = `${l.place}:${l.agent ?? l.fact?.who ?? ''}`
            const who = l.agentName ?? l.agent ?? 'this agent'
            const pick = (to: SkillPosition): void => {
              if (act === 'project') {
                onProject!(to)
                return
              }
              if (act === 'machine' && to === 'off' && asking !== key) {
                setSaid(null)
                setAsking(key)
                return
              }
              if (act) void write(l, key, to)
            }
            const placeName = l.place === 'conversation' && here ? conversationLabel(here.title) : w.place
            const when = l.place === 'conversation' && here ? skillWhenWords(l.entry, here.mode) : null
            const label =
              act === 'agent'
                ? `${skill.name} for ${who} only`
                : act === 'conversation'
                  ? `${skill.name} in «${here!.title}» only`
                  : `${skill.name} — ${placeName.toLowerCase()}`
            return (
              <li key={key} data-place={l.place} data-result={l.result} className="py-1.5 text-[11.5px] leading-snug">
                {/* the place and its control on one line; whom it reaches beneath, full width */}
                <span className="flex items-baseline justify-between gap-3">
                  <span className={`truncate ${own ? 'text-ink' : 'text-ink-2'}`} title={placeName}>
                    {placeName}
                  </span>
                  {l.door ? (
                    l.door.url ? (
                      <a href={l.door.url} target="_blank" rel="noreferrer" className="shrink-0 text-[11px] text-ink-2 hover:text-terracotta">
                        Manage in {l.door.where} ›
                      </a>
                    ) : (
                      <span className="shrink-0 text-[11px] text-ink-3">changed in {l.door.where}</span>
                    )
                  ) : act ? (
                    <LinePositions
                      line={l}
                      label={label}
                      busy={busy?.key === key}
                      pending={busy?.key === key ? busy.to : asking === key ? 'off' : null}
                      onPick={pick}
                    />
                  ) : (
                    <span
                      className={`shrink-0 rounded-full px-1.5 font-mono text-[10.5px] leading-[17px] ${l.locked ? 'text-ink-3' : l.result === 'off' ? (own ? 'bg-ink-3/15 text-ink' : 'text-ink-3') : own ? 'bg-ink text-canvas' : 'text-ink-2'}`}
                    >
                      {positionWord(l.result)}
                    </span>
                  )}
                </span>
                <span className="mt-px block text-ink-3">
                  <span className="block">{w.locked ?? w.reach}</span>
                  {w.kept || w.follows || when ? (
                    <span className="block text-[10.5px]" {...(when ? { 'data-testid': 'line-when' } : {})}>
                      {w.kept ? <span className={l.store ? '' : 'font-mono'}>{w.kept}</span> : null}
                      {w.kept && (w.follows || when) ? <span> · </span> : null}
                      {w.follows ? <span>{w.follows}</span> : null}
                      {w.follows && when ? <span> · </span> : null}
                      {when ? <span>{when.text}</span> : null}
                      {when?.restart && here ? (
                        <>
                          {' '}
                          ·{' '}
                          <button
                            type="button"
                            onClick={() => void useStore.getState().openSession(here.folder, here.id, { exact: true })}
                            title="Its console takes the change when it restarts — ↻ in the conversation"
                            className="text-ink-2 hover:text-terracotta"
                          >
                            Back to restart its console ›
                          </button>
                        </>
                      ) : null}
                    </span>
                  ) : null}
                  {w.copies ? (
                    <span data-testid="line-copies" className="block text-[10.5px] text-ink-2">
                      {w.copies}
                    </span>
                  ) : null}
                  {l.refused?.why === 'home' ? (
                    <span className="block text-[10.5px]">this folder’s .claude is Claude Code’s own config folder — nothing switches here</span>
                  ) : null}
                </span>
                {act === 'machine' && asking === key ? (
                  <div
                    role="group"
                    aria-label="Confirm the switch"
                    data-testid="machine-confirm"
                    className="mt-1.5 mb-0.5 rounded-md bg-terracotta/[0.06] px-2.5 py-1.5"
                  >
                    <p className="text-ink-2">{machineOffSentence(null)}</p>
                    <span className="mt-1 flex items-baseline justify-end gap-3">
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void write(l, key, 'off')}
                        className="rounded-full border border-terracotta/50 px-2 py-px text-[11px] text-terracotta hover:bg-terracotta/10 disabled:opacity-50"
                      >
                        {busy?.key === key ? '…' : 'Turn off on this machine'}
                      </button>
                      <button type="button" onClick={() => setAsking(null)} className="text-[11px] text-ink-2 hover:text-ink">
                        Keep
                      </button>
                    </span>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
        {skill.shadowed ? (
          <p className="pt-1 text-[11px] leading-snug text-ink-3">This folder’s own copy never loads — your personal skill of the same name runs instead.</p>
        ) : null}
        {more > 0 ? (
          <p className="pt-1 text-[11px] text-ink-3">
            {more} other {more === 1 ? 'agent follows' : 'agents follow'} this project
          </p>
        ) : null}
        {said?.error ? (
          <p role="alert" className="pt-1 text-[11px] leading-snug text-ink-2">
            {said.error}
          </p>
        ) : null}
        {said?.missed ? (
          <p data-testid="machine-missed" className={`pt-1 text-[11px] leading-snug ${AMBER}`}>
            {said.missed}
          </p>
        ) : null}
      </div>
    </div>
  )
}
