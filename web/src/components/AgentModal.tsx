// AgentModal.tsx — ONLY creates agents now — the id is derived from the
// name, shown in gray. Editing an existing agent no longer lives here: it's
// AgentPanel.tsx (the Identity tab, inline), opened from the sidebar's
// pencil or the chat's "About" button. No persistence state of its own: on
// close (Cancel/Esc/success) the form is discarded — the source of truth
// after creating is loadOverview().
import { RolePackInstall } from './RolePackInstall'
import type { RolePack } from '../lib/types'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { useModelOptions } from '../hooks/useModelOptions'
import { useStore } from '../store'
import { api } from '../lib/api'
import type { AgentView, HarnessDescriptor, HarnessId } from '../lib/types'
import { missionProblem, splitMission } from '../lib/mission'
import { startFirstMeeting } from '../lib/first-meeting'
import { derivedFolder, keepsOut, missionAskFor, missionHelp } from '../lib/new-agent'
import { worksPayload, worksProblem, type Works } from '../lib/first-run'
import { WorksChoice } from './welcome/WorksChoice'
import { defaultHarnessId, harnessDescriptors, useHarnessDescriptors } from '../lib/harnesses'
import { useModalBehavior } from './Modal'
import { startingLine } from '../lib/starting-set'
import type { StartingSetPreview } from '../lib/types'
import { basename } from '../lib/routes'
import { useGoHome } from './knows/go-home'

export const MODELS = [
  { value: '', label: 'Default' },
  { value: 'claude-opus-5', label: 'claude-opus-5' },
  { value: 'claude-sonnet-5', label: 'claude-sonnet-5' },
  { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5-20251001' },
]

// The harness an agent runs on — picked once, in the create modal; the
// editor (SettingsTab) only states it. Every engine the server registered,
// in registration order = the radio order (lib/harnesses.ts descriptors).
export function harnessOptions(list: readonly HarnessDescriptor[] = harnessDescriptors()): { value: HarnessId; label: string }[] {
  return list.map((d) => ({ value: d.id, label: d.label }))
}

const SLUG_MAX = 32 // the server's cap (agent-registry.ts: /^[a-z0-9][a-z0-9-]{0,31}$/)

// slug: lowercase, no accents (NFD + strip combining marks), spaces →
// hyphens, and only [a-z0-9-] survives; truncated to the server's max.
// The server's own rule (server/src/slug.ts — the id is derived THERE; this
// is only its preview).
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '')
}

// maps a 400 error message from the backend (server/src/agent-registry.ts:
// 'name required', 'folder must be an absolute path', 'skills must be an
// array of strings', 'invalid id (...)') to the form field it's shown
// under; null → doesn't identify a field, shown at the very top instead.
// Exported: AgentPanel (Identity) reuses the same mapping for its own
// inline save errors.
export type ErrorField = 'name' | 'folder' | 'folders' | 'id' | 'skills' | null
export function fieldForError(message: string): ErrorField {
  const m = message.toLowerCase()
  // 'folders' first: its messages quote paths, and a path can contain
  // 'name' (/home/u/username) or 'folder'.
  if (m.includes('folders')) return 'folders'
  if (m.includes('name')) return 'name'
  if (m.includes('folder')) return 'folder'
  if (m.includes('skills')) return 'skills'
  if (/\bid\b/.test(m)) return 'id'
  return null
}

export interface AgentFormState {
  name: string
  emoji: string
  folder: string
  // Extra territories, one absolute path per line (the textarea's text).
  folders: string
  skills: string[]
  model: string
  // Providers v1: '' = default (the machine's Claude account); any other
  // value is a provider id ('account:<name>' or a providers.json id).
  provider: string
  fallback: string[]
  // the output style it answers in ('' = the operator's own setting)
  outputStyle: string
  // «What will <Name> take care of?» — the create dialog's ONE textarea
  // split by lib/mission.ts into text + «Never»
  // lines on create. Never part of the PATCH payload: the mission's editor
  // is the agent page's head (MissionHeader).
  mission: string
  // The harness — chosen at creation, never changed: formToPayload leaves it
  // out (so the editor's PATCH never carries it); the create call adds it.
  framework: HarnessId
}

export function emptyForm(): AgentFormState {
  return {
    name: '',
    emoji: '',
    folder: '',
    folders: '',
    skills: [],
    model: '',
    provider: '',
    fallback: [],
    outputStyle: '',
    mission: '',
    framework: defaultHarnessId(),
  }
}

// A neutral pool of "agent-ish" glyphs. A new agent starts with one picked
// at random so it never lands in the list icon-less next to agents that have
// one — an empty slot reads as broken. The field stays editable: this is a
// sensible default, not a lock.
const AGENT_EMOJI_POOL = [
  '🤖',
  '🧠',
  '⚙️',
  '🛠️',
  '🔧',
  '📊',
  '📈',
  '🧭',
  '🔭',
  '🧪',
  '⚡',
  '🚀',
  '🛰️',
  '🗂️',
  '🔍',
  '🦉',
  '🦊',
  '🐙',
  '🐝',
  '🦾',
  '💡',
  '🎯',
  '🧩',
  '📡',
  '🔬',
  '🧰',
  '✳️',
  '🌱',
  '🔗',
  '📌',
]

export function randomAgentEmoji(): string {
  return AGENT_EMOJI_POOL[Math.floor(Math.random() * AGENT_EMOJI_POOL.length)]!
}

// Exported: AgentPanel (Identity) preloads its inline form with the same
// shape from the agent it's showing.
export function formFromAgent(a: AgentView): AgentFormState {
  return {
    name: a.name,
    emoji: a.emoji ?? '',
    folder: a.folder ?? '',
    folders: (a.folders ?? []).join('\n'),
    skills: a.skills ?? [],
    model: a.model ?? '',
    // the default normalizes to '' so the selector marks "Default"
    provider: a.provider === undefined || a.provider === 'default' ? '' : a.provider,
    fallback: a.fallback ?? [],
    outputStyle: a.outputStyle ?? '',
    mission: '',
    framework: a.framework ?? defaultHarnessId(),
  }
}

// Exported: AgentPanel (Identity) builds the same PATCH payload.
export function formToPayload(f: AgentFormState): Partial<AgentView> & { name: string; folder: string } {
  return {
    name: f.name.trim(),
    emoji: f.emoji.trim(),
    folder: f.folder.trim(),
    // ALWAYS sent: an emptied list must clear the territories ([] = none).
    folders: f.folders
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    skills: f.skills,
    provider: f.provider === '' ? 'default' : f.provider,
    fallback: f.fallback,
    // ALWAYS sent ('' clears): the editor's "your setting" must undo a style
    outputStyle: f.outputStyle,
    ...(f.model ? { model: f.model } : {}),
  }
}

export function AgentModal() {
  const modal = useStore((s) => s.modal)
  const modalFolder = useStore((s) => s.modalFolder)
  const modalName = useStore((s) => s.modalName)
  const setModal = useStore((s) => s.setModal)
  const loadOverview = useStore((s) => s.loadOverview)
  const agents = useStore((s) => s.agents)

  const open = modal === 'create'

  const [form, setForm] = useState<AgentFormState>(emptyForm)
  // how it works: asked, never inferred from the mission (lib/first-run.ts)
  const [works, setWorks] = useState<Works>('told')
  const [skillInput, setSkillInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // the real skills catalog: loaded (debounced) from master via
  // api.complete; if the call fails, it falls back to "free mode" — no
  // options list, but the text input + Enter still works the same.
  const [catalog, setCatalog] = useState<string[]>([])
  // the Silos skills NOT offered for this engine + folder, with the
  // server's plain reason for each (the add route's own words)
  const [notOffered, setNotOffered] = useState<{ name: string; why: string }[]>([])
  // the model list follows the harness picked above (OpenCode: `opencode models`)
  const modelOptions = useModelOptions(form.framework, form.provider, form.model, MODELS).options
  // the engines an agent can be created on, subscribed (a later
  // GET /api/harnesses answer re-renders the radios)
  const harnesses = harnessOptions(useHarnessDescriptors())
  const [catalogFailed, setCatalogFailed] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  // Capability states: a picked skill becomes a REAL copy in the
  // agent's folder (the add route), never a PATCH of agent.skills. Adds run
  // sequentially after the create; each failure is surfaced by name — the
  // agent exists by then, so the modal stays open to say what didn't land.
  const [skillErrors, setSkillErrors] = useState<string[]>([])
  const [skillHint, setSkillHint] = useState<string | null>(null)
  const [created, setCreated] = useState(false)
  // a role pack picked from a file: the modal shows what installing it does
  // (RolePackInstall) instead of the blank form
  const [pack, setPack] = useState<RolePack | null>(null)
  const [packError, setPackError] = useState<string | null>(null)
  const packRef = useRef<HTMLInputElement>(null)

  // reloads the form and clears the previous run's transient state on
  // open — if it was opened with a prefilled folder (a Sidebar group
  // header's "+ agent" hover, or ProjectPage's "+ Create an agent for
  // these"), the Folder field starts already filled with that path.
  useEffect(() => {
    if (!open) return
    setForm({ ...emptyForm(), emoji: randomAgentEmoji(), folder: modalFolder ?? '', ...(modalName ? { name: modalName } : {}) })
    setSkillInput('')
    setError(null)
    setCatalog([])
    setNotOffered([])
    setCatalogFailed(false)
    setSkillErrors([])
    setSkillHint(null)
    setCreated(false)
    setPack(null)
    setPackError(null)
    // focus the first field — a basic focus trap
    const id = setTimeout(() => nameRef.current?.focus(), 0)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Escape, focus trap, focus restore and body scroll-lock via the shared hook
  // (enabled only while open — this component keeps its hooks mounted when
  // closed). Initial focus goes to the name field.
  const cardRef = useRef<HTMLDivElement>(null)
  useModalBehavior(cardRef, () => setModal(null), { enabled: open, initialFocusRef: nameRef })

  // the picker offers EXACTLY what the add route will accept for THIS
  // agent: the server runs the catalog rule for the draft's engine + folder
  // (GET /api/silos-skills?framework=&folder=) — on OpenCode every Silos
  // skill already loads from the launch root, on Claude Code a folder copy
  // or a personal twin makes one unaddable. Re-asked (debounced) when the
  // engine or the folder changes; a pick no longer offered is dropped, so
  // nothing chosen here can fail after the create for that reason.
  const folderDraft = form.folder.trim()
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const t = setTimeout(() => {
      Promise.resolve(api.silosSkillOffer({ framework: form.framework, folder: folderDraft.startsWith('/') ? folderDraft : '' }))
        .then((result) => {
          if (cancelled) return
          const offered = (result?.skills ?? []).map((s) => s.name)
          setCatalog(offered)
          setNotOffered(result?.notOffered ?? [])
          setCatalogFailed(false)
          setForm((f) => (f.skills.every((s) => offered.includes(s)) ? f : { ...f, skills: f.skills.filter((s) => offered.includes(s)) }))
        })
        .catch(() => {
          if (cancelled) return
          setCatalog([])
          setNotOffered([])
          setCatalogFailed(true)
        })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [open, form.framework, folderDraft])

  // what the new agent starts with in that folder (server/src/starting-set.ts):
  // re-asked (debounced) when the engine or the folder changes
  const [starting, setStarting] = useState<StartingSetPreview | null>(null)
  const goHome = useGoHome()
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const t = setTimeout(() => {
      Promise.resolve(api.startingSet({ framework: form.framework, folder: folderDraft.startsWith('/') ? folderDraft : '', facts: true }))
        .then((p) => {
          if (!cancelled) setStarting(p ?? null)
        })
        .catch(() => {
          if (!cancelled) setStarting(null)
        })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [open, form.framework, folderDraft])

  if (!open) return null

  const idPreview = slugify(form.name)
  const line = startingLine(starting)
  const folders = [...new Set(agents.map((a) => a.folder).filter((f): f is string => !!f))]
  const slugEmpty = idPreview === ''
  // a client-side filter over Silos' skills: instant
  const filteredOptions = catalog.filter((s) => s.toLowerCase().includes(skillInput.trim().toLowerCase()))
  const displayName = form.name.trim() || 'it'
  // inline, in the field's own words: «Never» lines alone are no mission yet
  const missionHint = missionProblem(splitMission(form.mission), displayName) ?? worksProblem(works, splitMission(form.mission).text, form.name.trim())
  const errorFieldValue = error ? fieldForError(error) : null
  const errorTop = error && errorFieldValue === null ? error : null

  function update<K extends keyof AgentFormState>(field: K, value: AgentFormState[K]): void {
    setForm((f) => ({ ...f, [field]: value }))
  }

  // Enter adds a typed name only when it IS one of Silos' skills (or the one
  // option the filter leaves) — anything else could never be copied in, so
  // it is said now, not after the agent exists
  function addSkill(): void {
    const clean = skillInput.trim()
    if (!clean || form.skills.includes(clean)) {
      setSkillInput('')
      return
    }
    const match = catalog.includes(clean) ? clean : filteredOptions.length === 1 ? filteredOptions[0]! : null
    if (match === null) {
      const refused = notOffered.find((n) => n.name === clean)
      setSkillHint(
        refused
          ? refused.why.replace(/^"([^"]+)"/, '“$1”')
          : `“${clean}” isn’t one of Silos’ skills — only those can be copied into the folder. A new skill starts in Settings › Skills.`,
      )
      return
    }
    setSkillHint(null)
    if (!form.skills.includes(match)) setForm((f) => ({ ...f, skills: [...f.skills, match] }))
    setSkillInput('')
  }

  function removeSkill(skill: string): void {
    setForm((f) => ({ ...f, skills: f.skills.filter((s) => s !== skill) }))
  }

  // toggling a catalog option (checkbox): adds it if it wasn't there, removes it if it was.
  function toggleSkill(skill: string): void {
    setForm((f) => ({
      ...f,
      skills: f.skills.includes(skill) ? f.skills.filter((s) => s !== skill) : [...f.skills, skill],
    }))
  }

  function onSkillKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      addSkill()
    }
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (created) return // the agent is already created — the form never submits twice
    if (missionHint) return // said in the field, before sending (M4-r6)
    setError(null)
    setSaving(true)
    try {
      // skills go in as real copies below, never as the agents.json list
      // the mission: the ONE split rule (lib/mission.ts); nothing written = none
      const mission = splitMission(form.mission)
      const { id: _preview, ...payload } = formToPayload(form)
      const made = await api.agents.create({
        ...payload,
        ...(payload.folder === '' ? { folder: undefined } : {}),
        skills: [],
        framework: form.framework,
        ...(mission.text ? { mission } : {}),
        ...worksPayload(works, mission.text),
      })
      const newId = made?.agent?.id ?? idPreview
      setCreated(true)
      startFirstMeeting({ agentId: newId, ...(made?.warn ? { warn: made.warn } : {}), ...(made?.startWarn ? { startWarn: made.startWarn } : {}) })
      const failed: string[] = []
      for (const s of form.skills) {
        try {
          await api.agents.skillState(newId, s, 'add')
        } catch (err) {
          failed.push(`${s}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      setSkillErrors(failed)
      await loadOverview()
      // the new agent lands on its page: its first minute there
      useStore.getState().changePage({ kind: 'agent', id: newId })
      if (failed.length === 0) setModal(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-ink/20 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setModal(null)
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label="new agent"
        tabIndex={-1}
        className="modal-pop max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-line bg-canvas p-6 shadow-lg outline-none"
      >
        {pack ? (
          <RolePackInstall pack={pack} folder={form.folder || modalFolder || ''} onBack={() => setPack(null)} onDone={() => setModal(null)} />
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="font-display text-lg">New agent</h2>
              {/* a whole role from a file another Silos exported («Save as role pack») */}
              <button
                type="button"
                onClick={() => packRef.current?.click()}
                className="text-xs text-ink-2 underline underline-offset-2 hover:text-terracotta"
                data-testid="from-role-pack"
              >
                From a role pack…
              </button>
              <input
                ref={packRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                data-testid="role-pack-file"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (!f) return
                  setPackError(null)
                  void f.text().then((t) => {
                    try {
                      const parsed = JSON.parse(t) as { kind?: unknown }
                      if (parsed.kind !== 'silos.role-pack') {
                        setPackError(`${f.name} is not a role pack`)
                        return
                      }
                      setPack(parsed as RolePack)
                    } catch {
                      setPackError(`${f.name} is not a role pack (it is not JSON)`)
                    }
                  })
                }}
              />
            </div>
            {packError ? <p className="mt-1 text-sm text-terracotta">{packError}</p> : null}

            <form onSubmit={(e) => void onSubmit(e)} className="mt-4 flex flex-col gap-3">
              {errorTop ? <p className="text-sm text-terracotta">{errorTop}</p> : null}

              <div>
                <label htmlFor="agent-name" className="mb-1 block text-xs text-ink-2">
                  Name
                </label>
                <input
                  ref={nameRef}
                  id="agent-name"
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => update('name', e.target.value)}
                  className="w-full rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm outline-none focus:border-terracotta"
                />
                {errorFieldValue === 'name' ? <p className="mt-0.5 text-xs text-terracotta">{error}</p> : null}
                <p className="mt-0.5 text-xs text-ink-2">{idPreview}</p>
                {errorFieldValue === 'id' ? <p className="mt-0.5 text-xs text-terracotta">{error}</p> : null}
                {slugEmpty && form.name.trim() !== '' ? <p className="mt-0.5 text-xs text-terracotta">name must contain letters or numbers</p> : null}
              </div>

              <WorksChoice name={form.name.trim()} works={works} onPick={setWorks} idPrefix="agent-works" />

              <div>
                <label htmlFor="agent-mission" className="mb-1 block text-[13px] text-ink">
                  {missionAskFor(form.name.trim(), works)}
                </label>
                <textarea
                  id="agent-mission"
                  rows={3}
                  value={form.mission}
                  onChange={(e) => update('mission', e.target.value)}
                  aria-describedby="agent-mission-help"
                  className="w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 font-display text-[15px] leading-snug text-ink outline-none focus:border-terracotta"
                />
                {missionHint ? (
                  <p className="mt-0.5 text-xs text-terracotta" role="alert">
                    {missionHint}
                  </p>
                ) : null}
                <p id="agent-mission-help" className="mt-1 text-xs leading-relaxed text-ink-2">
                  {missionHelp(form.name.trim())}
                </p>
              </div>

              <div className="flex gap-3">
                <div className="w-20">
                  <label htmlFor="agent-emoji" className="mb-1 block text-xs text-ink-2">
                    Emoji
                  </label>
                  <input
                    id="agent-emoji"
                    type="text"
                    value={form.emoji}
                    onChange={(e) => update('emoji', e.target.value)}
                    className="w-full rounded-lg border border-line bg-canvas px-3 py-1.5 text-center text-sm outline-none focus:border-terracotta"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="agent-folder" className="mb-1 block text-xs text-ink-2">
                  Folder
                </label>
                <input
                  id="agent-folder"
                  type="text"
                  list="agent-folders"
                  value={form.folder}
                  onChange={(e) => update('folder', e.target.value)}
                  placeholder={derivedFolder(idPreview)}
                  className="w-full rounded-lg border border-line bg-canvas px-3 py-1.5 font-mono text-sm outline-none placeholder:text-ink-3 focus:border-terracotta"
                />
                <p className="mt-0.5 text-xs text-ink-2">
                  Empty: a new folder, {derivedFolder(idPreview)}. {keepsOut(form.name.trim())}
                </p>
                {line ? (
                  <p data-testid="starting-line" className="mt-1 text-xs leading-snug text-ink-2">
                    {line.kind === 'joins' ? (
                      <>
                        It joins {basename(folderDraft)}
                        {line.agents.length > 0 ? `, with ${line.agents.join(', ')},` : ''} and loads what that project loads —{' '}
                        <button
                          type="button"
                          onClick={() => {
                            setModal(null)
                            goHome({ kind: 'project', folder: folderDraft, tab: 'tools' })
                          }}
                          className="text-ink-2 underline decoration-line underline-offset-2 hover:text-terracotta"
                        >
                          Tools ›
                        </button>
                      </>
                    ) : (
                      <>
                        {line.starts} ·{' '}
                        <button
                          type="button"
                          onClick={() => {
                            setModal(null)
                            useStore.getState().changePage({ kind: 'settings', tab: 'accounts' })
                          }}
                          className="text-ink-2 underline decoration-line underline-offset-2 hover:text-terracotta"
                        >
                          change ›
                        </button>
                        {line.reaches ? ' It reaches every conversation in this folder, yours from a terminal included.' : ''}
                      </>
                    )}
                  </p>
                ) : null}
                <datalist id="agent-folders">
                  {folders.map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
                {errorFieldValue === 'folder' ? <p className="mt-0.5 text-xs text-terracotta">{error}</p> : null}
              </div>

              <div>
                <label htmlFor="agent-skills" className="mb-1 block text-xs text-ink-2">
                  Skills
                </label>
                {form.skills.length > 0 ? (
                  <div className="mb-1.5 flex flex-wrap gap-1.5">
                    {form.skills.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => removeSkill(s)}
                        title="remove"
                        className="rounded-full border border-line bg-panel px-2 py-0.5 text-xs text-ink hover:border-terracotta hover:text-terracotta"
                      >
                        <span>{s}</span> <span aria-hidden="true">×</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                <input
                  id="agent-skills"
                  type="text"
                  value={skillInput}
                  onChange={(e) => {
                    setSkillInput(e.target.value)
                    setSkillHint(null)
                  }}
                  onKeyDown={onSkillKeyDown}
                  placeholder="filter Silos’ skills, Enter to add"
                  className="w-full rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm outline-none focus:border-terracotta"
                />
                {!catalogFailed && filteredOptions.length > 0 ? (
                  <ul className="mt-1.5 max-h-32 overflow-y-auto rounded-lg border border-line">
                    {filteredOptions.map((s) => (
                      <li key={s}>
                        <label className="flex items-center gap-2 px-2 py-1 text-sm text-ink hover:bg-panel">
                          <input type="checkbox" checked={form.skills.includes(s)} onChange={() => toggleSkill(s)} />
                          {s}
                        </label>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {catalogFailed ? <p className="mt-0.5 text-xs text-ink-2">Silos’ skills couldn’t be read — add them later from the project’s Skills.</p> : null}
                {!catalogFailed && notOffered.length > 0 ? <NotOfferedLine items={notOffered} /> : null}
                {skillHint ? <p className="mt-0.5 text-xs text-terracotta">{skillHint}</p> : null}
                {errorFieldValue === 'skills' ? <p className="mt-0.5 text-xs text-terracotta">{error}</p> : null}
                {skillErrors.map((e) => (
                  <p key={e} className="mt-0.5 text-xs text-terracotta">
                    {e}
                  </p>
                ))}
              </div>

              <fieldset>
                <legend className="mb-1 block text-xs text-ink-2">Harness</legend>
                <div className="flex gap-2">
                  {harnesses.map((h) => (
                    <label
                      key={h.value}
                      className="flex flex-1 cursor-pointer items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm text-ink-2 hover:text-ink has-[:checked]:border-terracotta has-[:checked]:text-ink has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-terracotta/40"
                    >
                      <input
                        type="radio"
                        name="agent-harness"
                        value={h.value}
                        checked={form.framework === h.value}
                        onChange={() => {
                          update('framework', h.value)
                          // a model id belongs to one harness's catalogue
                          if (h.value !== form.framework) update('model', '')
                        }}
                        className="h-3.5 w-3.5 accent-terracotta focus:outline-none"
                      />
                      {h.label}
                    </label>
                  ))}
                </div>
                <p className="mt-0.5 text-xs text-ink-2">Chosen once — an agent keeps its harness.</p>
              </fieldset>

              <div>
                <label htmlFor="agent-model" className="mb-1 block text-xs text-ink-2">
                  Model
                </label>
                <select
                  id="agent-model"
                  value={form.model}
                  onChange={(e) => update('model', e.target.value)}
                  className="w-full rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm outline-none focus:border-terracotta"
                >
                  {modelOptions.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              {created ? (
                // the agent exists; the modal only stayed open to say which
                // skill copies didn't land (listed under the Skills field above)
                <div className="mt-2 flex items-center justify-end">
                  <button type="button" onClick={() => setModal(null)} className="text-sm text-ink-2 hover:text-ink">
                    Close
                  </button>
                </div>
              ) : (
                <div className="mt-2 flex items-center justify-end gap-3">
                  <button type="button" onClick={() => setModal(null)} className="text-sm text-ink-2 hover:text-ink">
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving || slugEmpty || missionHint !== null}
                    className="rounded-lg bg-terracotta px-4 py-1.5 text-sm font-medium text-on-terracotta hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
                  >
                    Create
                  </button>
                </div>
              )}
            </form>
          </>
        )}
      </div>
    </div>
  )
}

// The Silos skills the picker leaves out, grouped by the server's reason —
// one quiet line per reason ("team-plan, heartbeat — already load…"), so an
// empty picker is never a mystery. The reason is the add route's own
// sentence with its leading quoted name dropped.
function NotOfferedLine({ items }: { items: { name: string; why: string }[] }) {
  const byWhy = new Map<string, string[]>()
  for (const { name, why } of items) {
    const reason = why.replace(/^"[^"]+"\s*/, '')
    byWhy.set(reason, [...(byWhy.get(reason) ?? []), name])
  }
  return (
    <div className="mt-1 space-y-0.5" data-testid="skills-not-offered">
      {[...byWhy].map(([reason, names]) => (
        <p key={reason} className="text-xs text-ink-2">
          <span className="font-mono">{names.join(', ')}</span> — {reason}
        </p>
      ))}
    </div>
  )
}
