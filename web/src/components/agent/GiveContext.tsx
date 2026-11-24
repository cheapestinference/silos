// GiveContext.tsx — the first minute's optional «Give <Name> something to
// work with»: files it reads (the Knows panel's own AddContext — only it,
// or shared in its folder) and skills it can use (its folder's catalog:
// one not yet on is added, a held one turned back on). Nothing is asked
// before Create; everything here changes later from its page.
// And, when what the Claude account sends is off in its project (the
// starting set, spec tools-origin §8), «Tools from your Claude account ›»:
// the door to the project's Tools, at the account's group.
import { useEffect, useState } from 'react'
import { Check, ChevronRight, Plus } from 'lucide-react'
import type { AgentView, LoadsOrigin, SkillCatalogEntry } from '../../lib/types'
import { api } from '../../lib/api'
import { ACCOUNT_GROUP } from '../../lib/loads-view'
import { useGoHome } from '../knows/go-home'
import { knowsDoors } from '../knows/KnowsAnatomy'
import { AddContext } from '../knows/KnowsAdd'

const SHOWN = 5

export function GiveContext({ agent }: { agent: AgentView }) {
  const [skills, setSkills] = useState<SkillCatalogEntry[] | null>(null)
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filesOpen, setFilesOpen] = useState(false)
  const [files, setFiles] = useState(0)
  // the account's origins off in its project: what the door offers
  const [offOrigins, setOffOrigins] = useState<LoadsOrigin['id'][]>([])
  const goHome = useGoHome()
  const folder = agent.folder ?? null
  useEffect(() => {
    if (!folder) return
    let alive = true
    Promise.resolve()
      .then(() => api.folders.loads(folder))
      .then((l) => {
        if (alive) setOffOrigins([...new Set((l?.origins ?? []).filter((o) => !o.on).map((o) => o.id))])
      })
      .catch(() => {
        if (alive) setOffOrigins([])
      })
    return () => {
      alive = false
    }
  }, [folder])

  useEffect(() => {
    let alive = true
    Promise.resolve()
      .then(() => knowsDoors.catalog(agent))
      .then((c) => {
        if (alive) setSkills((c ?? []).filter((s) => s.state === 'available' || s.state === 'held').slice(0, SHOWN))
      })
      .catch(() => {
        if (alive) setSkills([])
      })
    return () => {
      alive = false
    }
  }, [agent])

  async function add(s: SkillCatalogEntry): Promise<void> {
    setBusy(s.name)
    setError(null)
    try {
      await knowsDoors.skillState(agent, s.name, s.state === 'held' ? 'activate' : 'add')
      setAdded((prev) => new Set(prev).add(s.name))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section data-testid="give-context" aria-label={`Give ${agent.name} something to work with`} className="overflow-hidden rounded-xl border border-line">
      <div className="px-4 py-3">
        <p className="text-[14px] text-ink">Give {agent.name} something to work with</p>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-2">Optional — files it reads and skills it can use. All of it changes later from its page.</p>
      </div>
      <div className="divide-y divide-line border-t border-line">
        <div>
          <button
            type="button"
            onClick={() => setFilesOpen((v) => !v)}
            aria-expanded={filesOpen}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-panel"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] text-ink">Files</span>
              <span className="block text-xs text-ink-2">{files > 0 ? `${files} added` : 'A brief, a spec, a CSV — only it, or everyone in its folder'}</span>
            </span>
            {files > 0 ? <Check size={14} aria-hidden="true" className="text-terracotta" /> : <Plus size={14} aria-hidden="true" className="text-ink-2" />}
          </button>
          {filesOpen ? <AddContext agent={agent} prefer="agent" onUploaded={() => setFiles((n) => n + 1)} /> : null}
        </div>
        {folder && offOrigins.length > 0 ? (
          <button
            type="button"
            data-testid="give-account-tools"
            onClick={() => goHome({ kind: 'project', folder, tab: 'tools', item: ACCOUNT_GROUP })}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-panel"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] text-ink">Tools from your Claude account</span>
              <span className="block text-xs text-ink-2">
                Its {offOrigins.join(' and ')} are off in this project — turn on the ones {agent.name} needs.
              </span>
            </span>
            <ChevronRight size={14} aria-hidden="true" className="text-ink-2" />
          </button>
        ) : null}
        {skills === null ? (
          <p className="px-4 py-2.5 text-xs text-ink-3">Reading the skills it could use…</p>
        ) : (
          skills.map((s) => {
            const on = added.has(s.name)
            return (
              <div key={s.name} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] text-ink">{s.name}</span>
                  {s.description ? (
                    <span className="block truncate text-xs text-ink-2" title={s.description}>
                      {s.description}
                    </span>
                  ) : null}
                </span>
                {on ? (
                  <span className="flex items-center gap-1 text-xs text-ink-2">
                    <Check size={13} aria-hidden="true" className="text-terracotta" />
                    Added
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={`Add ${s.name}`}
                    disabled={busy !== null}
                    onClick={() => void add(s)}
                    className="rounded-full border border-line px-3 py-0.5 text-[12px] text-ink hover:border-terracotta hover:text-terracotta disabled:opacity-50"
                  >
                    {busy === s.name ? 'Adding…' : 'Add'}
                  </button>
                )}
              </div>
            )
          })
        )}
      </div>
      {error ? (
        <p role="alert" className="border-t border-line px-4 py-2 text-xs text-terracotta">
          {error}
        </p>
      ) : null}
    </section>
  )
}
