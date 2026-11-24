// VaultPage.tsx — the Vault as its own surface (/vault). The moment it
// serves (docs/product.md, Direct): handing an agent a credential is handing
// out capability — and the standing audit that comes with a keyring: what
// secrets exist, who sees each one, what needs rotating. One ledger: rows
// grouped by NAME so a collision is never silent (the group says who wins,
// in plain words), the Knows scope colors name each visibility, and a row
// expands IN PLACE to manage it — visibility, value, delete that names who
// loses it. The per-agent view ("what reaches THIS agent and why") is the
// agent's Secrets tab — every agent name here is its door, and each row
// there it cannot edit comes back here, «in the Vault ›», open on itself
// (?entry=<id>). The tab edits its own, this page manages the ring.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Hourglass, Plus } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { basename } from '../lib/routes'
import type { BindingAsk, VaultEntry, VaultScope } from '../lib/types'
import { ScopePill } from './knows/ScopePill'
import { ConfirmButton } from './ConfirmButton'
import { HeaderButton, PageHeader } from './PageHeader'
import { SystemTabs } from './SystemTabs'
import { openAgentSecrets } from './agent/doors'
import {
  BindingEditor,
  ModeMark,
  MODE_DELIVERED,
  MODE_SIGNED,
  ServerWarnings,
  SignedCallsFold,
  SigningLimits,
  egressUrl,
  resolutionWords,
} from './VaultSigning'
import {
  vaultGroups,
  filterGroups,
  sortGroups,
  countsPhrase,
  vaultAge,
  lossPhrase,
  joinNames,
  installProjects,
  andList,
  type VaultSort,
  type AnnotatedVaultEntry,
  type VaultPageAgent,
} from '../lib/vault-page'

// ---- the visibility picker — shared by the composer and the row editor.
// Three choices in the Knows scope vocabulary (the selected one takes its
// scope color), then the detail each needs: agent chips or a project select.
type ScopeType = 'global' | 'agents' | 'folder'

interface ScopeDraft {
  // null: nothing picked yet — the Vault itself never picks for you
  type: ScopeType | null
  agentIds: string[]
  folder: string
}

function draftToScope(d: ScopeDraft): VaultScope | null {
  if (d.type === null) return null
  if (d.type === 'global') return { type: 'global' }
  if (d.type === 'agents') return d.agentIds.length > 0 ? { type: 'agents', agentIds: d.agentIds } : null
  return d.folder ? { type: 'folder', folder: d.folder } : null
}

function draftOf(entry?: VaultEntry): ScopeDraft {
  if (!entry) return { type: 'agents', agentIds: [], folder: '' }
  return {
    type: entry.scope.type,
    agentIds: entry.scope.type === 'agents' ? entry.scope.agentIds : [],
    folder: entry.scope.type === 'folder' ? entry.scope.folder : '',
  }
}

const SCOPE_CHOICES: { type: ScopeType; label: string; scope: 'global' | 'agent' | 'project' }[] = [
  { type: 'agents', label: 'Specific agents', scope: 'agent' },
  { type: 'folder', label: 'One project', scope: 'project' },
  { type: 'global', label: 'Every agent', scope: 'global' },
]

function VisibilityPicker({
  draft,
  onChange,
  agents,
  folders,
  idPrefix,
  projects = [],
}: {
  draft: ScopeDraft
  onChange: (d: ScopeDraft) => void
  agents: VaultPageAgent[]
  folders: string[]
  idPrefix: string
  projects?: readonly string[]
}) {
  return (
    <div>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="who sees it">
        {SCOPE_CHOICES.map((c) => {
          const on = draft.type === c.type
          return (
            <button
              key={c.type}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange({ ...draft, type: c.type })}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${on ? 'font-medium' : 'border-line text-ink-2 hover:border-ink-3 hover:text-ink'}`}
              style={on ? { color: `var(--scope-${c.scope})`, background: `var(--scope-${c.scope}-soft)`, borderColor: `var(--scope-${c.scope})` } : undefined}
            >
              {c.label}
            </button>
          )
        })}
      </div>
      {draft.type === 'agents' ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {agents.map((a) => {
            const on = draft.agentIds.includes(a.id)
            return (
              <button
                key={a.id}
                type="button"
                aria-pressed={on}
                onClick={() => onChange({ ...draft, agentIds: on ? draft.agentIds.filter((x) => x !== a.id) : [...draft.agentIds, a.id] })}
                className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${on ? 'font-medium' : 'border-line text-ink-2 hover:border-ink-3 hover:text-ink'}`}
                style={on ? { color: 'var(--scope-agent)', background: 'var(--scope-agent-soft)', borderColor: 'var(--scope-agent)' } : undefined}
              >
                {a.name}
              </button>
            )
          })}
          {agents.length === 0 ? <span className="text-[11px] text-ink-3">no agents yet</span> : null}
        </div>
      ) : null}
      {draft.type === 'folder' ? (
        <select
          aria-label={`${idPrefix} project`}
          value={draft.folder}
          onChange={(ev) => onChange({ ...draft, folder: ev.target.value })}
          className="mt-2 rounded-md border border-line bg-canvas px-2 py-1.5 text-xs text-ink outline-none focus:border-terracotta"
        >
          <option value="">pick a project…</option>
          {folders.map((f) => (
            <option key={f} value={f}>
              {basename(f)}
            </option>
          ))}
        </select>
      ) : null}
      {draft.type === 'global' && projects.length > 1 ? (
        // «everyone» spelled as the projects it reaches, before it is saved
        <p className="mt-2 max-w-[62ch] text-[11.5px] leading-snug text-ink-2" data-testid="vault-everyone-projects">
          Every agent of <span className="text-ink">{andList(projects)}</span> finds it in its environment — every project on this install, and each one you add
          later.
        </p>
      ) : null}
    </div>
  )
}

// agent names as doors to each one's Secrets tab, joined the way joinNames
// joins them (« + », and «+ N more» past `max`); a name the roster doesn't
// know stays a word
function AgentNames({ names, agents, max = 3 }: { names: string[]; agents: VaultPageAgent[]; max?: number }) {
  const shown = names.length <= max ? names : names.slice(0, max - 1)
  const rest = names.length - shown.length
  return (
    <>
      {shown.map((n, i) => {
        const a = agents.find((x) => x.name === n)
        return (
          <Fragment key={`${n}-${i}`}>
            {i > 0 ? ' + ' : null}
            {a ? (
              <button
                type="button"
                onClick={() => openAgentSecrets(a.id)}
                title={`${n}’s Secrets — what reaches it, and why`}
                className="text-ink underline decoration-line underline-offset-2 hover:text-terracotta hover:decoration-terracotta/50"
              >
                {n}
              </button>
            ) : (
              n
            )}
          </Fragment>
        )
      })}
      {rest > 0 ? ` + ${rest} more` : null}
    </>
  )
}

// ---- one entry, expandable in place. `showName` is false inside a
// collision group (the group header already carries the name once).
function EntryRow({
  v,
  showName,
  expanded,
  onToggle,
  agents,
  folders,
  projects = [],
  onChanged,
  onError,
  asks,
  prefill,
  focused = false,
}: {
  v: AnnotatedVaultEntry
  showName: boolean
  expanded: boolean
  onToggle: () => void
  agents: VaultPageAgent[]
  folders: string[]
  projects?: readonly string[]
  onChanged: () => Promise<void>
  onError: (msg: string | null) => void
  // the live binding asks on this entry — what signing it would let go
  asks: BindingAsk[]
  // the ask the owner came from (/vault?sign=<task>): the editor opens on it
  prefill: BindingAsk | null
  // the entry the owner came for (/vault?entry=<id>, an agent's Secrets row)
  focused?: boolean
}) {
  const [draft, setDraft] = useState<ScopeDraft>(() => draftOf(v.entry))
  const [newValue, setNewValue] = useState('')
  const [busy, setBusy] = useState(false)
  // the binding editor open, the hand-back armed, and the server's warnings
  // of the last bind or move — shown as they came, until the row closes
  const [binding, setBinding] = useState<'idle' | 'editing' | 'handing-back'>(() => (prefill ? 'editing' : 'idle'))
  const [warnings, setWarnings] = useState<string[]>([])
  // what the last save answered: the tasks it let go
  const [released, setReleased] = useState<string | null>(null)
  const agentName = (id: string): string => agents.find((a) => a.id === id)?.name ?? id
  const rowRef = useRef<HTMLLIElement | null>(null)
  // re-arm the editor whenever the row opens (or the entry changed under it)
  useEffect(() => {
    setDraft(draftOf(v.entry))
    setNewValue('')
  }, [expanded, v.entry])
  useEffect(() => {
    if (!expanded) {
      setBinding('idle')
      setWarnings([])
      setReleased(null)
    }
  }, [expanded])
  // arriving from an ask's door: the editor open on it, the row in view
  useEffect(() => {
    if (!prefill) return
    setBinding('editing')
    rowRef.current?.scrollIntoView?.({ block: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.key])
  // arriving for this entry: the row in view (it is opened by the page)
  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView?.({ block: 'center' })
  }, [focused])

  const age = vaultAge(v.entry.createdAt)
  const scopeDirty = JSON.stringify(draftToScope(draft)) !== JSON.stringify(v.entry.scope)

  async function run(fn: () => Promise<unknown>, fallback: string): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await fn()
      onError(null)
      await onChanged()
    } catch (e) {
      onError(e instanceof Error ? e.message : fallback)
    } finally {
      setBusy(false)
    }
  }

  const saveVisibility = (): Promise<void> => {
    const scope = draftToScope(draft)
    if (!scope) return Promise.resolve()
    return run(async () => {
      const r = await api.vault.setScope(v.entry.id, scope)
      setWarnings(r.warnings)
    }, 'Could not change the visibility')
  }

  const handBack = (): Promise<void> =>
    run(async () => {
      await api.vault.setBinding(v.entry.id, null)
      setBinding('idle')
      setWarnings([])
    }, 'Could not hand it over again')

  // replacing a value keeps the delete+create discipline (the server never
  // edits a value in place) — and is honest when the second half fails.
  const replaceValue = async (): Promise<void> => {
    if (!newValue || busy) return
    setBusy(true)
    try {
      await api.vault.remove(v.entry.id)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not replace the value')
      setBusy(false)
      return
    }
    try {
      // a signed entry stays signed with the new value (the binding is the
      // owner's choice, not the value's)
      await api.vault.create({
        name: v.entry.name,
        value: newValue,
        scope: v.entry.scope,
        ...(v.entry.public ? { public: true } : {}),
        ...(v.entry.binding ? { binding: v.entry.binding } : {}),
      })
      onError(null)
    } catch {
      onError(`The old value was removed but the new one could not be saved — add ${v.entry.name} again.`)
    }
    setBusy(false)
    await onChanged()
  }

  // written by an agent into its own scope (createdBy) — named, so the owner
  // tells at a glance what they typed from what an agent stored itself
  const author = v.entry.createdBy ? (agents.find((a) => a.id === v.entry.createdBy)?.name ?? v.entry.createdBy) : null

  // every agent named is a door to its Secrets tab — what reaches it, and why
  const names = (list: string[], max = 3): ReactNode => <AgentNames names={list} agents={agents} max={max} />
  const reachSentence = (): ReactNode => {
    const parts: ReactNode[] = []
    if (author) parts.push(<>{v.entry.createdBy ? <AgentNames names={[author]} agents={agents} /> : author} stored it itself, in its own scope.</>)
    if (v.entry.scope.type === 'folder') {
      parts.push(
        <>
          Rides into whatever runs in {v.audienceWords}
          {v.reaches.length > 0 ? (
            <>
              {' '}
              — {names(v.reaches)} live{v.reaches.length === 1 ? 's' : ''} there
            </>
          ) : null}
          .
        </>,
      )
    } else if (v.reaches.length > 0) {
      parts.push(<>Reaches {v.entry.scope.type === 'global' ? (v.shadowedFor.length > 0 ? names(v.reaches, 99) : v.audienceWords) : names(v.reaches)}.</>)
    } else {
      parts.push('Reaches no one right now.')
    }
    if (v.shadowedFor.length > 0)
      parts.push(
        <>
          {names(v.shadowedFor)} get{v.shadowedFor.length === 1 ? 's' : ''} a more specific {v.entry.name} instead.
        </>,
      )
    return parts.map((p, i) => (
      <Fragment key={i}>
        {i > 0 ? ' ' : null}
        {p}
      </Fragment>
    ))
  }

  return (
    <li ref={rowRef} className={showName ? '' : 'border-l-2 border-line pl-3'}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={`flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-panel ${expanded ? 'bg-panel' : ''}`}
      >
        {showName ? <span className="font-mono text-[13px] text-ink">{v.entry.name}</span> : null}
        <span className="font-mono text-[11px] text-ink-3">{v.entry.value}</span>
        {v.entry.public ? <span className="text-[11px] text-ink-3">· not a secret</span> : null}
        <ScopePill scope={v.scope} label={v.audience} />
        <ModeMark entry={v.entry} compact />
        {v.shadowedFor.length > 0 ? (
          <span className="text-[11px] text-ink-3">
            except {v.shadowedFor.length === 1 ? 'Agent' : 'Agents'} · {joinNames(v.shadowedFor)}
          </span>
        ) : null}
        {asks.length > 0 ? (
          // said BEFORE the gesture: what signing this entry lets go
          <span className="inline-flex items-center gap-1 text-[11px] text-terracotta" data-testid="vault-unblocks">
            <Hourglass size={11} aria-hidden="true" className="shrink-0" />
            unblocks {asks.map((a) => a.ref).join(', ')}
          </span>
        ) : null}
        <span className="ml-auto whitespace-nowrap font-mono text-[11px] text-ink-3">
          {author ? `by ${author} · ` : ''}
          {age ?? ''}
        </span>
      </button>
      {expanded ? (
        <div className="mb-2 ml-2 mt-1 space-y-3 rounded-md border border-line bg-canvas px-3 py-3">
          <p className="max-w-[62ch] text-xs text-ink-2">
            {reachSentence()}
            {v.entry.scope.type === 'folder' ? <span className="mt-0.5 block break-all font-mono text-[10.5px] text-ink-3">{v.entry.scope.folder}</span> : null}
          </p>
          <div>
            <div className="mb-1.5 text-[11px] font-medium text-ink-2">Visibility</div>
            <VisibilityPicker draft={draft} onChange={setDraft} agents={agents} folders={folders} projects={projects} idPrefix={`${v.entry.id} visibility`} />
            {scopeDirty ? (
              <button
                type="button"
                onClick={() => void saveVisibility()}
                disabled={busy || draftToScope(draft) === null}
                className="mt-2 rounded-md bg-terracotta px-2.5 py-1 text-xs font-medium text-on-terracotta hover:opacity-90 disabled:opacity-40"
              >
                {busy ? 'Saving…' : 'Save visibility'}
              </button>
            ) : null}
          </div>
          {warnings.length > 0 && binding !== 'editing' ? <ServerWarnings warnings={warnings} /> : null}
          {released && binding !== 'editing' ? (
            <p role="status" className="max-w-[62ch] text-[11.5px] leading-snug text-ink" data-testid="vault-released">
              {released}
            </p>
          ) : null}
          {asks.length > 0 && binding === 'idle' && !v.entry.public ? (
            <p className="max-w-[62ch] text-[11px] leading-snug text-ink-2">
              {asks.length === 1 ? `${asks[0]!.ref} waits for you to sign it` : `${asks.length} tasks wait for you to sign it`} —{' '}
              <button type="button" onClick={() => setBinding('editing')} className="text-terracotta hover:underline">
                review {asks.length === 1 ? 'the proposal' : 'the proposals'}
              </button>
              .
            </p>
          ) : null}
          {!v.entry.public ? (
            <div data-testid="vault-mode">
              <div className="mb-1.5 text-[11px] font-medium text-ink-2">How it reaches them</div>
              <div
                role="radiogroup"
                aria-label={`${v.entry.name} reaches them`}
                className="inline-flex flex-col rounded-md sm:flex-row border border-line p-0.5 text-xs"
              >
                {([false, true] as const).map((signed) => {
                  // the mode on screen: the one being chosen, else the entry's
                  const shown = binding === 'editing' ? true : binding === 'handing-back' ? false : v.entry.binding !== undefined
                  const on = shown === signed
                  return (
                    <button
                      key={String(signed)}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      disabled={busy}
                      onClick={() => {
                        if (signed) setBinding(v.entry.binding ? 'idle' : 'editing')
                        else setBinding(v.entry.binding ? 'handing-back' : 'idle')
                      }}
                      className={`rounded px-2.5 py-0.5 text-left ${on ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink'}`}
                    >
                      {signed ? MODE_SIGNED : MODE_DELIVERED}
                    </button>
                  )
                })}
              </div>
              {binding === 'editing' ? (
                <div className="mt-2.5 space-y-3 rounded-md border border-line px-3 py-2.5">
                  <BindingEditor
                    key={prefill?.key ?? 'own'}
                    entry={v.entry}
                    proposals={asks}
                    prefill={prefill}
                    nameOf={agentName}
                    onCancel={() => setBinding('idle')}
                    onSaved={async (w, resolved) => {
                      setWarnings(w)
                      setReleased(resolutionWords(resolved, agentName))
                      setBinding('idle')
                      onError(null)
                      await onChanged()
                    }}
                  />
                  <SigningLimits />
                </div>
              ) : binding === 'handing-back' ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-2">
                  <span className="max-w-[56ch]">Its value goes back into the environment of whoever sees it, from their next conversation.</span>
                  <button
                    type="button"
                    onClick={() => void handBack()}
                    disabled={busy}
                    className="rounded-md bg-terracotta px-2.5 py-1 text-xs font-medium text-on-terracotta hover:opacity-90 disabled:opacity-40"
                  >
                    Hand it over
                  </button>
                  <button type="button" onClick={() => setBinding('idle')} className="rounded px-1.5 py-0.5 text-xs text-ink-3 hover:text-ink">
                    Keep it signed
                  </button>
                </div>
              ) : v.entry.binding ? (
                <div className="mt-2.5 space-y-3">
                  <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
                    <dt className="text-ink-3">service</dt>
                    <dd className="truncate font-mono text-ink">{v.entry.binding.baseUrl}</dd>
                    <dt className="text-ink-3">sends</dt>
                    <dd className="truncate font-mono text-ink">
                      {v.entry.binding.inject.header}: {v.entry.binding.inject.format.replace('%s', '••••')}
                    </dd>
                    <dt className="text-ink-3">agents call</dt>
                    <dd className="break-all font-mono text-ink-2">{egressUrl(v.entry.name)}</dd>
                  </dl>
                  <button type="button" onClick={() => setBinding('editing')} className="text-[11px] text-ink-2 hover:text-terracotta">
                    Change the signing
                  </button>
                  <SignedCallsFold filter={{ entry: v.entry.id }} nameOf={(id) => (id === null ? 'you' : (agents.find((a) => a.id === id)?.name ?? id))} />
                  <SigningLimits />
                </div>
              ) : (
                <p className="mt-1 max-w-[62ch] text-[10.5px] text-ink-3">
                  The value rides in their environment. Signed by Silos, it never would — they call the service through Silos, which adds it.
                </p>
              )}
            </div>
          ) : null}
          <div>
            <div className="mb-1.5 text-[11px] font-medium text-ink-2">What it is</div>
            <div role="radiogroup" aria-label={`${v.entry.name} is`} className="inline-flex rounded-md border border-line p-0.5 text-xs">
              {([false, true] as const).map((pub) => {
                const on = (v.entry.public === true) === pub
                return (
                  <button
                    key={String(pub)}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={busy}
                    onClick={() => {
                      if (!on) void run(() => api.vault.setPublic(v.entry.id, pub), 'Could not change it')
                    }}
                    className={`rounded px-2.5 py-0.5 ${on ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink'}`}
                  >
                    {pub ? 'Not a secret' : 'Secret'}
                  </button>
                )
              })}
            </div>
            <p className="mt-1 max-w-[62ch] text-[10.5px] text-ink-3">
              {v.entry.public
                ? 'Plain configuration: shown in clear, left as is in run logs, and a role pack or template may hold it. It still reaches only who sees it.'
                : 'Masked here, blanked out of run logs, and no role pack or template may hold its value.'}
            </p>
          </div>
          <div>
            <div className="mb-1.5 text-[11px] font-medium text-ink-2">Replace the value</div>
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                type="password"
                aria-label={`new value for ${v.entry.name}`}
                value={newValue}
                onChange={(ev) => setNewValue(ev.target.value)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') void replaceValue()
                }}
                placeholder="new value"
                className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1 font-mono text-[11px] outline-none focus:border-terracotta"
              />
              <button
                type="button"
                onClick={() => void replaceValue()}
                disabled={!newValue || busy}
                className="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs text-ink-2 hover:border-ink-3 hover:text-ink disabled:opacity-40"
              >
                Replace value
              </button>
            </div>
            <p className="mt-1 text-[10.5px] text-ink-3">Values are never edited in place — the old one goes, the new one is added.</p>
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-line/60 pt-2">
            <span className="font-mono text-[10.5px] text-ink-3">
              {v.entry.createdAt ? `added ${new Date(v.entry.createdAt).toLocaleDateString()}` : 'age unknown'}
            </span>
            <ConfirmButton
              onConfirm={() => void run(() => api.vault.remove(v.entry.id), 'Could not delete')}
              ariaLabel={`delete ${v.entry.name}`}
              confirmLabel={`${lossPhrase(v)} — sure?`}
              className="rounded-md border border-line px-2.5 py-1 text-xs text-ink-2 hover:border-terracotta hover:text-terracotta"
              armedClassName="rounded-md bg-terracotta px-2.5 py-1 text-xs font-medium text-on-terracotta"
            >
              Delete
            </ConfirmButton>
          </div>
        </div>
      ) : null}
    </li>
  )
}

// ---- the add composer — visibility is the protagonist: who sees it comes
// first, then the name and the value (pasted once, never shown again).
function AddComposer({
  agents,
  folders,
  projects,
  start,
  onAdded,
  onError,
  onClose,
}: {
  agents: VaultPageAgent[]
  folders: string[]
  projects: readonly string[]
  /** where it was opened from — the scope it starts on (null: nothing picked) */
  start: ScopeDraft | null
  onAdded: () => Promise<void>
  onError: (msg: string | null) => void
  onClose: (() => void) | null
}) {
  const [draft, setDraft] = useState<ScopeDraft>(start ?? { type: null, agentIds: [], folder: '' })
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const scope = draftToScope(draft)
  const ready = scope !== null && name.trim() !== '' && value !== ''

  async function add(): Promise<void> {
    if (!ready || saving || scope === null) return
    setSaving(true)
    try {
      await api.vault.create({ name: name.trim(), value, scope })
      setName('')
      setValue('')
      onError(null)
      await onAdded()
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-lg border border-line bg-panel/60 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-ink">Add a secret</h3>
        {onClose ? (
          <button type="button" onClick={onClose} className="rounded px-1.5 py-0.5 text-xs text-ink-3 hover:text-ink">
            Cancel
          </button>
        ) : null}
      </div>
      <div className="mt-2.5">
        <div className="mb-1.5 text-[11px] font-medium text-ink-2">Who sees it</div>
        <VisibilityPicker draft={draft} onChange={setDraft} agents={agents} folders={folders} projects={projects} idPrefix="new secret" />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          aria-label="secret name"
          value={name}
          onChange={(ev) => setName(ev.target.value.toUpperCase())}
          placeholder="STRIPE_KEY"
          className="w-44 rounded-md border border-line bg-canvas px-2 py-1.5 font-mono text-xs outline-none focus:border-terracotta"
        />
        <input
          aria-label="secret value"
          type="password"
          value={value}
          onChange={(ev) => setValue(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') void add()
          }}
          placeholder="value — pasted once, stored masked"
          className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1.5 font-mono text-xs outline-none focus:border-terracotta"
        />
        <button
          type="button"
          onClick={() => void add()}
          disabled={!ready || saving}
          className="ml-auto rounded-md bg-terracotta px-3 py-1.5 text-xs font-medium text-on-terracotta hover:opacity-90 disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Add to vault'}
        </button>
      </div>
    </div>
  )
}

// «Add a secret» opened from a place (`add` = project:<folder> · agent:<id>)
// starts on it; from the Vault itself nothing is picked
function startOf(add: string | undefined, agents: readonly { id: string }[]): ScopeDraft | null {
  if (!add) return null
  if (add.startsWith('project:') && add.length > 'project:'.length) return { type: 'folder', agentIds: [], folder: add.slice('project:'.length) }
  if (add.startsWith('agent:') && agents.some((a) => a.id === add.slice('agent:'.length)))
    return { type: 'agents', agentIds: [add.slice('agent:'.length)], folder: '' }
  return null
}

export function VaultPage({ sign, entry, add }: { sign?: string; entry?: string; add?: string } = {}) {
  const agents = useStore((s) => s.agents)
  const [entries, setEntries] = useState<VaultEntry[] | null>(null)
  // the live binding asks, by the entry each would be resolved on
  const [asks, setAsks] = useState<BindingAsk[]>([])
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<VaultSort>('name')
  const [composerOpen, setComposerOpen] = useState(add !== undefined)
  useEffect(() => {
    if (add) setComposerOpen(true)
  }, [add])
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const realAgents: VaultPageAgent[] = useMemo(
    () => agents.filter((a) => a.folder !== null).map((a) => ({ id: a.id, name: a.name, folder: a.folder })),
    [agents],
  )
  const folders = useMemo(() => [...new Set(agents.map((a) => a.folder).filter((f): f is string => f !== null))], [agents])

  async function load(): Promise<void> {
    try {
      setEntries(await api.vault.list())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the vault')
    }
    // the asks are a reading beside the ring: one that fails leaves the
    // ring as it is, said nowhere but in the asks being absent
    try {
      const a = await api.vault.asks()
      setAsks(Array.isArray(a) ? a : [])
    } catch {
      setAsks([])
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const asksByEntry = useMemo(() => {
    const m = new Map<string, BindingAsk[]>()
    for (const a of asks) if (a.entryId !== null && a.problem === null) m.set(a.entryId, [...(m.get(a.entryId) ?? []), a])
    return m
  }, [asks])
  // the ask the owner came from: only a sound one opens an editor — a broken
  // ask (no such entry, not visible, public) is said, never prefilled
  const signing = sign ? (asks.find((a) => a.key === sign) ?? null) : null
  const prefill = signing && signing.entryId !== null && signing.problem === null ? signing : null
  useEffect(() => {
    if (prefill) setExpandedId(prefill.entryId)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opens once per ask, not on every re-read of the list
  }, [prefill?.key, prefill?.entryId])
  // came for one entry (an agent's Secrets row): it opens, once it is read
  const entryKnown = entries?.some((e) => e.id === entry) ?? false
  useEffect(() => {
    if (entry && entryKnown) setExpandedId(entry)
  }, [entry, entryKnown])

  const projects = useMemo(() => installProjects(agents), [agents])
  const groups = useMemo(() => vaultGroups(entries ?? [], realAgents, projects), [entries, realAgents, projects])
  const visible = useMemo(() => sortGroups(filterGroups(groups, query), sort), [groups, query, sort])
  const signedCount = (entries ?? []).filter((e) => e.binding !== undefined).length
  const counts = countsPhrase(entries ?? [])
  const pulse = counts && signedCount > 0 ? `${counts} · ${signedCount} signed by Silos` : counts
  const empty = entries !== null && entries.length === 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* the common band: every root page names itself in the
          same place — the body below now shares its left edge instead of
          centring, so moving between root pages never moves the title. The
          facts say what the vault holds; adding is the page's one verb. */}
      <PageHeader
        testId="vault-header"
        title="System"
        tabs={<SystemTabs />}
        facts={<span className="min-w-0 truncate">{pulse || 'Nothing stored yet'}</span>}
        actions={
          !empty && entries !== null ? (
            <HeaderButton primary expanded={composerOpen} onClick={() => setComposerOpen(true)} testId="vault-add">
              <Plus size={13} aria-hidden="true" />
              Add a secret
            </HeaderButton>
          ) : null
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="w-full max-w-3xl px-4 pb-16 pt-4 sm:px-5">
          <p className="max-w-[62ch] text-xs text-ink-2">
            Secrets your agents use in their chats and consoles — in their environment, or signed by Silos so the value never reaches them. Stored on this
            machine, masked unless you mark one «Not a secret». What one agent gets, and why, is its Secrets tab — open a secret and each agent it names is the
            door there.
          </p>

          {error ? (
            <p role="alert" className="mt-3 text-sm text-terracotta">
              {error}
            </p>
          ) : null}
          {/* an ask's door that cannot prefill: said, never an editor
            toward an entry that would be created on the fly */}
          {sign && entries !== null && !prefill ? (
            <p role="status" data-testid="vault-sign-broken" className="mt-3 max-w-[62ch] text-xs leading-snug text-ink-2">
              {signing ? (
                <>
                  <span className="font-mono">{signing.ref}</span>: {signing.problem ?? `${signing.entry} cannot be signed from this ask.`}
                </>
              ) : (
                'That ask is no longer waiting — it was answered, or its task moved on.'
              )}
            </p>
          ) : null}

          {!empty ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <input
                type="search"
                aria-label="search the vault"
                value={query}
                onChange={(ev) => setQuery(ev.target.value)}
                placeholder="Search by name or agent…"
                className="min-w-0 flex-1 basis-48 rounded-md border border-line bg-canvas px-2.5 py-1.5 text-xs outline-none placeholder:text-ink-3 focus:border-terracotta"
              />
              <div className="flex items-center gap-0.5 rounded-md border border-line p-0.5" role="group" aria-label="sort">
                {(['name', 'oldest'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={sort === s}
                    onClick={() => setSort(s)}
                    className={`rounded px-2 py-1 text-[11px] transition-colors ${sort === s ? 'bg-panel font-medium text-ink' : 'text-ink-3 hover:text-ink'}`}
                  >
                    {s === 'name' ? 'Name' : 'Oldest first'}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {composerOpen || empty ? (
            <div className="mt-3">
              <AddComposer
                key={add ?? ''}
                agents={realAgents}
                folders={add?.startsWith('project:') && !folders.includes(add.slice('project:'.length)) ? [...folders, add.slice('project:'.length)] : folders}
                projects={projects}
                start={startOf(add, realAgents)}
                onAdded={async () => {
                  setComposerOpen(false)
                  await load()
                }}
                onError={setError}
                onClose={empty ? null : () => setComposerOpen(false)}
              />
            </div>
          ) : null}

          {empty ? (
            <p className="mt-3 max-w-[62ch] text-sm text-ink-2">
              The vault is empty. A secret is an env var an agent finds in its environment — a Stripe key for the Finance, a deploy token for a project. Add one
              above and name who sees it.
            </p>
          ) : null}

          {entries === null && !error ? <p className="mt-6 text-xs text-ink-3">Loading…</p> : null}

          {visible.length > 0 ? (
            <ul role="list" className="mt-4 divide-y divide-line/60">
              {visible.map((g) => (
                <li key={g.name} className="py-1">
                  {g.entries.length > 1 ? (
                    <div>
                      <div className="flex flex-wrap items-baseline gap-x-3 px-2 pb-0.5 pt-1.5">
                        <span className="font-mono text-[13px] text-ink">{g.name}</span>
                        <span className="text-[11px] text-ink-3">{g.entries.length} entries — the most specific wins</span>
                      </div>
                      <ul role="list" className="ml-2 space-y-0.5">
                        {g.entries.map((v) => (
                          <EntryRow
                            key={v.entry.id}
                            v={v}
                            showName={false}
                            expanded={expandedId === v.entry.id}
                            onToggle={() => setExpandedId((id) => (id === v.entry.id ? null : v.entry.id))}
                            agents={realAgents}
                            folders={folders}
                            projects={projects}
                            onChanged={load}
                            onError={setError}
                            asks={asksByEntry.get(v.entry.id) ?? []}
                            prefill={prefill?.entryId === v.entry.id ? prefill : null}
                            focused={entry === v.entry.id}
                          />
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <ul role="list">
                      {g.entries.map((v) => (
                        <EntryRow
                          key={v.entry.id}
                          v={v}
                          showName
                          expanded={expandedId === v.entry.id}
                          onToggle={() => setExpandedId((id) => (id === v.entry.id ? null : v.entry.id))}
                          agents={realAgents}
                          folders={folders}
                          projects={projects}
                          onChanged={load}
                          onError={setError}
                          asks={asksByEntry.get(v.entry.id) ?? []}
                          prefill={prefill?.entryId === v.entry.id ? prefill : null}
                          focused={entry === v.entry.id}
                        />
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          ) : null}

          {entries !== null && entries.length > 0 && visible.length === 0 ? (
            <p className="mt-6 text-sm text-ink-2">Nothing named like that in the vault.</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
