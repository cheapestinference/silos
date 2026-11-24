// NewProjectModal.tsx — "New project", the one way a project is started,
// so how new projects and agents are created is never unclear.
// A project in Silos IS a folder: pick one you already work in (the folders
// Silos has seen, as suggestions) or type a new one — it is created on the
// spot (POST /api/mkdir, idempotent). With it, Silos proposes the project's
// own agent, named after the folder: proposed, never created behind the
// owner's back — accepting opens the usual new-agent form already filled
// (folder + name), where its mission and model are set. Without an agent, the
// project starts as a conversation with Anywhere in that folder.
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { MASTER_ID } from '../lib/constants'
import { basename } from '../lib/routes'
import { Modal } from './Modal'
import type { Project } from '../lib/types'

// "acme-labs" → "Acme labs": the folder's name as a person
// would say it — a proposal the owner edits freely
export function agentNameForFolder(folder: string): string {
  const base = basename(folder.replace(/\/+$/, ''))
    .replace(/[-_.]+/g, ' ')
    .trim()
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : ''
}

type FolderState = 'empty' | 'relative' | 'checking' | 'exists' | 'new' | 'file'

export function NewProjectModal() {
  const modal = useStore((s) => s.modal)
  if (modal !== 'new-project') return null
  return <NewProjectForm />
}

function NewProjectForm() {
  const setModal = useStore((s) => s.setModal)
  const agents = useStore((s) => s.agents)
  const inputRef = useRef<HTMLInputElement>(null)
  const [folder, setFolder] = useState('')
  const [known, setKnown] = useState<Project[]>([])
  const [state, setState] = useState<FolderState>('empty')
  const [withAgent, setWithAgent] = useState(true)
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api
      .projects()
      .then((p) => {
        if (!cancelled) setKnown(p)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const clean = folder.trim().replace(/(.)\/+$/, '$1')
  // the agents that already live there — a folder with one is a project
  // already; the proposal then says so instead of offering a duplicate
  const residents = agents.filter((a) => a.id !== MASTER_ID && !a.archived && (a.folder === clean || (a.folders ?? []).includes(clean)))
  const seen = known.find((p) => p.cwd === clean)

  // does the folder exist? (quietly, as the owner types)
  useEffect(() => {
    if (clean === '') {
      setState('empty')
      return
    }
    if (!clean.startsWith('/')) {
      setState('relative')
      return
    }
    setState('checking')
    let cancelled = false
    const t = setTimeout(() => {
      api.file.dir(clean).then(
        () => {
          if (!cancelled) setState('exists')
        },
        (e: unknown) => {
          if (!cancelled) setState(e instanceof Error && /not a folder/i.test(e.message) ? 'file' : 'new')
        },
      )
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [clean])

  // the proposed name follows the folder until the owner types their own
  useEffect(() => {
    if (!nameTouched) setName(agentNameForFolder(clean))
  }, [clean, nameTouched])

  const folderOk = state === 'exists' || state === 'new'
  const agentOk = !withAgent || residents.length > 0 || name.trim() !== ''
  const canCreate = folderOk && agentOk && !busy

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!canCreate) return
    setBusy(true)
    setError(null)
    try {
      if (state === 'new') await api.mkdir(clean)
      if (withAgent && residents.length === 0) {
        // the usual new-agent form, already filled — its mission and model are set there
        setModal('create', clean, name.trim())
        return
      }
      const s = useStore.getState()
      if (residents.length > 0) s.changePage({ kind: 'project', folder: clean })
      else {
        // no agent: the project starts as a conversation with Anywhere there
        s.selectAgent(MASTER_ID)
        s.startNewConversation()
        s.chooseProject(clean)
      }
      setModal(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const hint: Record<FolderState, string> = {
    empty: 'An absolute path — a folder you already work in, or a new one.',
    relative: 'Use an absolute path, e.g. /home/you/my-project.',
    checking: 'Looking…',
    exists: seen
      ? `Exists — ${seen.sessions} ${seen.sessions === 1 ? 'conversation has' : 'conversations have'} run there.`
      : 'Exists — nothing has run there yet.',
    new: 'New folder — Silos creates it.',
    file: 'That is a file, not a folder.',
  }

  return (
    <Modal onClose={() => setModal(null)} label="New project" initialFocusRef={inputRef}>
      <form onSubmit={(e) => void submit(e)} data-testid="new-project">
        <h2 className="font-display text-xl text-ink">New project</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">A project is a folder: everything its agents and conversations do happens there.</p>

        <label htmlFor="new-project-folder" className="mt-5 block text-[13px] font-medium text-ink">
          Folder
        </label>
        <input
          ref={inputRef}
          id="new-project-folder"
          list="new-project-known"
          value={folder}
          onChange={(e) => {
            setFolder(e.target.value)
            setError(null)
          }}
          placeholder="/home/you/my-project"
          spellCheck={false}
          autoComplete="off"
          className="mt-1.5 w-full rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-terracotta"
        />
        <datalist id="new-project-known">
          {known.map((p) => (
            <option key={p.cwd} value={p.cwd} />
          ))}
        </datalist>
        <p
          data-testid="new-project-folder-hint"
          className={`mt-1.5 text-[12.5px] ${state === 'relative' || state === 'file' ? 'text-terracotta' : 'text-ink-2'}`}
        >
          {hint[state]}
        </p>

        <div className="mt-5 border-t border-line pt-4">
          {residents.length > 0 ? (
            <p data-testid="new-project-residents" className="text-[13px] text-ink-2">
              Already a project: {residents.map((a) => a.name).join(', ')} {residents.length === 1 ? 'lives' : 'live'} there.
            </p>
          ) : (
            <>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={withAgent}
                  onChange={(e) => setWithAgent(e.target.checked)}
                  className="mt-[3px] h-3.5 w-3.5 accent-terracotta"
                />
                <span className="text-[14px] leading-6 text-ink">
                  Give it its own agent
                  <span className="block text-[12.5px] leading-5 text-ink-2">
                    {withAgent
                      ? 'You say what it takes care of next — and, in its first minute, the files every agent here shares.'
                      : 'It starts as a conversation with Anywhere in that folder.'}
                  </span>
                </span>
              </label>
              {withAgent ? (
                <div className="mt-3 pl-6">
                  <label htmlFor="new-project-agent" className="block text-[13px] text-ink-2">
                    Its name
                  </label>
                  <input
                    id="new-project-agent"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value)
                      setNameTouched(true)
                    }}
                    placeholder="e.g. Research"
                    className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-1.5 text-[14px] text-ink outline-none focus:border-terracotta"
                  />
                </div>
              ) : null}
            </>
          )}
        </div>

        {error ? (
          <p role="alert" className="mt-3 text-[13px] text-terracotta">
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex items-center justify-end gap-2">
          <button type="button" onClick={() => setModal(null)} className="rounded-lg px-3 py-1.5 text-sm text-ink-2 hover:text-ink">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canCreate}
            className="rounded-lg bg-terracotta px-4 py-1.5 text-sm font-medium text-on-terracotta hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {residents.length > 0 ? 'Open the project' : withAgent ? 'Next: its agent' : 'Start the project'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
