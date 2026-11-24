// WhereItLoads — a Tools row, opened by its ▾ (spec scopes §4): «Where it
// loads», one line per place, broadest first, reading as it flows — each
// line follows the one above unless it says otherwise. A line: the place,
// whom it reaches, where it is kept (muted), and its state — its own entry
// in ink, «follows …» when it has none, the reason when it is locked. The
// account is a door, never a switch.
//
// A line the engine can write carries its own switch (the state pill is the
// button):
//  · «This machine» — the user's own settings, every project and every login
//    Silos connects; its «off» says first how many projects load it now and
//    waits for a yes; the answer names any login that did not follow;
//  · «This project» — the project's own file: on a project's page, and on
//    an agent's page once it said whom it reaches (every agent of the
//    project, by name — the server carries them on that line);
//  · «Only <agent>» — every agent's on a project's page, that agent's own on
//    its page: kept by Silos and carried into that agent's launches
//    (`onSwitch`, the page's); a click that reaches more than its line (a
//    server several plugins ship, a namesake) says so first.
//  · an account origin's HEAD (`head`: everything it sends of one kind) —
//    the same block, its key at each place; its machine «off» says the
//    engine's sentence (`asks`) and waits for a yes, the request then says
//    it was confirmed (the server refuses it otherwise).
//  · your personal instructions (`row.kind` personal, spec scopes T10) —
//    the same block; its project line writes through the page's `onFile`
//    (the folder's own switch), its machine line is the file itself (a door).
//  · «Conversation · <title>» on its agent's page opened from it (spec
//    scope-ui-review §4.3): that conversation's own entry, kept by Silos —
//    its second line says when it takes effect (from its next message ·
//    when this console is reopened · from its next run) or that it didn't
//    take; the column only points here;
//  · «Make it <agent>’s alone» beside an agent line (a project's page, a row
//    with a family): one gesture for «this tool is Builder's alone» — the two-sided
//    set, said first (the server's plan) and written on a yes: an override
//    kind off in the project and on for that agent; an off-only kind on in
//    the project and off for every other agent (spec scopes §4).
// A line whose own «off» is its origin's head (`headOff`) adds only this one
// on «on» there — said first (rule 4 per place).
// Every other line reads.
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { api } from '../../lib/api'
import { useStore } from '../../store'
import type { LoadsLine, LoadsOrigin, LoadsScope, OnlyAgentPlan } from '../../lib/types'
import {
  addAtWords,
  alsoIn,
  blockLines,
  conversationLabel,
  lineWords,
  machineOffSentence,
  missedWords,
  placesOf,
  type PlacesFrom,
  type PlacesPage,
  type PlacesSubject,
} from '../../lib/loads-places'
import { whenWords } from '../../lib/here-tools'

const AMBER = 'text-[var(--health-amber)]'

/** ▾ beside a row's switch — always visible on a row that has places. */
export function WhereToggle({ open, label, onToggle }: { open: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={`Where ${label} loads`}
      title="Where it loads"
      onClick={onToggle}
      data-testid="where-toggle"
      className={`mt-px shrink-0 rounded-full p-0.5 transition-colors ${open ? 'bg-canvas text-ink' : 'text-ink-3 hover:text-ink'}`}
    >
      <ChevronDown size={12} aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
  )
}

type FileScope = 'machine' | 'project'

/** Which switch a line has on this page: a file place this block writes
 *  itself, an agent's (the page's `onSwitch`), the conversation the page
 *  was opened from, or none. `projectHere`: the project line can be written
 *  from an agent's page (a row's own key, or the page's `onFile`). */
function switchOf(
  l: LoadsLine,
  page: PlacesPage,
  folder: string | null,
  agentSwitch: boolean,
  machineOnly: boolean,
  projectHere: boolean,
  convHere: boolean,
): FileScope | 'agent' | 'conversation' | null {
  if (!l.switch || l.locked) return null
  // an agent's line: every agent's on a project's page, its own on an agent's
  if (l.place === 'agent') return agentSwitch && (page.scope === 'project' || l.agent === page.agentId) ? 'agent' : null
  if (l.place === 'conversation') return page.scope === 'agent' && page.from && l.conversation === page.from.thread && convHere ? 'conversation' : null
  if (l.place === 'machine' && machineOnly) return 'machine'
  if (folder === null) return null
  if (l.place === 'machine') return 'machine'
  if (l.place === 'project' && (page.scope === 'project' || projectHere)) return 'project'
  return null
}

export function WhereItLoads({
  row,
  head,
  machineEngine,
  page,
  indent,
  folder = null,
  onChanged,
  onSwitch,
  onFile,
  onConversation,
  busy,
  scopes,
  conversations,
}: {
  row: PlacesSubject
  page: PlacesPage
  indent: boolean
  /** the doors of the conversations a line names (FolderLoads.conversations) */
  conversations?: { thread: string; folder: string; id: string; title: string }[]
  /** the block is an account origin's head: its key is what each line writes */
  head?: LoadsOrigin['id']
  /** a head outside any folder (Settings): its machine line writes through
   *  that engine's machine head, no folder */
  machineEngine?: string
  /** the row's engine's places (FolderLoads.engines[].scopes): whom its
   *  machine and project lines reach, and which are kept by Silos */
  scopes?: readonly LoadsScope[]
  /** the folder whose files the machine and project lines write (null: they read) */
  folder?: string | null
  /** after a machine or project line wrote: the page reads the rows again */
  onChanged?: () => void
  /** an agent line flipped (Project › Tools): its agent and the new state */
  onSwitch?: (line: LoadsLine, to: 'on' | 'off') => void
  /** the agent line whose click is on its way */
  busy?: string | null
  /** the file lines write through the page's own switch, not the loads route
   *  (personal instructions: the project's; an instruction file: the
   *  project's and, auto memory, the machine's — `confirmed` after its yes) */
  onFile?: (to: 'on' | 'off', scope: FileScope, confirmed: boolean) => Promise<void>
  /** the conversation's line writes through the page (a row that is no
   *  Tools row: your personal instructions); absent: the loads route */
  onConversation?: (to: 'on' | 'off') => Promise<void>
}) {
  const { lines, more } = blockLines(row, page)
  const places = placesOf(scopes)
  // whom the project line reaches: every agent of the project — on an
  // agent's page the server names them on that line (their own lines stay out)
  const projectLine = (row.at ?? []).find((l) => l.place === 'project')
  const agentNames = projectLine?.agents ?? (row.at ?? []).filter((l) => l.place === 'agent').map((l) => l.agentName ?? l.agent ?? '')
  const from: PlacesFrom | null = page.scope === 'agent' ? (page.from ?? null) : null
  const projectHere = page.scope === 'agent' && (onFile !== undefined || (head === undefined && row.kind !== 'personal'))
  const convHere = from !== null && (onConversation !== undefined || (folder !== null && head === undefined && row.kind !== 'personal'))
  const [asking, setAsking] = useState<string | null>(null)
  const [reach, setReach] = useState<number | null>(null)
  const [writing, setWriting] = useState<FileScope | 'conversation' | null>(null)
  const [said, setSaid] = useState<{ error?: string; missed?: string } | null>(null)
  const [only, setOnly] = useState<{ lineKey: string; plan: OnlyAgentPlan } | null>(null)
  const [onlyBusy, setOnlyBusy] = useState(false)
  // «Only <agent>»: the plan first, the set on a yes
  async function askOnly(l: LoadsLine, lineKey: string): Promise<void> {
    if (folder === null || !l.agent) return
    setSaid(null)
    setOnlyBusy(true)
    try {
      const a = await api.folders.loadsOnly(folder, row.key, l.agent, true)
      if (a.preview) setOnly({ lineKey, plan: a.preview })
    } catch (e) {
      setSaid({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      setOnlyBusy(false)
    }
  }
  async function writeOnly(): Promise<void> {
    if (folder === null || !only) return
    setOnlyBusy(true)
    try {
      await api.folders.loadsOnly(folder, row.key, only.plan.agent, false)
      setOnly(null)
      onChanged?.()
    } catch (e) {
      setSaid({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      setOnlyBusy(false)
    }
  }
  // the agent loads it and no other agent of the project does: already its alone
  const alone = (l: LoadsLine): boolean =>
    l.result === 'on' &&
    lines.every((x) => x.place !== 'agent' || x === l || x.result === 'off') &&
    (row.at ?? []).filter((x) => x.place === 'agent' && x.agent !== l.agent).every((x) => x.result === 'off')

  async function write(scope: FileScope, to: 'on' | 'off', confirmed = false): Promise<void> {
    const outside = head !== undefined && machineEngine !== undefined && scope === 'machine'
    if (folder === null && !outside) return
    setWriting(scope)
    setSaid(null)
    try {
      if (onFile) {
        await onFile(to, scope, confirmed)
        setAsking(null)
        onChanged?.()
        return
      }
      const a = outside
        ? await api.folders.machineHeadSwitch(machineEngine, head, to, confirmed)
        : head && folder !== null
          ? await api.folders.loadsOriginAt(
              folder,
              head,
              to,
              scope === 'machine' ? { scope: 'machine', ...(confirmed ? { confirmed: true } : {}) } : { scope: 'project' },
            )
          : await api.folders.loadsSwitchAt(folder!, row.key, to, scope)
      setAsking(null)
      const missed = missedWords(a.logins?.missed ?? [])
      if (missed) setSaid({ missed })
      onChanged?.()
    } catch (e) {
      setSaid({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      setWriting(null)
    }
  }
  // «Also off in «title» ›»: this tab opened from that conversation, where
  // its line switches — on an agent's page the page itself re-aims; on a
  // project's, that conversation's agent page, on this tab
  async function openFrom(d: { folder: string; id: string }): Promise<void> {
    const st = useStore.getState()
    if (page.scope === 'agent') {
      st.setAgentFrom(d)
      return
    }
    await st.openSession(d.folder, d.id)
    useStore.getState().openDossier(row.kind === 'personal' ? 'memory' : 'tools')
  }
  // the conversation's own entry (its agent's page opened from it)
  async function writeHere(to: 'on' | 'off'): Promise<void> {
    if (!from) return
    setWriting('conversation')
    setSaid(null)
    try {
      if (onConversation) await onConversation(to)
      else await api.folders.loadsSwitchHere(folder!, row.key, to, from.id)
      onChanged?.()
    } catch (e) {
      setSaid({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      setWriting(null)
    }
  }
  // the machine's «off» reaches every project: said first, with the count
  async function askMachineOff(lineKey: string): Promise<void> {
    if (folder === null) return
    setSaid(null)
    setReach(null)
    setAsking(lineKey)
    try {
      setReach((await api.folders.loadsReach(folder, row.key)).projects)
    } catch {
      setReach(null)
    }
  }

  return (
    <div data-testid="where-it-loads" className={`pb-2.5 ${indent ? 'pl-3 pr-4' : 'pl-[34px] pr-4'}`}>
      <div className="border-l border-line/80 pl-3">
        <p className="flex items-baseline justify-between gap-2 pb-1 text-[11px] text-ink-3">
          <span className="font-serif text-[12.5px] text-ink-2">
            Where {row.label} {head || row.kind === 'personal' ? 'load' : 'loads'}
          </span>
          <span>new conversations</span>
        </p>
        <ul className="divide-y divide-line/60">
          {lines.map((l, i) => {
            const w = lineWords(l, i, lines, row, agentNames, places, page.names)
            const own = l.entry !== undefined
            const sw = switchOf(l, page, folder, onSwitch !== undefined, head !== undefined && machineEngine !== undefined, projectHere, convHere)
            const to: 'on' | 'off' = l.result === 'on' ? 'off' : 'on'
            const who = l.agentName ?? l.agent ?? 'this agent'
            const reaches = l.switch?.reaches?.length ?? 0
            const lineKey = `${l.place}:${l.agent ?? l.fact?.who ?? ''}`
            const placeName = l.place === 'conversation' && from ? conversationLabel(from.title) : w.place
            const waiting = sw === 'agent' ? busy === l.agent : sw !== null && writing === sw
            // what this click says first: a reach, the engine's own sentence,
            // or rule 4 here (only this one is added)
            const adds = to === 'on' && l.headOff ? addAtWords(row.label, sw === 'agent' ? `for ${who}` : 'on this machine') : null
            const sentence = l.asks ?? adds
            // the conversation's own entry: when it takes effect, or that it didn't
            const when = l.place === 'conversation' && from ? whenWords(l, from.mode) : null
            const flip = (): void => {
              if (sw === 'agent') {
                if ((reaches > 0 || adds) && asking !== lineKey) {
                  setAsking(lineKey)
                  return
                }
                setAsking(null)
                onSwitch!(l, to)
              } else if (sw === 'conversation') void writeHere(to)
              // the project line from an agent's page: whom it reaches, said first
              else if (sw === 'project' && page.scope === 'agent' && asking !== lineKey) {
                setSaid(null)
                setAsking(lineKey)
              } else if (sw === 'machine' && sentence && asking !== lineKey) {
                setSaid(null)
                setAsking(lineKey)
              } else if (sw === 'machine' && sentence) void write('machine', to, true)
              else if (sw === 'machine' && to === 'off' && !head) void askMachineOff(lineKey)
              else if (sw) void write(sw, to)
            }
            const label =
              sw === 'agent'
                ? `${row.label} for ${who}: ${l.result} — turn ${to} for ${who} only`
                : sw === 'conversation'
                  ? `${row.label} in «${from!.title}»: ${l.result} — turn ${to} for this conversation only`
                  : `${row.label} — ${placeName.toLowerCase()}: ${l.result} — turn ${to}`
            return (
              <li key={lineKey} data-place={l.place} data-result={l.result} className="py-1.5 text-[11.5px] leading-snug">
                {/* the place and its state on one line; whom it reaches beneath, full width */}
                <span className="flex items-baseline justify-between gap-3">
                  <span className={`min-w-0 truncate ${own ? 'text-ink' : 'text-ink-2'}`} title={placeName}>
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
                  ) : sw ? (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={l.result === 'on'}
                      disabled={waiting || writing !== null}
                      aria-label={label}
                      title={
                        sw === 'agent'
                          ? `Turn ${to} for ${who} only`
                          : sw === 'conversation'
                            ? `Turn ${to} for this conversation only`
                            : `Turn ${to} — ${placeName.toLowerCase()}`
                      }
                      data-testid={sw === 'agent' ? 'line-switch' : `place-switch-${sw}`}
                      onClick={flip}
                      className={`shrink-0 rounded-full border px-1.5 font-mono text-[10.5px] leading-[15px] transition-colors disabled:opacity-50 ${asking === lineKey ? 'ring-1 ring-terracotta/50' : ''} ${
                        l.result === 'on'
                          ? own
                            ? 'border-ink bg-ink text-canvas hover:bg-ink-2'
                            : 'border-line text-ink-2 hover:border-ink-3 hover:text-ink'
                          : own
                            ? 'border-terracotta/50 bg-terracotta/10 text-terracotta hover:bg-terracotta/15'
                            : 'border-line text-ink-3 hover:border-ink-3 hover:text-ink'
                      }`}
                    >
                      {waiting ? '…' : l.result}
                    </button>
                  ) : (
                    <span
                      className={`shrink-0 rounded-full px-1.5 font-mono text-[10.5px] leading-[17px] ${l.locked ? 'text-ink-3' : l.result === 'on' ? (own ? 'bg-ink text-canvas' : 'text-ink-2') : own ? 'bg-ink-3/15 text-ink' : 'text-ink-3'}`}
                    >
                      {l.result}
                    </span>
                  )}
                </span>
                <span className="mt-px block min-w-0 text-ink-3">
                  <span className="block">{w.locked ?? w.reach}</span>
                  {w.kept || w.follows || when ? (
                    <span className="block text-[10.5px]" {...(when ? { 'data-testid': 'line-when' } : {})}>
                      {w.kept ? <span className="font-mono">{w.kept}</span> : null}
                      {w.kept && (w.follows || when) ? <span> · </span> : null}
                      {w.follows ? <span>{w.follows}</span> : null}
                      {w.follows && when ? <span> · </span> : null}
                      {when ? <span className={when.amber ? AMBER : ''}>{when.text}</span> : null}
                      {when?.restart && from ? (
                        <>
                          {' '}
                          ·{' '}
                          <button
                            type="button"
                            onClick={() => void useStore.getState().openSession(from.folder, from.id, { exact: true })}
                            title="Its console takes the change when it restarts — ↻ in the conversation"
                            className="text-ink-2 hover:text-terracotta"
                          >
                            Back to restart its console ›
                          </button>
                        </>
                      ) : null}
                    </span>
                  ) : null}
                  {l.refused?.why === 'engine' ? (
                    <span className="block text-[10.5px]">
                      switched with {row.engine} {l.refused.needs} or later — Settings › Engines
                    </span>
                  ) : null}
                  {l.refused?.why === 'file' ? (
                    <span data-testid="line-refused" className={`block text-[10.5px] ${AMBER}`}>
                      {l.refused.reason}.
                    </span>
                  ) : null}
                  {/* the gesture: this tool is that agent's alone (a verb, never a place's name) */}
                  {sw === 'agent' && page.scope === 'project' && 'family' in row && row.family && folder !== null && !alone(l) ? (
                    <button
                      type="button"
                      data-testid="only-agent"
                      disabled={onlyBusy}
                      onClick={() => void askOnly(l, lineKey)}
                      title={`Make ${row.label} ${who}’s alone — the project and every other agent move with it`}
                      className="mt-0.5 block text-[10.5px] text-ink-2 underline decoration-ink-3/40 decoration-dotted underline-offset-[3px] hover:text-terracotta disabled:opacity-50"
                    >
                      Make it {who}’s alone
                    </button>
                  ) : null}
                  {/* this place's own entry didn't take (the row's amber line says where it was read) */}
                  {l.proof && l.place !== 'conversation' ? (
                    <span data-testid="line-proof" className={`block text-[10.5px] ${AMBER}`}>
                      {l.proof.to === 'off' ? 'still loaded — didn’t take' : 'didn’t load — didn’t take'}
                    </span>
                  ) : null}
                </span>
                {sw === 'agent' && asking === lineKey ? (
                  <span className="flex flex-wrap items-baseline gap-x-2 pt-1 text-[11px] text-ink-2">
                    <span>
                      {adds ??
                        `Also turns ${to} ${reaches === 1 ? 'one other row' : `${reaches} other rows`} for ${who} — the same name reaches ${reaches === 1 ? 'it' : 'them'}.`}
                    </span>
                    <button type="button" onClick={flip} className="text-terracotta hover:underline">
                      Turn {to} for {who}
                    </button>
                    <button type="button" onClick={() => setAsking(null)} className="text-ink-3 hover:text-ink">
                      Cancel
                    </button>
                  </span>
                ) : null}
                {sw === 'project' && page.scope === 'agent' && asking === lineKey ? (
                  <div
                    role="group"
                    aria-label="Confirm the switch"
                    data-testid="project-confirm"
                    className="mt-1.5 mb-0.5 rounded-md bg-terracotta/[0.06] px-2.5 py-1.5"
                  >
                    <p className="text-ink-2">
                      Turns it {to} in this project — {agentNames.length > 0 ? `for ${agentNames.join(' · ')}, and` : 'for'} what you start here by hand.
                    </p>
                    <span className="mt-1 flex items-baseline justify-end gap-3">
                      <button
                        type="button"
                        disabled={writing !== null}
                        onClick={() => void write('project', to)}
                        className="rounded-full border border-terracotta/50 px-2 py-px text-[11px] text-terracotta hover:bg-terracotta/10 disabled:opacity-50"
                      >
                        {writing === 'project' ? '…' : `Turn ${to} in this project`}
                      </button>
                      <button type="button" onClick={() => setAsking(null)} className="text-[11px] text-ink-2 hover:text-ink">
                        Keep
                      </button>
                    </span>
                  </div>
                ) : null}
                {only?.lineKey === lineKey ? (
                  <div
                    role="group"
                    aria-label={`Make it ${who}’s alone`}
                    data-testid="only-confirm"
                    className="mt-1.5 mb-0.5 rounded-md bg-terracotta/[0.06] px-2.5 py-1.5"
                  >
                    <p className="text-ink-2">{onlyWords(only.plan, who)}</p>
                    <span className="mt-1 flex items-baseline justify-end gap-3">
                      <button
                        type="button"
                        disabled={onlyBusy}
                        onClick={() => void writeOnly()}
                        className="rounded-full border border-terracotta/50 px-2 py-px text-[11px] text-terracotta hover:bg-terracotta/10 disabled:opacity-50"
                      >
                        {onlyBusy ? '…' : `Make it ${who}’s alone`}
                      </button>
                      <button type="button" onClick={() => setOnly(null)} className="text-[11px] text-ink-2 hover:text-ink">
                        Keep
                      </button>
                    </span>
                  </div>
                ) : null}
                {sw === 'machine' && asking === lineKey ? (
                  <div
                    role="group"
                    aria-label="Confirm the switch"
                    data-testid="machine-confirm"
                    className="mt-1.5 mb-0.5 rounded-md bg-terracotta/[0.06] px-2.5 py-1.5"
                  >
                    <p className="text-ink-2">{sentence ?? machineOffSentence(reach, places.logins)}</p>
                    <span className="mt-1 flex items-baseline justify-end gap-3">
                      <button
                        type="button"
                        disabled={writing !== null}
                        onClick={() => void write('machine', to, sentence !== null)}
                        className="rounded-full border border-terracotta/50 px-2 py-px text-[11px] text-terracotta hover:bg-terracotta/10 disabled:opacity-50"
                      >
                        {writing === 'machine' ? '…' : to === 'off' ? 'Turn off on this machine' : adds ? 'Add on this machine' : 'Turn on for this machine'}
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
        {more > 0 ? (
          <p className="pt-1 text-[11px] text-ink-3">
            {more} other {more === 1 ? 'agent follows' : 'agents follow'} this project
          </p>
        ) : null}
        {/* another conversation that differs: a fact and its door (its own
            line switches on this page opened from it) */}
        {alsoIn(row, page, conversations).map((a, i) => (
          <p key={i} className="pt-1 text-[11px] text-ink-3" data-testid="also-in">
            {a.words}{' '}
            {a.door ? (
              <button type="button" data-testid="also-in-door" onClick={() => void openFrom(a.door!)} className="text-ink-2 hover:text-terracotta">
                «{a.title}» ›
              </button>
            ) : (
              <span>{a.title}</span>
            )}
          </p>
        ))}
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

/** «Only <agent>», said before it writes (spec scopes §4). */
export function onlyWords(p: OnlyAgentPlan, who: string): string {
  if (p.family === 'override') return `Off in this project, on for ${who} — an agent added later won’t load it.`
  const others = p.agents.filter((a) => a.id !== p.agent && a.to === 'off').length
  const off = others === 0 ? 'no other agent here' : p.others.length <= 2 ? p.others.join(' and ') : `${p.others.length} other agents`
  return `On in this project, off for ${off} — an agent added later will load it.`
}
