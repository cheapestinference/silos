// KnowsDetail.tsx — the open item's body in the library (KnowsLibrary's
// right pane on a page, the pane that replaces the list in the drawer), so
// reading or fixing it never leaves where you are:
//   memory  → the note as markdown + Edit (textarea → api.memory.write,
//             backup + atomic on the server) + Edit with chat (the current
//             composer's memory mode);
//   skill   → its readme (GET /api/skills/:name) + where it loads from (a
//             fact, not a toggle — the switch is the row's, on its owner's
//             page);
//   context → its facts in one line + the file itself, inline + delete
//             (ConfirmButton: arm, then confirm — never a stray click).
// A file that vanished between the list and the click (deleted on disk)
// says so — a failed fetch is a message, never a crash.
//
// Unsaved work: every editor reports `onDirty`.
import { useEffect, useState, type ReactNode } from 'react'
import { ChevronLeft, Trash2 } from 'lucide-react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { knowsDoors } from './KnowsAnatomy'
import type { AgentView, ContextScope, FileMeta, SkillCatalogEntry, SkillReadme } from '../../lib/types'
import { removableContext, skillWhere, type KnowsItem } from '../../lib/knows'
import { relTime } from '../../lib/rel-time'
import { Markdown } from '../Turn'
import { ConfirmButton } from '../ConfirmButton'
import { FileViewer } from '../FileViewer'
import { MachineSaveConfirm, needsMachineConfirm } from './MachineSaveConfirm'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function BackBar({ onBack, title, pill }: { onBack: () => void; title: string; pill?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-4 pt-3">
      <button type="button" onClick={onBack} className="-ml-1 flex shrink-0 items-center gap-0.5 rounded-md px-1 text-xs text-ink-2 hover:text-ink">
        <ChevronLeft size={12} aria-hidden="true" /> All
      </button>
      <p className="min-w-0 flex-1 truncate text-sm font-medium text-ink" title={title}>
        {title}
      </p>
      {pill}
    </div>
  )
}

export function Gone({ what, detail }: { what: string; detail?: string }) {
  return (
    <div className="px-4 py-4 text-sm text-ink-2">
      <p className="text-ink">This {what} no longer exists.</p>
      <p className="mt-1">It was removed or renamed since the list was read.{detail ? ` (${detail})` : ''}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Memory — read / Edit / Edit with chat. `exists:false` (a layer slot not
// created yet, e.g. a project CLAUDE.md) starts from an empty file without
// a read that would surely fail; `startEditing` opens straight in the editor.
// ---------------------------------------------------------------------------
export function MemoryDetail({
  path,
  name,
  exists = true,
  startEditing = false,
  onDirty,
  onSaved,
  guard = (leave) => leave(),
  folder,
  readOnly,
  saveLabel = 'Save',
}: {
  path: string
  name: string
  /** the page's folder: the file is one the server lists for it (spec memory-places T3) */
  folder?: string | null
  /** not Silos' to write: where it is changed instead (no Edit) */
  readOnly?: string
  /** Save says whom it reaches («Save — for every agent here») */
  saveLabel?: string
  exists?: boolean
  startEditing?: boolean
  onDirty: (dirty: boolean) => void
  onSaved?: () => void
  // the drawer's unsaved-draft guard: leaving the drawer (Edit with chat
  // closes it) asks first when ANY draft in it is unsaved — e.g. a new note
  // half-written in AddMemory while this CLAUDE.md is open
  guard?: (leave: () => void) => void
}) {
  const enterMemoryMode = useStore((s) => s.enterMemoryMode)
  const requestComposerFocus = useStore((s) => s.requestComposerFocus)
  const closeKnows = useStore((s) => s.closeKnows)
  const [content, setContent] = useState<string | null>(exists ? null : '')
  const [gone, setGone] = useState<string | null>(null)
  const [editing, setEditing] = useState(startEditing)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // a machine file: the server asked for the owner's confirm (MachineSaveConfirm)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!exists) return
    let cancelled = false
    Promise.resolve(folder ? api.memory.read(path, folder) : api.memory.read(path))
      .then((t) => {
        if (cancelled) return
        setContent(t ?? '')
        if (startEditing) setDraft(t ?? '') // the editor opens on the real bytes
      })
      .catch((e: unknown) => {
        if (!cancelled) setGone(errText(e))
      })
    return () => {
      cancelled = true
    }
    // startEditing is the initial mode only — not a reason to re-read
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, exists])

  const dirty = editing && content !== null && draft !== content
  useEffect(() => {
    onDirty(dirty)
  }, [dirty, onDirty])
  useEffect(() => () => onDirty(false), [onDirty])

  if (gone !== null) return <Gone what="note" detail={gone} />
  if (content === null) return <p className="px-4 py-4 text-sm text-ink-2">Loading…</p>

  async function save(confirmed = false): Promise<void> {
    setSaving(true)
    setNotice(null)
    try {
      const opts = { ...(folder ? { folder } : {}), ...(confirmed ? { confirmed: true } : {}) }
      const { backup } = await (Object.keys(opts).length > 0 ? api.memory.write(path, draft, opts) : api.memory.write(path, draft))
      setContent(draft)
      setEditing(false)
      setConfirming(false)
      setNotice(backup ? `Backed up to ${backup}` : 'Saved')
      onSaved?.()
    } catch (e) {
      if (!confirmed && needsMachineConfirm(e)) setConfirming(true)
      else setNotice(`Error: ${errText(e)}`)
    } finally {
      setSaving(false)
    }
  }

  // the CURRENT chat's composer goes into memory mode; the drawer steps
  // aside so the composer has the focus (the conversation is right there)
  function editWithChat(): void {
    guard(() => {
      enterMemoryMode(path, name)
      closeKnows()
      requestComposerFocus()
    })
  }

  return (
    <div className="px-4 pb-4 pt-3">
      {editing ? (
        <textarea
          autoFocus
          spellCheck={false}
          aria-label={`Edit ${name}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-h-[18rem] w-full resize-y rounded-lg border border-line bg-panel p-3 font-mono text-xs leading-relaxed text-ink outline-none focus:border-terracotta"
        />
      ) : (
        <div className="min-w-0 text-sm">
          {/* the frontmatter is metadata (name, description, type), said
              by whoever shows the note — rendered, its `---` fences turned
              into a rule and a giant setext heading */}
          <Markdown text={content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim() || '_(empty)_'} />
        </div>
      )}
      {notice ? (
        <p className="mt-2 truncate text-xs text-ink-2" title={notice}>
          {notice}
        </p>
      ) : null}
      {editing && confirming ? (
        <MachineSaveConfirm saving={saving} onConfirm={() => void save(true)} onKeepEditing={() => setConfirming(false)} />
      ) : (
        <div className="mt-3 flex items-center justify-end gap-3">
          {editing ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setEditing(false)
                  setConfirming(false)
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
                {saving ? 'Saving…' : saveLabel}
              </button>
            </>
          ) : readOnly ? (
            <p data-testid="memory-read-only" className="mr-auto text-[12px] leading-snug text-ink-3">
              Read-only here — {readOnly}
            </p>
          ) : (
            <>
              <button type="button" onClick={editWithChat} className="text-sm text-ink-2 hover:text-ink">
                Edit with chat
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft(content)
                  setEditing(true)
                  setNotice(null)
                }}
                className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink hover:border-ink-2"
              >
                Edit
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Skill — the readme + where it loads from. The list only carries ACTIVE
// skills now (the folder's copies and the operator's personal ones —
// capability states), so the line is a fact, never a toggle: the
// "assigned" switch that PATCHed the retired agent.skills is gone; turning
// a folder skill off lives in the agent page's Skills row (hold).
// ---------------------------------------------------------------------------
export function SkillDetail({ item, entry }: { agent: AgentView; item: KnowsItem; entry?: SkillCatalogEntry }) {
  const [readme, setReadme] = useState<SkillReadme | null>(null)
  const [missing, setMissing] = useState(false)
  // what each source really is — the catalog entry when the caller has it
  // (state, plugin, shadowed), else the item's source alone
  const where = skillWhere(entry ?? { source: item.rawScope === 'agent' ? undefined : item.rawScope })

  useEffect(() => {
    let cancelled = false
    Promise.resolve(api.skillReadme(item.name))
      .then((r) => {
        if (!cancelled) {
          if (r) setReadme(r)
          else setMissing(true)
        }
      })
      .catch(() => {
        if (!cancelled) setMissing(true)
      })
    return () => {
      cancelled = true
    }
  }, [item.name])

  return (
    <div className="px-4 pb-4 pt-3">
      <div className="flex items-center gap-2 text-xs text-ink-2" data-testid="skill-where">
        <span>{where}</span>
      </div>
      <div className="mt-3 min-w-0 text-sm">
        {missing ? (
          <p className="text-ink-2">No readme for this skill in the catalog — a built-in, or it no longer exists on disk.</p>
        ) : readme ? (
          <>
            {readme.description ? <p className="mb-2 text-ink-2">{readme.description}</p> : null}
            <Markdown text={readme.body || '_(empty)_'} />
          </>
        ) : (
          <p className="text-ink-2">Loading…</p>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Context file — metadata (from the file service: a deleted file fails
// here, before anything is offered) + open inline + delete.
// ---------------------------------------------------------------------------
// `conversation`: the conversation the library was opened from — a file the
// owner gave THAT conversation alone is removed, or given to the agent, here
// in its list (a thing is edited where it is listed).
export function ContextDetail({
  agent,
  item,
  onRemoved,
  onDirty,
  conversation,
  whose = true,
}: {
  agent: AgentView
  item: KnowsItem
  onRemoved: () => void
  onDirty: (dirty: boolean) => void
  conversation?: string
  /** say whose it is in the facts line — false where the opened item's own
   *  origin line already says it (never twice) */
  whose?: boolean
}) {
  const path = item.path ?? ''
  const [meta, setMeta] = useState<FileMeta | null>(null)
  const [gone, setGone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scope: ContextScope = item.rawScope === 'agent' ? 'agent' : 'shared'
  // a deep file or another territory's: the bare-name remove route would hit a different file
  const given = item.rawScope === 'conversation' && conversation !== undefined
  const canRemove = given || removableContext({ rel: item.rel, folder: item.folder, scope: item.rawScope }, agent.folder)

  useEffect(() => {
    let cancelled = false
    Promise.resolve(api.file.meta(path))
      .then((m) => {
        if (!cancelled) {
          if (m) setMeta(m)
          else setGone('no metadata')
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setGone(errText(e))
      })
    return () => {
      cancelled = true
    }
  }, [path])

  async function remove(): Promise<void> {
    setError(null)
    if (!canRemove) return
    try {
      if (given) await api.context.remove(agent.id, 'conversation', item.name, conversation)
      else await knowsDoors.removeContext(agent, scope, item.name)
      onRemoved()
    } catch (e) {
      setError(errText(e))
    }
  }

  async function promote(): Promise<void> {
    setError(null)
    try {
      await api.context.promote(agent.id, conversation!, item.name)
      onRemoved()
    } catch (e) {
      setError(errText(e))
    }
  }

  if (gone !== null) return <Gone what="file" detail={gone} />
  if (!meta) return <p className="px-4 py-4 text-sm text-ink-2">Loading…</p>
  // the facts in one line, then the file itself — selecting it IS opening
  // it (never several clicks to get there)
  const facts: [string, string?][] = [
    ...(whose
      ? [[item.rawScope === 'conversation' ? 'only this conversation' : scope === 'shared' ? 'every agent in this folder' : `only ${agent.name}`] as [string]]
      : []),
    [meta.size < 1024 ? `${meta.size} B` : `${Math.round(meta.size / 1024)} KB`],
    ...(item.mtime ? [[relTime(item.mtime), new Date(item.mtime).toLocaleString()] as [string, string]] : []),
  ]
  return (
    <div className="flex h-full min-h-[24rem] flex-col">
      <div className="flex shrink-0 items-center gap-3 px-4 py-2 text-xs text-ink-2">
        <p className="flex min-w-0 flex-1 flex-wrap gap-x-2" title={path}>
          {facts.map(([v, exact], i) => (
            <span key={i} className="flex gap-2" title={exact}>
              {i > 0 ? (
                <span aria-hidden="true" className="text-ink-3">
                  ·
                </span>
              ) : null}
              {v}
            </span>
          ))}
        </p>
        {error ? <span className="text-terracotta">{error}</span> : null}
        {given ? (
          <button
            type="button"
            onClick={() => void promote()}
            title={`Every conversation of ${agent.name} is told about it from then on`}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-ink-2 hover:text-terracotta"
          >
            Give to {agent.name}
          </button>
        ) : null}
        {canRemove ? (
          <ConfirmButton
            onConfirm={() => void remove()}
            ariaLabel={`Delete ${item.name}`}
            confirmLabel={<span className="font-medium">Delete?</span>}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-ink-2 hover:text-terracotta"
            armedClassName="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-terracotta"
          >
            <Trash2 size={12} aria-hidden="true" /> Delete
          </ConfirmButton>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 border-t border-line">
        <FileViewer path={path} inline onDirty={onDirty} />
      </div>
    </div>
  )
}
