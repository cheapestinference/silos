// KnowsAdd.tsx — «+ Write a note» / «+ Upload» in the library (the agent
// page, the project page, the conversation's drawer): adding to what an
// agent knows in place.
//   memory  → a note editor whose write scope is ONLY the folder's memory (a
//             new file under its memory/ — the server appends its MEMORY.md
//             index line, every agent working there reads it) or the agent's
//             own memory.md (only that agent).
//             Global and Project are ONE CLAUDE.md each: they appear as
//             "Edit CLAUDE.md" links that open that whole file in the editor
//             — never an append with invented structure. They are read from
//             the layers, not the item list, so a CLAUDE.md not created yet
//             can still be opened (and created).
//   context → a dropzone / file input + shared·only-the-agent toggle, and
//             «This conversation» when opened from one
//             (given to that conversation alone, its whole thread).
// On the agent page both start on «only <agent>» (the page is
// the agent's — the narrower reach is the safe default; sharing is one
// click, and says whom it reaches).
import { useEffect, useState, type DragEvent, type ReactNode } from 'react'
import { Upload } from 'lucide-react'
import { api } from '../../lib/api'
import type { AgentView, ContextScope, MemoryFileInfo, MemoryLayers } from '../../lib/types'
import { ownerText } from '../../lib/owners'
import { readBase64 } from '../../lib/upload'
import { BackBar, MemoryDetail } from './KnowsDetail'
import { knowsDoors, subjectFolder, type FromConversation } from './KnowsAnatomy'
import { useHarness } from '../../lib/harnesses'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// a title → a file name: lowercase ascii words joined by '-'
export function noteSlug(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return s || 'note'
}

// The folder's auto-memory dir: next to the notes it already has, else
// where the server's MemoryService.list looks for them —
// <~/.claude>/projects/<folder with / and . as ->/memory (the server's
// mungePath, NOT lib/home's broader mungeFolder). The server's whitelist
// has the last word on any write.
function autoMemoryDir(layers: MemoryLayers, folder: string): string {
  // the server says the dir itself (the agent's own under memory per
  // agent) — the first file's dirname and the folder default are fallbacks
  if (layers.autoDir) return layers.autoDir
  const first = layers.autoMemory[0]
  if (first) return first.path.slice(0, first.path.lastIndexOf('/'))
  const claudeDir = layers.global.path.slice(0, layers.global.path.lastIndexOf('/'))
  return `${claudeDir}/projects/${folder.replace(/[/.]/g, '-')}/memory`
}

function freePath(dir: string, slug: string, taken: Set<string>): string {
  let p = `${dir}/${slug}.md`
  for (let n = 2; taken.has(p); n++) p = `${dir}/${slug}-${n}.md`
  return p
}

type WriteScope = 'auto' | 'agent'

function AddMemory({
  agent,
  prefer,
  onDirty,
  onCreated,
  guard,
}: {
  agent: AgentView
  prefer: 'shared' | 'agent'
  onDirty: (dirty: boolean) => void
  onCreated: (path: string) => void
  guard: (leave: () => void) => void
}) {
  const [layers, setLayers] = useState<MemoryLayers | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scope, setScope] = useState<WriteScope>(agent.folder && prefer === 'shared' ? 'auto' : 'agent')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // "Edit CLAUDE.md": the whole file, in the same editor as a detail
  const [whole, setWhole] = useState<MemoryFileInfo | null>(null)
  const [wholeDirty, setWholeDirty] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.resolve(knowsDoors.memory(agent))
      .then((v) => {
        if (cancelled || !v) return
        setLayers(v)
        // no own memory file to write to (a folder subject): the folder's
        if (!v.agent && agent.folder) setScope('auto')
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(errText(e))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read when the subject changes, not on every agent refresh
  }, [agent.folder, agent.id])

  // the half-written note survives a detour to a CLAUDE.md (this component
  // stays mounted), so either draft counts
  const dirty = title.trim() !== '' || description.trim() !== '' || body.trim() !== '' || (whole !== null && wholeDirty)
  useEffect(() => {
    onDirty(dirty)
  }, [dirty, onDirty])
  useEffect(() => () => onDirty(false), [onDirty])

  if (whole) {
    return (
      <div>
        <p className="px-4 pt-2 text-xs text-ink-2">
          {whole.scope === 'global' ? 'Global — read by every agent.' : 'Project — read by every agent in this folder.'}
          {whole.exists ? '' : ' Not created yet: saving creates it.'}
        </p>
        <MemoryDetail path={whole.path} name={whole.name} exists={whole.exists} startEditing onDirty={setWholeDirty} guard={guard} />
        <button
          type="button"
          disabled={wholeDirty}
          title={wholeDirty ? 'Save or cancel the CLAUDE.md edit first' : undefined}
          onClick={() => setWhole(null)}
          className="px-4 text-xs text-ink-2 hover:text-ink disabled:opacity-50"
        >
          ← Back to the new note
        </button>
      </div>
    )
  }
  if (loadError) return <p className="px-4 py-4 text-sm text-ink-2">{loadError}</p>
  if (!layers) return <p className="px-4 py-4 text-sm text-ink-2">Loading…</p>

  // With memory per agent (t48) both targets are usually the AGENT's and
  // the choice is HOW it is kept — appended whole, or an indexed card
  // opened on demand. An engine with no per-agent auto memory (the server
  // says autoScope) keeps the folder's notes, and the copy says so.
  const agentAuto = layers.autoScope === 'agent'
  const options: { id: WriteScope; label: string; hint: string }[] = [
    ...(layers.agent
      ? [{ id: 'agent' as const, label: 'Always loaded', hint: `Appended whole to ${agent.name}’s own memory — in front of every conversation it starts` }]
      : []),
    ...((layers.autoDir ?? agent.folder)
      ? [
          agentAuto
            ? {
                id: 'auto' as const,
                label: 'Memory card',
                hint: `A card in ${agent.name}’s automatic memory — its index line loads at start, the card when needed. No other agent reads either.`,
              }
            : {
                id: 'auto' as const,
                label: ownerText('project', { folder: agent.folder ?? '' }),
                hint: 'A new note in the folder’s memory — every agent working there reads it',
              },
        ]
      : []),
  ]
  const wholeFiles = [layers.global, layers.project].filter((f): f is MemoryFileInfo => f !== null)
  const canSave = body.trim() !== '' && (scope === 'agent' || title.trim() !== '') && options.some((o) => o.id === scope)

  async function save(): Promise<void> {
    if (!layers || !canSave) return
    setSaving(true)
    setError(null)
    try {
      if (scope === 'auto' && (layers.autoDir || agent.folder)) {
        const dir = autoMemoryDir(layers, agent.folder ?? '')
        const path = freePath(dir, noteSlug(title), new Set(layers.autoMemory.map((f) => f.path)))
        const fm = [`name: ${title.trim()}`, ...(description.trim() ? [`description: ${description.trim()}`] : [])]
        await api.memory.write(path, `---\n${fm.join('\n')}\n---\n\n${body.trim()}\n`)
        onDirty(false)
        onCreated(path)
      } else if (layers.agent) {
        const path = layers.agent.path
        const current = layers.agent.exists ? await api.memory.read(path) : ''
        const note = `${title.trim() ? `## ${title.trim()}\n\n` : ''}${body.trim()}\n`
        const glue = current === '' ? '' : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n'
        await api.memory.write(path, `${current}${glue}${note}`)
        onDirty(false)
        onCreated(path)
      }
    } catch (e) {
      setError(errText(e))
    } finally {
      setSaving(false)
    }
  }

  const field = 'w-full rounded-lg border border-line bg-panel px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-terracotta'
  return (
    <div className="space-y-3 px-4 pb-4 pt-3">
      <div>
        <p id="knows-write-to" className="text-[12px] text-ink-2">
          Who reads it
        </p>
        <div role="radiogroup" aria-labelledby="knows-write-to" className="mt-1 inline-flex gap-1">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={scope === o.id}
              aria-label={o.label}
              title={o.hint}
              onClick={() => setScope(o.id)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${
                scope === o.id ? 'border-ink-2 bg-panel text-ink' : 'border-line text-ink-2 hover:text-ink'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-ink-2">{options.find((o) => o.id === scope)?.hint}</p>
      </div>
      <input
        aria-label="Title"
        placeholder={scope === 'auto' ? 'Title (names the file)' : 'Title (optional)'}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className={field}
      />
      {scope === 'auto' ? (
        <input
          aria-label="Description"
          placeholder="One line: what this note is for (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={field}
        />
      ) : null}
      <textarea
        aria-label="Note"
        placeholder="What should it remember?"
        spellCheck={false}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className={`${field} min-h-[10rem] resize-y font-mono text-xs leading-relaxed`}
      />
      {error ? <p className="text-xs text-terracotta">{error}</p> : null}
      <div className="flex justify-end">
        <button
          type="button"
          aria-label="Save note"
          disabled={!canSave || saving}
          onClick={() => void save()}
          className="rounded-lg bg-terracotta px-3 py-1.5 text-sm font-medium text-on-terracotta hover:opacity-90 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {wholeFiles.length > 0 ? (
        <div className="border-t border-line pt-3 text-xs text-ink-2">
          <p>Your personal instructions and the project’s CLAUDE.md are one file each — edit the whole file:</p>
          <div className="mt-1.5 flex flex-wrap gap-3">
            {wholeFiles.map((f) => (
              <button
                key={f.scope}
                type="button"
                aria-label={`Edit ${f.scope} CLAUDE.md`}
                onClick={() => setWhole(f)}
                className="inline-flex items-center gap-1.5 hover:text-terracotta"
              >
                {f.scope === 'global' ? 'Edit your personal instructions' : `Edit CLAUDE.md of ${ownerText('project', { folder: agent.folder })}`}
                {f.exists ? '' : ' (not created)'}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function AddContext({
  agent,
  prefer,
  conversation,
  onUploaded,
}: {
  agent: AgentView
  prefer: 'shared' | 'agent'
  conversation?: FromConversation
  onUploaded: () => void
}) {
  const [scope, setScope] = useState<ContextScope>(prefer === 'agent' && subjectFolder(agent) === null ? 'agent' : 'shared')
  const toldNote = useHarness(conversation?.harness).ui.givenFilesNote ?? null
  const reaches: ContextScope[] = subjectFolder(agent) !== null ? ['shared'] : ['agent', 'shared', ...(conversation ? ['conversation' as const] : [])]
  const [uploading, setUploading] = useState(false)
  const [over, setOver] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function upload(file: File | undefined): Promise<void> {
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      await knowsDoors.upload(agent, scope, file.name, await readBase64(file), conversation?.id ?? undefined)
      onUploaded()
    } catch (e) {
      setError(errText(e))
    } finally {
      setUploading(false)
    }
  }

  function onDrop(e: DragEvent<HTMLLabelElement>): void {
    e.preventDefault()
    setOver(false)
    void upload(e.dataTransfer.files[0])
  }

  return (
    <div className="space-y-3 px-4 pb-4 pt-3">
      <div>
        <p id="knows-upload-to" className="text-[12px] text-ink-2">
          Who reads it
        </p>
        <div role="radiogroup" aria-labelledby="knows-upload-to" className="mt-1 inline-flex flex-wrap gap-1">
          {reaches.map((s) => {
            // the reach chips: the one label per place (lib/owners.ts), no dot
            const label =
              s === 'shared'
                ? ownerText('project', { folder: agent.folder })
                : s === 'agent'
                  ? ownerText('agent', { agentName: agent.name })
                  : ownerText('conversation')
            // an SDK chat before its first message has no id to give it to
            const waiting = s === 'conversation' && !conversation?.id
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={scope === s}
                aria-label={label}
                disabled={waiting}
                onClick={() => setScope(s)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs disabled:cursor-default ${
                  scope === s ? 'border-ink-2 bg-panel text-ink' : waiting ? 'border-line text-ink-3' : 'border-line text-ink-2 hover:text-ink'
                }`}
              >
                {label}
                {waiting ? <span className="text-ink-3">· after its first message</span> : null}
              </button>
            )
          })}
        </div>
        <p className="mt-1 text-xs text-ink-2">
          {scope === 'shared'
            ? 'Every agent in this folder reads it.'
            : scope === 'agent'
              ? `Only ${agent.name} reads it.`
              : 'Only this conversation reads it — no other conversation is told.'}
        </p>
        {scope === 'conversation' && toldNote ? <p className="mt-0.5 text-xs text-ink-3">{toldNote}</p> : null}
      </div>
      <label
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border border-dashed px-4 py-8 text-center text-sm ${
          over ? 'border-terracotta bg-panel text-ink' : 'border-line text-ink-2 hover:border-ink-2'
        }`}
      >
        <Upload size={16} aria-hidden="true" />
        <span>{uploading ? 'Uploading…' : 'Drop a file here, or choose one'}</span>
        <span className="text-xs text-ink-3">
          {scope === 'conversation' ? 'A brief, a spec, a CSV — for this piece of work alone.' : 'A brief, a spec, a CSV — it reaches every conversation.'}
        </span>
        <input
          type="file"
          aria-label="Choose a file"
          disabled={uploading}
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            void upload(f)
          }}
        />
      </label>
      {error ? <p className="text-xs text-terracotta">{error}</p> : null}
    </div>
  )
}

export function KnowsAdd({
  agent,
  kind,
  label,
  prefer = 'shared',
  conversation,
  onBack,
  onDirty,
  onChanged,
  onOpenItem,
  guard,
}: {
  agent: AgentView
  kind: 'memory' | 'context'
  label: string
  /** which reach the form starts on — the agent page starts on the agent's own */
  prefer?: 'shared' | 'agent'
  /** opened from a conversation: «This conversation» joins the reaches */
  conversation?: FromConversation
  onBack: () => void
  onDirty: (dirty: boolean) => void
  onChanged: () => void
  onOpenItem: (key: string) => void
  guard: (leave: () => void) => void
}) {
  let body: ReactNode
  if (kind === 'memory') {
    body = (
      <AddMemory
        agent={agent}
        prefer={prefer}
        onDirty={onDirty}
        guard={guard}
        onCreated={(path) => {
          onChanged()
          onOpenItem(path)
        }}
      />
    )
  } else {
    body = (
      <AddContext
        agent={agent}
        prefer={prefer}
        {...(conversation ? { conversation } : {})}
        onUploaded={() => {
          onChanged()
          onBack()
        }}
      />
    )
  }
  return (
    <div>
      <BackBar onBack={onBack} title={label} />
      {body}
    </div>
  )
}
