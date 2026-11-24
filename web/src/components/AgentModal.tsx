// AgentModal.tsx — ONLY creates agents now. It asks what Welcome's Project and Who steps
// ask, with the SAME fields (welcome/BirthFields over lib/birth.ts): its
// project (one Silos knows, or a new one by name — never a path), a name,
// how it works, its mission, and its engine only when this machine can run
// more than one. Model, skills, emoji and the rest are chosen later — the
// model per conversation (Run on), skills on its page («Give X something to
// work with»). Editing an existing agent lives in AgentPanel.tsx (the
// Identity tab, inline). No persistence state of its own: on close
// (Cancel/Esc/success) the form is discarded — the source of truth after
// creating is loadOverview().
import { RolePackInstall } from './RolePackInstall'
import type { RolePack } from '../lib/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import type { AgentView, EngineCompat, HarnessDescriptor, HarnessId } from '../lib/types'
import { startFirstMeeting } from '../lib/first-meeting'
import { keepsOut } from '../lib/new-agent'
import { engineRows } from '../lib/first-run'
import { birthFor, birthPayload, birthProblems, birthReady, knownProjects, type Birth } from '../lib/birth'
import { BirthFields } from './welcome/BirthFields'
import { defaultHarnessId, harnessDescriptors, useHarnessDescriptors } from '../lib/harnesses'
import { useModalBehavior } from './Modal'

export const MODELS = [
  { value: '', label: 'Default' },
  { value: 'claude-opus-5', label: 'claude-opus-5' },
  { value: 'claude-sonnet-5', label: 'claude-sonnet-5' },
  { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5-20251001' },
]

// The harness an agent runs on — picked once, at birth; the editor
// (SettingsTab) only states it. Every engine the server registered, in
// registration order (lib/harnesses.ts descriptors).
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
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '')
}

// maps a 400/409 message from the backend (agent-registry.ts,
// birth-project.ts: 'name required', 'a project called … exists',
// 'folder must be an absolute path', …) to the form field it's shown
// under; null → doesn't identify a field, shown at the very top instead.
// Exported: AgentPanel (Identity) and Welcome reuse the same mapping.
export type ErrorField = 'name' | 'project' | 'folder' | 'folders' | 'id' | 'skills' | null
export function fieldForError(message: string): ErrorField {
  const m = message.toLowerCase()
  // 'folders' first: its messages quote paths, and a path can contain
  // 'name' (/home/u/username) or 'folder'.
  if (m.includes('folders')) return 'folders'
  // a project's refusals quote its name or its folder: before 'name'
  if (m.includes('project')) return 'project'
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
  // Never part of the PATCH payload: the mission's editor is the agent
  // page's head (MissionHeader).
  mission: string
  // The harness — chosen at creation, never changed: formToPayload leaves it
  // out (so the editor's PATCH never carries it).
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

  const [birth, setBirth] = useState<Birth>(() => birthFor(null, null, []))
  const [framework, setFramework] = useState<HarnessId>(defaultHarnessId)
  const [compat, setCompat] = useState<EngineCompat[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // the engines an agent can be born on, subscribed (a later
  // GET /api/harnesses answer re-renders the rows)
  const descriptors = useHarnessDescriptors()
  const nameRef = useRef<HTMLInputElement>(null)
  // a role pack picked from a file: the modal shows what installing it does
  // (RolePackInstall) instead of the blank form
  const [pack, setPack] = useState<RolePack | null>(null)
  const [packError, setPackError] = useState<string | null>(null)
  const packRef = useRef<HTMLInputElement>(null)

  // reloads the form on open — a door that opens it on a folder (a
  // project's «+ agent», New project's proposal) picks that project
  useEffect(() => {
    if (!open) return
    setBirth(birthFor(modalFolder, modalName, useStore.getState().agents))
    setFramework(defaultHarnessId())
    setError(null)
    setPack(null)
    setPackError(null)
    let live = true
    // which engines this machine can run: the Engine field shows only with more than one
    void Promise.resolve()
      .then(() => api.harness())
      .then((s) => {
        if (live) setCompat(s?.compat ?? [])
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Escape, focus trap, focus restore and body scroll-lock via the shared hook
  // (enabled only while open — this component keeps its hooks mounted when
  // closed). Initial focus goes to the name field.
  const cardRef = useRef<HTMLDivElement>(null)
  useModalBehavior(cardRef, () => setModal(null), { enabled: open, initialFocusRef: nameRef })

  const known = useMemo(() => knownProjects(agents), [agents])
  const engines = useMemo(() => engineRows(descriptors, compat), [descriptors, compat])
  // the engine it is born on: the pick, unless this machine can't run it —
  // then the first one it can (with only one usable, the field isn't shown)
  const engine = engines.some((r) => r.id === framework && r.usable) ? framework : (engines.find((r) => r.usable)?.id ?? framework)

  if (!open) return null

  const problems = birthProblems(birth, known)
  const ready = birthReady(problems)
  const errorField = error ? fieldForError(error) : null
  const errorTop = error && errorField !== 'project' && errorField !== 'name' ? error : null

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (saving || !ready) return // said in the fields, before sending
    setError(null)
    setSaving(true)
    try {
      const made = await api.agents.create({ ...birthPayload(birth), framework: engine })
      startFirstMeeting({ agentId: made.agent.id, ...(made.warn ? { warn: made.warn } : {}), ...(made.startWarn ? { startWarn: made.startWarn } : {}) })
      await loadOverview()
      // the new agent lands on its page: its first minute there
      useStore.getState().changePage({ kind: 'agent', id: made.agent.id })
      setModal(null)
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
          <RolePackInstall
            pack={pack}
            folder={birth.project.kind === 'new' ? '' : birth.project.folder}
            onBack={() => setPack(null)}
            onDone={() => setModal(null)}
          />
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
              {errorTop ? (
                <p role="alert" className="text-sm text-terracotta">
                  {errorTop}
                </p>
              ) : null}

              <BirthFields
                birth={birth}
                onBirth={(d) => {
                  setBirth((cur) => ({ ...cur, ...d }))
                  setError(null)
                }}
                known={known}
                agents={agents}
                problems={problems}
                errors={{ project: errorField === 'project' ? error : null, name: errorField === 'name' ? error : null }}
                engines={{ rows: engines, value: engine, onPick: (id) => setFramework(id as HarnessId) }}
                nameRef={nameRef}
                idPrefix="agent"
              />

              <p className="text-xs text-ink-3">{keepsOut(birth.name.trim())}</p>

              <div className="mt-2 flex items-center justify-end gap-3">
                <button type="button" onClick={() => setModal(null)} className="text-sm text-ink-2 hover:text-ink">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !ready}
                  className="rounded-lg bg-terracotta px-4 py-1.5 text-sm font-medium text-on-terracotta hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
                >
                  {saving ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
