// SkillsInventory.tsx — Settings › Skills: the READ-ONLY inventory of every
// skill on this machine's disk, and where each one sits (capability states:
// the folder is the only real unit). It used to offer Add/Remove
// per agent, writing agent.skills — a declaration since retired:
// it changed nothing the engine loads, a decorative switch. Switching is
// real only in a project's Skills, so each folder here is a DOOR
// there, never a toggle. (agent.skills itself is kept as data: session
// ownership tie-break, Graph «uses» edges and autocomplete still read it.)
//
// Sources, as the engines load them:
//   · personal ~/.claude/skills — every agent on this machine; Silos never
//     touches them;
//   · Silos' own skills (plugin/skills) — copied into a folder from its
//     Skills;
//   · enabled Claude Code plugins — on and off with the plugin, per folder
//     (the project's Tools);
//   · each agent folder's .claude/skills — in it (on) or turned off (held).
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { MASTER_ID } from '../lib/constants'
import type { SkillCatalogEntry, SkillReadme } from '../lib/types'
import { Markdown } from './Turn'
import { useGoHome } from './knows/go-home'

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1) || p

interface Place {
  kind: 'personal' | 'silos' | 'plugin' | 'folder'
  folder?: string
  plugin?: string
  /** a folder place: in it, turned off, or not there */
  state?: 'in' | 'off' | 'absent'
}
interface InventoryRow {
  name: string
  description?: string
  places: Place[]
}

/** Pure: the inventory from the machine-wide catalog (personal + plugins),
 *  Silos' own skills, and one catalog per agent folder. Only what sits on
 *  disk — a name seen only in a transcript is not inventory. A Silos skill
 *  lists EVERY folder (in · off · not there), so each folder has its door. */
export function buildSkillsInventory(
  machine: SkillCatalogEntry[],
  silos: { name: string; description?: string }[],
  folders: { folder: string; catalog: SkillCatalogEntry[] }[],
): InventoryRow[] {
  const rows = new Map<string, InventoryRow>()
  const row = (name: string, description?: string): InventoryRow => {
    const r = rows.get(name) ?? { name, places: [] }
    if (r.description === undefined && description) r.description = description
    rows.set(name, r)
    return r
  }
  for (const s of machine) {
    if (s.state !== 'active') continue
    if (s.source === 'user') row(s.name, s.description).places.push({ kind: 'personal' })
    else if (s.source === 'plugin' && s.plugin) row(s.name, s.description).places.push({ kind: 'plugin', plugin: s.plugin })
  }
  const silosNames = new Set(silos.map((s) => s.name))
  for (const s of silos) row(s.name, s.description).places.push({ kind: 'silos' })
  for (const { folder, catalog } of folders) {
    const here = new Map<string, 'in' | 'off'>()
    for (const s of catalog) {
      if (s.state === 'held') here.set(s.name, 'off')
      else if (s.state === 'active' && (s.source === 'project' || s.shadowed !== undefined)) here.set(s.name, 'in')
      else continue
      row(s.name, s.description)
    }
    for (const [name, state] of here) rows.get(name)!.places.push({ kind: 'folder', folder, state })
    for (const name of silosNames) if (!here.has(name)) rows.get(name)!.places.push({ kind: 'folder', folder, state: 'absent' })
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function SkillsCatalogTab() {
  const agents = useStore((s) => s.agents)
  const setModal = useStore((s) => s.setModal)
  const goHome = useGoHome()
  const [rows, setRows] = useState<InventoryRow[] | null>(null)
  const [selection, setSelection] = useState<string | null>(null)
  const [readme, setReadme] = useState<SkillReadme | null | undefined>(undefined)

  // one agent per folder reads that folder's catalog (the folder is the unit)
  const folders = useMemo(() => {
    const seen = new Map<string, string>()
    for (const a of agents) if (a.id !== MASTER_ID && a.folder && !seen.has(a.folder)) seen.set(a.folder, a.id)
    return [...seen].map(([folder, agentId]) => ({ folder, agentId }))
  }, [agents])
  const folderKey = folders.map((f) => `${f.folder}=${f.agentId}`).join('|')

  useEffect(() => {
    let cancelled = false
    const safe = <T,>(p: Promise<T>, fallback: T): Promise<T> => Promise.resolve(p).catch(() => fallback)
    void Promise.all([
      safe(api.skillsCatalog(MASTER_ID), [] as SkillCatalogEntry[]),
      safe(api.silosSkills(), [] as { name: string; description?: string }[]),
      Promise.all(folders.map(async (f) => ({ folder: f.folder, catalog: await safe(api.skillsCatalog(f.agentId), [] as SkillCatalogEntry[]) }))),
    ]).then(([machine, silos, perFolder]) => {
      if (!cancelled) setRows(buildSkillsInventory(machine ?? [], silos ?? [], perFolder))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderKey])

  useEffect(() => {
    if (!selection) return
    setReadme(undefined)
    Promise.resolve(api.skillReadme(selection))
      .then(setReadme)
      .catch(() => setReadme(null))
  }, [selection])

  const open = rows?.find((r) => r.name === selection) ?? null
  const agentsIn = (folder: string): string =>
    agents
      .filter((a) => a.id !== MASTER_ID && a.folder === folder)
      .map((a) => a.name)
      .join(' · ')

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
      <div className="max-h-44 w-full shrink-0 overflow-y-auto border-b border-line px-2 py-3 md:max-h-none md:w-60 md:border-b-0 md:border-r">
        <div className="mb-1 flex items-center justify-between px-1">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-2">On this machine</span>
          <button type="button" onClick={() => setModal('create-skill')} className="rounded-full px-1.5 text-[11px] text-ink-2 hover:bg-canvas hover:text-ink">
            + Create
          </button>
        </div>
        {!rows ? (
          <p className="px-2 py-2 text-xs text-ink-2">Reading the disk…</p>
        ) : rows.length === 0 ? (
          <p className="px-2 py-2 text-xs text-ink-2">No skills on disk yet.</p>
        ) : (
          <ul className="space-y-0.5">
            {rows.map((s) => (
              <li key={s.name}>
                <button
                  type="button"
                  aria-current={selection === s.name ? 'true' : undefined}
                  onClick={() => setSelection(s.name)}
                  className={`flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left ${selection === s.name ? 'bg-canvas' : 'hover:bg-canvas/60'}`}
                >
                  <span className="w-full truncate font-mono text-[12.5px] text-ink">{s.name}</span>
                  {s.description ? <span className="w-full truncate text-[11px] text-ink-2">{s.description}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-5 md:px-8">
        {!open ? (
          <div className="max-w-[62ch] text-sm text-ink-2">
            <p>Select a skill to see where it sits on disk.</p>
            <p className="mt-2 text-[12.5px]">
              This is the inventory. A skill is turned on, off or added per folder — in that project’s Skills, where the switch says which agents it reaches.
            </p>
            {/* what Welcome recommended with commands, said here in one line
                (Welcome has no commands) */}
            <p data-testid="skills-recommended" className="mt-2 text-[12.5px]">
              If your agents write code, Claude Code&rsquo;s <span className="font-mono text-ink">security-guidance</span> plugin reviews what they commit — add
              it from Claude Code&rsquo;s plugin list; it then shows in each project&rsquo;s Tools.
            </p>
          </div>
        ) : (
          <>
            <h2 className="mb-1 font-mono text-[15px] text-ink">{open.name}</h2>
            {(readme?.description ?? open.description) ? (
              <p className="mb-4 max-w-[62ch] text-sm text-ink-2">{readme?.description ?? open.description}</p>
            ) : null}
            <section aria-label="Where it is" className="mb-6">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-2">Where it is</h3>
              <ul className="space-y-1.5" data-testid="skill-places">
                {open.places.map((p, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]">
                    {p.kind === 'personal' ? (
                      <>
                        <span className="text-ink">This machine</span>
                        <span className="text-[12px] text-ink-2">~/.claude/skills — Silos never touches it</span>
                      </>
                    ) : p.kind === 'silos' ? (
                      <>
                        <span className="text-ink">Silos platform</span>
                        <span className="text-[12px] text-ink-2">plugin/skills — added to a folder from its Skills</span>
                      </>
                    ) : p.kind === 'plugin' ? (
                      <>
                        <span className="text-ink">From the {p.plugin?.split('@')[0]} plugin</span>
                        <span className="text-[12px] text-ink-2">on and off with the plugin, in a project’s Tools</span>
                      </>
                    ) : (
                      <>
                        <span className="font-mono text-[12.5px] text-ink">{basename(p.folder!)}</span>
                        <span className={`text-[12px] ${p.state === 'in' ? 'text-ink' : 'text-ink-2'}`}>
                          {p.state === 'in' ? 'in its folder' : p.state === 'off' ? 'turned off' : 'not there'}
                        </span>
                        {agentsIn(p.folder!) ? <span className="text-[11.5px] text-ink-3">· {agentsIn(p.folder!)}</span> : null}
                        <button
                          type="button"
                          onClick={() => goHome({ kind: 'project', folder: p.folder!, tab: 'skills', item: open.name })}
                          className="ml-auto text-[12px] text-ink-2 hover:text-terracotta"
                        >
                          Skills in {basename(p.folder!)} ›
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
            <div>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-2">Readme</h3>
              {readme === undefined ? (
                <p className="text-sm text-ink-2">Loading…</p>
              ) : readme === null ? (
                <p className="text-sm text-ink-2">No readme on disk for this skill.</p>
              ) : (
                <Markdown text={readme.body || '_(empty)_'} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
