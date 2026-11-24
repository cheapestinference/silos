// BulkHead — «Turn all off in this project ▾» / «Turn all on for Builder ▾»
// on a head of Tools (an origin group's, or the tab's), spec scopes §4. The
// button names its place (spec scope-ui-review §3.6): the head beside it is
// an ORIGIN, and must never read as the button's reach. The plain click is
// the page's own place; ▾ lists the OTHER places by their block labels and
// reach words.
// Nothing is written on the first click: it asks the server what it would
// change and says it, counts first — «Turns off 23 things for Builder — 4
// plugins, 14 MCP servers, 5 connectors. 2 are decided elsewhere. What you
// set up later will load.» — and waits for a yes. After it, «Undo» on this
// head while that place still reads as the click left it (the server keeps
// the set, one per place, and drops it when it no longer holds).
// An account group goes by its head key: what the account sends later is
// covered too, and said.
// On Skills (`skills`) the same head, its rows skills: «Turns off 5 skills
// in this project. 1 is decided elsewhere. Skills added later will load.»
import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { api } from '../../lib/api'
import type { BulkPlace, BulkPreview, BulkSkill, BulkUndoView, SkillCatalogEntry } from '../../lib/types'

export interface BulkPlaceOption {
  place: BulkPlace
  /** the line's own label in «Where it loads»: «Project · acme», «This machine», «Agent · 🛠 Builder» */
  label: string
  /** whom it reaches, in the block's words */
  reach: string
  /** the preposition the sentence uses: «in this project», «on this machine», «for Builder» */
  where: string
}

/** a skill as a click on Skills names it — the copies whose places the
 *  engine answers (complete-service.ts withPlaces), a plugin's among them
 *  (counted as decided elsewhere, never written); null: none (one Silos
 *  could add) */
export function bulkSkillOf(s: SkillCatalogEntry): BulkSkill | null {
  if (s.source === 'account') return { name: s.name, from: 'account' }
  if (s.source === 'user' && (s.state === 'active' || s.state === 'held')) return { name: s.name, from: 'personal' }
  if ((s.source === 'project' && s.state === 'active') || (s.source === undefined && s.state === 'held' && s.stillLoads === undefined))
    return { name: s.name, from: 'project' }
  if (s.source === 'plugin' && s.state === 'active') return { name: s.name, from: 'plugin' }
  return null
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** The sentence a bulk click says before it acts (and after, past tense). */
export function bulkSentence(p: BulkPreview, where: string, done = false): string {
  const verb = done ? (p.to === 'off' ? 'Turned off' : 'Turned on') : p.to === 'off' ? 'Turns off' : 'Turns on'
  if (p.changes.skill !== undefined) {
    const n = p.changes.skill
    const account = p.heads.includes('skills')
    const head = account
      ? `${verb} the ${n > 0 ? `${n} ` : ''}skill${n === 1 ? '' : 's'} your Claude account sends ${where}.`
      : n > 0
        ? `${verb} ${plural(n, 'skill', 'skills')} ${where}.`
        : ''
    const cannot = p.cannot > 0 ? ` ${p.cannot} ${p.cannot === 1 ? 'is' : 'are'} decided elsewhere.` : ''
    const later = done
      ? ''
      : account
        ? p.to === 'off'
          ? ' What it sends later won’t load either.'
          : ' What it sends later will load too.'
        : p.to === 'off'
          ? ' Skills added later will load.'
          : ''
    return `${head}${cannot}${later}`.trim()
  }
  const { plugin, mcp, connector } = p.changes
  const total = plugin + mcp + connector
  const parts = [
    plugin ? plural(plugin, 'plugin', 'plugins') : '',
    mcp ? plural(mcp, 'MCP server', 'MCP servers') : '',
    connector ? plural(connector, 'connector', 'connectors') : '',
  ].filter(Boolean)
  const head =
    total > 0
      ? `${verb} ${plural(total, 'thing', 'things')} ${where}${parts.length > 1 ? ` — ${parts.join(', ')}` : ''}.`
      : p.heads.length > 0
        ? `${verb} what your Claude account sends ${where}.`
        : ''
  const cannot = p.cannot > 0 ? ` ${p.cannot} ${p.cannot === 1 ? 'is' : 'are'} decided elsewhere.` : ''
  const later = done
    ? ''
    : p.heads.length > 0
      ? p.to === 'off'
        ? ' What your Claude account sends later won’t load either.'
        : ' What your Claude account sends later will load too.'
      : p.to === 'off'
        ? ' What you set up later will load.'
        : ''
  return `${head}${cannot}${later}`.trim()
}

const sameUndo = (u: BulkUndoView, p: BulkPlace): boolean => u.scope === p.scope && (p.scope !== 'agent' || u.agent === p.agent)

export function BulkHead({
  folder,
  group,
  keys,
  origins,
  skills,
  anyOn,
  places,
  undo,
  onChanged,
  className = '',
}: {
  folder: string
  /** the head's own id (kept with the undo set: «Undo» shows on this head only) */
  group: string
  /** the rows this head shows */
  keys: string[]
  /** the account heads this group holds */
  origins: ('plugins' | 'connectors' | 'skills')[]
  /** a head of Skills: the skills it shows (keys then empty) */
  skills?: BulkSkill[]
  /** something under this head loads at the page's place: the head offers «off» */
  anyOn: boolean
  /** the page's place first, then the others ▾ lists */
  places: BulkPlaceOption[]
  /** this folder's undo sets that still hold */
  undo: readonly BulkUndoView[]
  onChanged: () => void
  className?: string
}) {
  const [to, setTo] = useState<'on' | 'off'>(anyOn ? 'off' : 'on')
  useEffect(() => {
    setTo(anyOn ? 'off' : 'on')
  }, [anyOn])
  const [menu, setMenu] = useState(false)
  const [asked, setAsked] = useState<{ place: BulkPlaceOption; preview: BulkPreview } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menu])
  const mine = undo.find((u) => u.group === group && places.some((p) => sameUndo(u, p.place)))
  const mineWhere = mine ? places.find((p) => sameUndo(mine, p.place)) : undefined
  if (places.length === 0 || (keys.length === 0 && origins.length === 0 && !skills?.length)) return null
  const body = { keys, origins, ...(skills?.length ? { skills } : {}) }

  async function ask(place: BulkPlaceOption, dir: 'on' | 'off'): Promise<void> {
    setMenu(false)
    setError(null)
    setBusy(true)
    try {
      const a = await api.folders.loadsBulk(folder, { ...body, to: dir, group, preview: true, ...place.place })
      if (a.preview) setAsked({ place, preview: a.preview })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  async function yes(): Promise<void> {
    if (!asked) return
    setBusy(true)
    setError(null)
    try {
      const place: BulkPlace = asked.place.place.scope === 'machine' && asked.preview.asks?.length ? { scope: 'machine', confirmed: true } : asked.place.place
      await api.folders.loadsBulk(folder, { ...body, to: asked.preview.to, group, ...place })
      setAsked(null)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  async function undoIt(): Promise<void> {
    if (!mine || !mineWhere) return
    setBusy(true)
    setError(null)
    try {
      await api.folders.loadsBulkUndo(folder, { group, ...mineWhere.place })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      onChanged()
    }
  }

  const reaches = asked
    ? asked.preview.changes.plugin +
      asked.preview.changes.mcp +
      asked.preview.changes.connector +
      (asked.preview.changes.skill ?? 0) +
      asked.preview.heads.length
    : 0
  const verb = to === 'off' ? 'Turn all off' : 'Turn all on'
  const label = `${verb} ${places[0]!.where}`
  const others = places.slice(1)
  return (
    <>
      <span
        ref={menuRef}
        className={`relative flex shrink-0 items-stretch self-center rounded-full border border-line text-[11px] leading-[16px] ${className}`}
        data-testid="bulk-head"
      >
        <button
          type="button"
          disabled={busy}
          onClick={() => void ask(places[0]!, to)}
          title={`${label} — ${places[0]!.reach}`}
          className={`${others.length === 0 ? 'rounded-full pr-2' : 'rounded-l-full pr-1.5'} py-px pl-2 text-ink-2 hover:bg-canvas hover:text-ink disabled:opacity-50`}
        >
          {busy && !asked ? '…' : label}
        </button>
        {others.length === 0 ? null : (
          <>
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={menu}
              aria-label={`${verb} — another place`}
              onClick={() => setMenu((m) => !m)}
              className="flex items-center rounded-r-full border-l border-line pl-1 pr-1.5 text-ink-3 hover:bg-canvas hover:text-ink"
            >
              <ChevronDown size={11} aria-hidden="true" className={`transition-transform ${menu ? 'rotate-180' : ''}`} />
            </button>
            {menu ? (
              <div
                role="menu"
                aria-label={`${verb} at another place`}
                className="absolute right-0 top-full z-20 mt-1 w-64 rounded-md border border-line bg-panel py-1 shadow-[0_6px_20px_-8px_rgba(0,0,0,0.25)]"
              >
                <p className="px-3 pb-0.5 pt-1 text-[11px] text-ink-3">{verb} at another place</p>
                {others.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    role="menuitem"
                    aria-label={`${verb} ${p.where}`}
                    onClick={() => void ask(p, to)}
                    className="block w-full px-3 py-1.5 text-left hover:bg-canvas"
                  >
                    <span className="block truncate text-[12px] text-ink" title={p.label}>
                      {p.label}
                    </span>
                    <span className="block text-[11px] leading-snug text-ink-3">{p.reach}</span>
                  </button>
                ))}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setTo(to === 'off' ? 'on' : 'off')
                    setMenu(false)
                  }}
                  className="mt-1 block w-full border-t border-line/70 px-3 pb-1 pt-1.5 text-left text-[11px] text-ink-2 hover:text-ink"
                >
                  {to === 'off' ? 'Turn all on instead' : 'Turn all off instead'}
                </button>
              </div>
            ) : null}
          </>
        )}
      </span>
      {asked || error || mine ? (
        <div className="basis-full" data-testid="bulk-said">
          {asked ? (
            <div role="group" aria-label="Confirm all at once" className="mt-1.5 rounded-md bg-terracotta/[0.06] px-2.5 py-1.5 text-[11.5px] leading-snug">
              <p className="text-ink-2">
                {reaches > 0
                  ? bulkSentence(asked.preview, asked.place.where)
                  : `Nothing to turn ${asked.preview.to} ${asked.place.where}.${asked.preview.cannot > 0 ? ` ${asked.preview.cannot} ${asked.preview.cannot === 1 ? 'is' : 'are'} decided elsewhere.` : ''}`}
              </p>
              {asked.preview.asks?.map((s) => (
                <p key={s} className="mt-1 text-ink-2">
                  {s}
                </p>
              ))}
              <span className="mt-1 flex items-baseline justify-end gap-3">
                {reaches > 0 ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void yes()}
                    data-testid="bulk-yes"
                    className="rounded-full border border-terracotta/50 px-2 py-px text-[11px] text-terracotta hover:bg-terracotta/10 disabled:opacity-50"
                  >
                    {busy ? '…' : `Turn ${asked.preview.to} ${asked.place.where}`}
                  </button>
                ) : null}
                <button type="button" onClick={() => setAsked(null)} className="text-[11px] text-ink-2 hover:text-ink">
                  {reaches > 0 ? 'Keep' : 'Close'}
                </button>
              </span>
            </div>
          ) : mine && mineWhere ? (
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-[11.5px] text-ink-3" data-testid="bulk-undo">
              <span>
                {bulkSentence(
                  {
                    to: mine.to,
                    scope: mine.scope,
                    changes: {
                      plugin: mine.counts.plugin ?? 0,
                      mcp: mine.counts.mcp ?? 0,
                      connector: mine.counts.connector ?? 0,
                      ...(mine.kind === 'skills' ? { skill: mine.counts.skill ?? 0 } : {}),
                    },
                    heads: mine.counts.heads ? [mine.kind === 'skills' ? 'skills' : 'plugins'] : [],
                    cannot: 0,
                  },
                  mineWhere.where,
                  true,
                )}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void undoIt()}
                className="text-ink-2 underline decoration-ink-3/40 underline-offset-[3px] hover:text-terracotta disabled:opacity-50"
              >
                Undo
              </button>
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-1 text-[11px] leading-snug text-ink-2">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
