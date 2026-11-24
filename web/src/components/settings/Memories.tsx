// settings/Memories.tsx — Settings › Memories (each thing has
// one house; same grammar as Skills). The machine's memory files, in the
// four layers Claude Code and Silos load: the global ~/.claude/CLAUDE.md —
// whose house IS here, so it is read and edited here — and every project's
// CLAUDE.md, every agent's memory and every project's auto-memory, whose
// houses are their pages: here they are read, and their door says where
// they are changed. Never a second editor for a file that lives elsewhere.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { buildCatalog, type Catalog } from '../../lib/catalog'
import { MASTER_ID, ANYWHERE_LABEL } from '../../lib/constants'
import { basename } from '../../lib/routes'
import type { AgentView, MemoryFileInfo, MemoryRow } from '../../lib/types'
import { Markdown } from '../Turn'
import { MachineSaveConfirm, needsMachineConfirm } from '../knows/MachineSaveConfirm'

// where a file is changed: here (the global one) or its owner's page
type House = { kind: 'here' } | { kind: 'fact'; why: string } | { kind: 'project'; folder: string } | { kind: 'agent'; agent: AgentView }

interface Selection {
  file: MemoryFileInfo
  house: House
}

// A section of the list: its title is the place's own label (lib/owners.ts —
// «This machine», «Projects», «Agents»), said once; no pill.
function ListSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 px-2 pb-1">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-2">{title}</span>
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function ListRow({ active, onClick, children, missing }: { active: boolean; onClick: () => void; children: ReactNode; missing?: boolean }) {
  return (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${active ? 'bg-canvas' : 'hover:bg-canvas/60'}`}
    >
      <span className={`min-w-0 flex-1 truncate text-[13px] ${missing ? 'text-ink-2' : 'text-ink'}`}>{children}</span>
      {missing ? <span className="shrink-0 text-[10.5px] text-ink-3">not created</span> : null}
    </button>
  )
}

const agentLabel = (a: AgentView): string => (a.id === MASTER_ID ? `✳ ${ANYWHERE_LABEL}` : `${a.emoji ? `${a.emoji} ` : ''}${a.name}`)

export function MemoriesTab() {
  const agents = useStore((s) => s.agents)
  const changePage = useStore((s) => s.changePage)
  const changeProjectTab = useStore((s) => s.changeProjectTab)
  const selectAgent = useStore((s) => s.selectAgent)
  const changeTab = useStore((s) => s.changeTab)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  // the machine's other instruction files — personal rules, the organization's
  // (GET /api/memory with no folder, spec memory-places T2): listed and,
  // where Silos may, edited here as on every page that shows them
  const [machineRows, setMachineRows] = useState<MemoryRow[]>([])
  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => api.memory.list())
      .then(
        (l) => {
          if (!cancelled) setMachineRows((l?.rows ?? []).filter((r) => r.origin === 'machine' || r.origin === 'organization'))
        },
        () => {
          /* none listed */
        },
      )
    return () => {
      cancelled = true
    }
  }, [])
  const rowFile = (r: MemoryRow): MemoryFileInfo => ({ name: r.rel, path: r.path, scope: 'global', mtime: r.mtime, exists: true, size: r.bytes })
  const [selection, setSelection] = useState<Selection | null>(null)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // a machine file: the server asked for the owner's confirm (MachineSaveConfirm)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    let cancelled = false
    buildCatalog(agents)
      .then((c) => {
        if (!cancelled) setCatalog(c)
      })
      .catch(() => {
        /* catalog down: the list stays empty */
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents.length])

  const path = selection?.file.path
  useEffect(() => {
    if (!path) return
    setEditing(false)
    setConfirming(false)
    setNotice(null)
    setLoading(true)
    api.memory
      .read(path)
      .then(setContent)
      .catch(() => setContent(''))
      .finally(() => setLoading(false))
  }, [path])

  const pick = (file: MemoryFileInfo, house: House): void => setSelection({ file, house })

  async function save(confirmed = false): Promise<void> {
    if (!selection) return
    setSaving(true)
    try {
      const { backup } = await (confirmed ? api.memory.write(selection.file.path, draft, { confirmed: true }) : api.memory.write(selection.file.path, draft))
      setContent(draft)
      setEditing(false)
      setConfirming(false)
      setNotice(backup ? `Saved · backup: ${backup}` : 'Saved.')
    } catch (e) {
      if (!confirmed && needsMachineConfirm(e)) setConfirming(true)
      else setNotice(`Could not save — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  // the door of a file whose house is elsewhere: its words say what the
  // destination does — the page where it is read and changed
  function door(house: House): { words: string; go: () => void } | null {
    if (house.kind === 'project')
      return {
        words: `Change it in ${basename(house.folder)} › Memory ›`,
        go: () => {
          changePage({ kind: 'project', folder: house.folder })
          changeProjectTab('memory')
        },
      }
    if (house.kind === 'fact')
      return {
        words: house.why,
        go: () => {
          /* a fact: changed outside Silos */
        },
      }
    if (house.kind === 'agent')
      return {
        words: `Change it in ${house.agent.id === MASTER_ID ? ANYWHERE_LABEL : house.agent.name} › Memory ›`,
        go: () => {
          selectAgent(house.agent.id)
          changeTab('memory')
        },
      }
    return null
  }

  const elsewhere = selection ? door(selection.house) : null
  const selected = (p: string): boolean => selection?.file.path === p

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
      <div className="max-h-44 w-full shrink-0 overflow-y-auto border-b border-line px-2 py-3 md:max-h-none md:w-60 md:border-b-0 md:border-r">
        {!catalog ? (
          <p className="px-2 py-2 text-xs text-ink-2">Reading the disk…</p>
        ) : (
          <>
            <ListSection title="This machine">
              <ListRow active={selected(catalog.global.path)} missing={!catalog.global.exists} onClick={() => pick(catalog.global, { kind: 'here' })}>
                Your personal instructions
              </ListRow>
              {machineRows
                .filter((r) => r.path !== catalog.global.path && r.real !== catalog.global.path)
                .map((r) => (
                  <ListRow
                    key={r.path}
                    active={selected(r.path)}
                    onClick={() => pick(rowFile(r), r.editable ? { kind: 'here' } : { kind: 'fact', why: r.readOnly ?? 'Silos doesn’t write this file' })}
                  >
                    <span className="font-mono text-[12px]">{r.rel}</span>
                    {r.origin === 'organization' ? <span className="ml-1.5 text-[10.5px] text-ink-3">your organization</span> : null}
                  </ListRow>
                ))}
            </ListSection>
            {catalog.projects.length > 0 ? (
              <ListSection title="Projects">
                {catalog.projects.map((p) => (
                  <ListRow
                    key={p.folder}
                    active={selected(p.claude.path)}
                    missing={!p.claude.exists}
                    onClick={() => pick(p.claude, { kind: 'project', folder: p.folder })}
                  >
                    {basename(p.folder)}
                  </ListRow>
                ))}
              </ListSection>
            ) : null}
            {catalog.agentEntries.length > 0 ? (
              <ListSection title="Agents">
                {catalog.agentEntries.map(({ agent, memory }) => (
                  <ListRow key={agent.id} active={selected(memory.path)} missing={!memory.exists} onClick={() => pick(memory, { kind: 'agent', agent })}>
                    {agentLabel(agent)}
                  </ListRow>
                ))}
              </ListSection>
            ) : null}
            {catalog.projects.some((p) => p.auto.length > 0) ? (
              <ListSection title="Notes the agents learned">
                {catalog.projects.flatMap((p) =>
                  p.auto.map((f) => (
                    <ListRow key={f.path} active={selected(f.path)} onClick={() => pick(f, { kind: 'project', folder: p.folder })}>
                      {basename(p.folder)} · {f.name}
                    </ListRow>
                  )),
                )}
              </ListSection>
            ) : null}
          </>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-5 md:px-8">
        {!selection ? (
          <div className="max-w-[62ch] text-sm text-ink-2">
            <p>Select a memory file to read it.</p>
            <p className="mt-2 text-[12.5px]">
              This is every memory on the machine. Your personal instructions (~/.claude/CLAUDE.md) reach every agent on this machine and are edited here; a
              project&rsquo;s CLAUDE.md, an agent&rsquo;s memory and the notes agents learn are changed on their own page — each file says where.
            </p>
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
              <div className="min-w-0">
                <h2 className="truncate font-display text-base text-ink">{selection.file.name}</h2>
                <p className="truncate font-mono text-xs text-ink-2" title={selection.file.path}>
                  {selection.file.path}
                </p>
              </div>
              {selection.house.kind === 'fact' ? (
                <p data-testid="memory-read-only" className="shrink-0 pt-0.5 text-[12px] text-ink-3">
                  Read-only — {selection.house.why}
                </p>
              ) : elsewhere ? (
                <button
                  type="button"
                  data-testid="memory-house"
                  onClick={elsewhere.go}
                  className="shrink-0 pt-0.5 text-[13px] font-medium text-terracotta hover:underline"
                >
                  {elsewhere.words}
                </button>
              ) : !editing ? (
                <button
                  type="button"
                  onClick={() => {
                    setDraft(content)
                    setEditing(true)
                    setNotice(null)
                  }}
                  className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink hover:border-ink-2"
                >
                  {selection.file.exists || content ? 'Edit' : 'Write it'}
                </button>
              ) : null}
            </div>
            {loading ? (
              <p className="text-xs text-ink-2">Loading…</p>
            ) : editing ? (
              <>
                <textarea
                  autoFocus
                  spellCheck={false}
                  aria-label={`${selection.file.name} contents`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className="h-96 w-full resize-none rounded-lg border border-line bg-panel p-3 font-mono text-xs leading-relaxed text-ink outline-none focus:border-terracotta"
                />
                {confirming ? (
                  <MachineSaveConfirm saving={saving} onConfirm={() => void save(true)} onKeepEditing={() => setConfirming(false)} />
                ) : (
                  <div className="mt-2 flex items-center justify-end gap-3">
                    {notice ? <span className="mr-auto truncate text-xs text-ink-2">{notice}</span> : null}
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(false)
                        setNotice(null)
                      }}
                      className="text-sm text-ink-2 hover:text-ink"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void save()}
                      disabled={saving}
                      className="rounded-lg bg-terracotta px-3 py-1.5 text-sm font-medium text-on-terracotta hover:opacity-90 disabled:opacity-60"
                    >
                      {saving ? 'Saving…' : 'Save — for every project on this machine'}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <>
                {content ? <Markdown text={content} /> : <p className="text-sm text-ink-2">Empty — not written yet.</p>}
                {notice ? <p className="mt-2 text-xs text-ink-2">{notice}</p> : null}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
