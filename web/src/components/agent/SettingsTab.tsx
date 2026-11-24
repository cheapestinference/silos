// SettingsTab.tsx — the agent's editor, in the two halves its Settings page
// shows: `who` (emoji, name, archive) and `runs` (folders, engine,
// model, voice, provider) — each card swaps in the half it shows, so a
// value is edited where it is read. One form state, one save. Its mission has its own editor, at the head of the page
// (MissionHeader). Extracted from AgentPage.tsx; the Who card swaps it
// in for its body while editing.
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { MASTER_ID } from '../../lib/constants'
import type { AgentView, HarnessId, ProviderView } from '../../lib/types'
import { GATEWAY_MODEL_PLACEHOLDER, useModelOptions } from '../../hooks/useModelOptions'
import { fieldForError, formToPayload, formFromAgent, MODELS, type AgentFormState } from '../AgentModal'
import { bareGatewayModel, providerOptions, providerLabel } from '../../lib/providers'
import { humanizeProviderIds } from '../../lib/runs-on'
import { useHarness } from '../../lib/harnesses'
import { useOutputStyles } from '../../hooks/useOutputStyles'

const CONFIRM_ARCHIVE_MS = 3000

// ---------------------------------------------------------------------------
// Settings (formerly Identity) — editable inline, reuses AgentModal's
// validation/error mapping.
// ---------------------------------------------------------------------------
// `onDone`: the Who card swaps this editor in for its body — a successful
// save (or Cancel) hands the card back. `inline` drops the page padding.
export function SettingsTab({ agent, onDone, inline = false, fields }: { agent: AgentView; onDone?: () => void; inline?: boolean; fields: 'who' | 'runs' }) {
  const who = fields === 'who'
  const runs = fields === 'runs'
  const loadOverview = useStore((s) => s.loadOverview)
  const selectedAgentId = useStore((s) => s.selectedAgentId)
  const isMaster = agent.id === MASTER_ID

  const [form, setForm] = useState<AgentFormState>(() => formFromAgent(agent))
  // the model list follows the agent's harness (OpenCode: `opencode models`, by provider)
  // the providers (keys masked) — the provider fields and the model picker read the same list
  const [providers, setProviders] = useState<ProviderView[] | null>(null)
  useEffect(() => {
    let cancelled = false
    // Promise.resolve(...) — the same defensive pattern as AccountFooter
    // (Sidebar.tsx): the test automock returns undefined.
    Promise.resolve(api.providers.list())
      .then((p) => {
        if (!cancelled) setProviders(p ?? [])
      })
      .catch(() => {
        if (!cancelled) setProviders([])
      })
    return () => {
      cancelled = true
    }
  }, [])
  // the agent's engine (no framework = the default engine), read subscribed
  const engine = useHarness(agent.framework)
  const modelPick = useModelOptions(engine.id, form.provider, form.model, MODELS, providers)
  // the voice its conversations answer in — only an engine with styles
  const styles = useOutputStyles(agent.id, engine.caps.outputStyles)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // the shown agent can change (a different agent selected while this tab
  // stays open) — reloads the form from scratch.
  useEffect(() => {
    setForm(formFromAgent(agent))
    setError(null)
    setNotice(null)
    setConfirmArchive(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id])

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  function update<K extends keyof AgentFormState>(field: K, value: AgentFormState[K]): void {
    setForm((f) => ({ ...f, [field]: value }))
    setNotice(null)
  }

  async function save(): Promise<void> {
    setError(null)
    setNotice(null)
    setSaving(true)
    try {
      const payload = formToPayload(form)
      const r = await api.agents.update(agent.id, payload as Parameters<typeof api.agents.update>[1])
      await loadOverview()
      // a folder it was just given whose starting set could not be written
      setNotice(r?.startWarn ? `Saved. ${r.startWarn}` : 'Saved')
      onDone?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  function onClickArchive(): void {
    if (confirmArchive) {
      if (timer.current) clearTimeout(timer.current)
      setConfirmArchive(false)
      void (async () => {
        try {
          await api.agents.archive(agent.id)
          // the same as AgentPanel used to do: archiving the open agent
          // leaves the selection pointing at an agent that's no longer
          // active — it's cleaned up BEFORE reloading the overview.
          if (agent.id === selectedAgentId) {
            useStore.getState().closeSession()
            useStore.setState({ selectedAgentId: null, mobileView: 'list', page: null })
          }
          await loadOverview()
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })()
      return
    }
    setConfirmArchive(true)
    timer.current = setTimeout(() => setConfirmArchive(false), CONFIRM_ARCHIVE_MS)
  }

  const errorFieldValue = error ? fieldForError(error) : null
  const shown = who ? errorFieldValue === 'name' : errorFieldValue === 'folder' || errorFieldValue === 'folders'
  const errorTop = error && !shown ? error : null

  return (
    <div className={inline ? 'flex flex-col gap-3' : 'flex h-full flex-col gap-3 overflow-y-auto p-4'}>
      {errorTop ? <p className="text-sm text-terracotta">{errorTop}</p> : null}

      {who ? (
        <>
          <div className="flex gap-3">
            <div className="w-16">
              <label htmlFor="identity-emoji" className="mb-1 block text-xs text-ink-2">
                Emoji
              </label>
              <input
                id="identity-emoji"
                type="text"
                value={form.emoji}
                onChange={(e) => update('emoji', e.target.value)}
                className="w-full rounded-lg border border-line bg-canvas px-3 py-1.5 text-center text-sm outline-none focus:border-terracotta"
              />
            </div>
            <div className="flex-1">
              <label htmlFor="identity-name" className="mb-1 block text-xs text-ink-2">
                Name
              </label>
              <input
                id="identity-name"
                type="text"
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
                className="w-full rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm outline-none focus:border-terracotta"
              />
              {errorFieldValue === 'name' ? <p className="mt-0.5 text-xs text-terracotta">{error}</p> : null}
            </div>
          </div>
          <p className="-mt-2 text-xs text-ink-2">{agent.id}</p>
        </>
      ) : null}

      {runs ? (
        <>
          <div>
            <label htmlFor="identity-folder" className="mb-1 block text-xs text-ink-2">
              Folder
            </label>
            <input
              id="identity-folder"
              type="text"
              value={form.folder}
              disabled={isMaster}
              onChange={(e) => update('folder', e.target.value)}
              className="w-full rounded-lg border border-line bg-canvas px-3 py-1.5 font-mono text-sm outline-none focus:border-terracotta disabled:opacity-50"
            />
            {errorFieldValue === 'folder' ? <p className="mt-0.5 text-xs text-terracotta">{error}</p> : null}
          </div>

          {isMaster ? null : (
            <div>
              <label htmlFor="identity-folders" className="mb-1 block text-xs text-ink-2">
                Also works in
              </label>
              <textarea
                id="identity-folders"
                rows={Math.max(2, form.folders.split('\n').length)}
                value={form.folders}
                placeholder="/home/you/another-project"
                spellCheck={false}
                onChange={(e) => update('folders', e.target.value)}
                className="w-full resize-y rounded-lg border border-line bg-canvas px-3 py-1.5 font-mono text-sm leading-relaxed outline-none placeholder:text-ink-3 focus:border-terracotta"
              />
              {errorFieldValue === 'folders' ? (
                <p className="mt-0.5 text-xs text-terracotta">{error}</p>
              ) : (
                <p className="mt-0.5 text-[11px] text-ink-3">One absolute path per line. It joins those projects; conversations still start in Folder.</p>
              )}
            </div>
          )}

          <div>
            <span className="mb-1 block text-xs text-ink-2">Engine</span>
            <p className="text-sm text-ink">
              {engine.label} <span className="text-xs text-ink-3">· chosen at creation</span>
            </p>
          </div>

          <div>
            <label htmlFor="identity-model" className="mb-1 block text-xs text-ink-2">
              Model
            </label>
            {modelPick.gateway ? (
              // an Anthropic-compatible gateway on OpenCode: its models are the
              // gateway's own names — typed, stored bare, run under silos-<id>/
              <>
                <input
                  id="identity-model"
                  type="text"
                  value={form.model}
                  onChange={(e) => update('model', bareGatewayModel(modelPick.gateway!, e.target.value))}
                  placeholder={GATEWAY_MODEL_PLACEHOLDER}
                  className="w-full rounded-lg border border-line bg-canvas px-3 py-1.5 font-mono text-xs outline-none focus:border-terracotta"
                />
                <p className="mt-0.5 text-xs text-ink-2">
                  Runs as <span className="font-mono text-ink">{form.model.trim() || '…'}</span> on{' '}
                  {humanizeProviderIds(modelPick.gateway ?? '', providers ?? [])}
                </p>
              </>
            ) : engine.ui.models === 'none' && modelPick.listed.length === 0 ? (
              // an engine with no model list (ui.models 'none'): a typed id, as
              // the engine names it; empty = the engine picks
              <input
                id="identity-model"
                type="text"
                value={form.model}
                onChange={(e) => update('model', e.target.value.trim())}
                placeholder={`model id as ${engine.label} names it — empty lets it pick`}
                className="w-full rounded-lg border border-line bg-canvas px-3 py-1.5 font-mono text-xs outline-none focus:border-terracotta"
              />
            ) : (
              <select
                id="identity-model"
                value={form.model}
                onChange={(e) => update('model', e.target.value)}
                className="w-full rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm outline-none focus:border-terracotta"
              >
                {modelPick.options.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            )}
          </div>

          {engine.caps.outputStyles ? (
            <div>
              <label htmlFor="identity-style" className="mb-1 block text-xs text-ink-2">
                Answers in
              </label>
              <select
                id="identity-style"
                value={form.outputStyle}
                onChange={(e) => update('outputStyle', e.target.value)}
                className="w-full rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm outline-none focus:border-terracotta"
              >
                <option value="">Your Claude Code setting</option>
                {/* the saved style stays visible even when its file is gone */}
                {form.outputStyle !== '' && styles !== null && !styles.some((s) => s.id === form.outputStyle) ? (
                  <option value={form.outputStyle}>{form.outputStyle} — not found</option>
                ) : null}
                {(styles ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id === 'default' ? 'Default' : s.id}
                    {s.source === 'project' ? ' — this project' : s.source === 'user' ? ' — yours' : ''}
                  </option>
                ))}
              </select>
              <p className="mt-0.5 text-[11px] text-ink-3">
                {form.outputStyle === ''
                  ? 'Nothing set here: your own Claude Code config decides. A conversation can still pick one in Run on.'
                  : (styles ?? []).find((s) => s.id === form.outputStyle)?.description ||
                    'Its conversations answer in this style unless one picks another in Run on.'}
              </p>
            </div>
          ) : null}

          <ProviderFields form={form} update={update} harness={engine.id} providers={providers} />
        </>
      ) : null}

      <div className="mt-1 flex items-center justify-between">
        {who && !isMaster ? (
          <button type="button" onClick={onClickArchive} className="text-sm text-terracotta/80 hover:text-terracotta">
            {confirmArchive ? 'sure? archive' : 'Archive agent'}
          </button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-3">
          {notice ? <span className="text-xs text-ink-2">{notice}</span> : null}
          {onDone ? (
            <button type="button" onClick={onDone} disabled={saving} className="text-sm text-ink-2 hover:text-ink">
              Cancel
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded-lg bg-terracotta px-4 py-1.5 text-sm font-medium text-on-terracotta hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Providers v1 — a provider selector + fallback chain (the agent's
// Settings). The selector offers Default · each Claude account · each
// by-key provider (GET /api/providers, keys always masked). The fallback
// picker only offers by-key providers — a choice of this form, not of the
// runtime: a Claude account already in the chain is used as a fallback
// (server/src/fallback.ts).
// ---------------------------------------------------------------------------
function ProviderFields({
  form,
  update,
  harness,
  providers,
}: {
  form: AgentFormState
  update: <K extends keyof AgentFormState>(field: K, value: AgentFormState[K]) => void
  harness: HarnessId
  providers: ProviderView[] | null
}) {
  // only what this agent's harness can run (OpenCode: no Claude accounts;
  // Claude Code: no OpenCode providers)
  const d = useHarness(harness)
  const options = providerOptions(providers ?? [], harness)
  const byKey = options.filter((o) => o.kind !== 'claude-account')
  const available = byKey.filter((o) => !o.needsKey && !form.fallback.includes(o.value) && o.value !== form.provider)
  const chosen = options.find((o) => o.value === form.provider)

  // a DELETED provider still referenced by the agent would leave the
  // controlled <select> with a value that has no matching <option> — the
  // browser paints "Default" but Save would send the ghost id and the
  // server rejects it with 400 without the user having touched anything.
  // The form is normalized to what the runtime does in practice (fall back
  // to default / skip the id).
  useEffect(() => {
    if (providers === null) return
    const known = new Set(options.map((o) => o.value))
    if (form.provider !== '' && !known.has(form.provider)) update('provider', '')
    const knownFallback = form.fallback.filter((id) => known.has(id))
    if (knownFallback.length !== form.fallback.length) update('fallback', knownFallback)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, form.provider, form.fallback])

  function removeFallback(id: string): void {
    update(
      'fallback',
      form.fallback.filter((f) => f !== id),
    )
  }

  return (
    <>
      <div>
        <label htmlFor="identity-provider" className="mb-1 block text-xs text-ink-2">
          Provider
        </label>
        <select
          id="identity-provider"
          value={form.provider}
          onChange={(e) => update('provider', e.target.value)}
          className="w-full rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm outline-none focus:border-terracotta"
        >
          {options.length === 0 ? <option value="">Default</option> : null}
          {options.map((o) => (
            // a cleared key can't run: listed (so the agent's current pick is
            // still visible) but not choosable
            <option key={o.value || 'default'} value={o.value} disabled={o.needsKey && o.value !== form.provider}>
              {o.value === ''
                ? d.ui.ownLogin
                  ? `Default — ${d.label}’s own login`
                  : `Default — ${o.label}`
                : o.needsKey
                  ? `${o.label} — key needed`
                  : o.label}
            </option>
          ))}
        </select>
        {chosen?.needsKey ? (
          <p className="mt-0.5 text-xs text-terracotta">
            This provider&rsquo;s key was cleared — paste it again in Settings › Accounts &amp; providers, or this agent won&rsquo;t start.
          </p>
        ) : null}
      </div>

      <div>
        <span className="mb-1 block text-xs text-ink-2">Fallback chain</span>
        {form.fallback.length > 0 ? (
          <ol className="mb-1.5 flex flex-wrap items-center gap-1.5">
            {form.fallback.map((id, i) => (
              <li key={id} className="flex items-center gap-1.5">
                {i > 0 ? (
                  <span aria-hidden="true" className="text-xs text-ink-2">
                    →
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => removeFallback(id)}
                  title="remove from chain"
                  className="rounded-full border border-line bg-panel px-2 py-0.5 text-xs text-ink hover:border-terracotta hover:text-terracotta"
                >
                  <span>{providerLabel(providers ?? [], id)}</span> <span aria-hidden="true">×</span>
                </button>
              </li>
            ))}
          </ol>
        ) : null}
        {available.length > 0 ? (
          <select
            aria-label="add fallback provider"
            value=""
            onChange={(e) => {
              if (e.target.value !== '') update('fallback', [...form.fallback, e.target.value])
            }}
            className="w-full rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm text-ink-2 outline-none focus:border-terracotta"
          >
            <option value="">Add a fallback provider…</option>
            {available.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : form.fallback.length === 0 ? (
          <p className="text-xs text-ink-2">
            No key providers yet — add one in Settings › Accounts &amp; providers to enable fallback when this agent hits its usage limit.
          </p>
        ) : null}
        {form.fallback.length > 0 ? (
          <p className="mt-1 text-xs text-ink-2">When the primary hits its usage limit, the next turn switches here until the window resets.</p>
        ) : null}
      </div>
    </>
  )
}

// «Save as role pack»: the agent's role (charter, instructions, skills, the
// silos it produces, its automations as templates, the NAMES of its secrets)
// as one file — never its memory, transcripts or secret values
export function SaveRolePack({ agentId }: { agentId: string }) {
  const [said, setSaid] = useState<{ text: string; bad: boolean } | null>(null)
  // the Vault entry a refused export names: the owner may mark it public there
  const [ask, setAsk] = useState<{ name: string; id: string | null } | null>(null)
  // the folder's skills the export can carry: null = not asked yet
  const [offer, setOffer] = useState<{ name: string; description: string; from: 'folder' | 'personal' }[] | null>(null)
  const [take, setTake] = useState<Set<string>>(new Set())
  async function start(): Promise<void> {
    setSaid(null)
    setAsk(null)
    try {
      const list = await api.rolePacks.folderSkills(agentId)
      if (list.length === 0) {
        void save([])
        return
      }
      setOffer(list)
      setTake(new Set()) // nothing pre-ticked: a shared folder holds other agents' skills
    } catch (e) {
      setSaid({ text: e instanceof Error ? e.message : String(e), bad: true })
    }
  }
  async function save(skills: string[] = [...take]): Promise<void> {
    setSaid(null)
    setAsk(null)
    try {
      const { pack, skipped } = await api.rolePacks.export(agentId, skills)
      const url = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `${pack.id}.role-pack.json`
      a.click()
      URL.revokeObjectURL(url)
      setSaid({ text: skipped.length ? `Saved — left out: ${skipped.join('; ')}` : 'Saved', bad: false })
      setOffer(null)
    } catch (e) {
      setSaid({ text: e instanceof Error ? e.message : String(e), bad: true })
      const secret = (e as { body?: { secret?: { name?: unknown; id?: unknown } } }).body?.secret
      setAsk(typeof secret?.name === 'string' ? { name: secret.name, id: typeof secret.id === 'string' ? secret.id : null } : null)
    }
  }
  return (
    <span className="relative flex max-w-md flex-wrap items-center gap-2">
      <button type="button" onClick={() => void start()} className="text-sm text-ink-2 hover:text-ink" data-testid="save-role-pack">
        Save as role pack
      </button>
      {offer ? (
        <span
          className="absolute right-0 top-full z-30 mt-1 block w-80 rounded-lg border border-line bg-panel p-3 text-xs text-ink-2 shadow-lg"
          data-testid="save-role-pack-skills"
        >
          <span className="block">Skills it can use that are not its own — tick the ones that belong to this role:</span>
          {offer.map((s) => (
            <label key={s.name} className="mt-1 flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={take.has(s.name)}
                onChange={() =>
                  setTake((t) => {
                    const n = new Set(t)
                    if (n.has(s.name)) n.delete(s.name)
                    else n.add(s.name)
                    return n
                  })
                }
              />
              <span>
                <span className="text-ink">{s.name}</span>{' '}
                <span className="text-ink-3">({s.from === 'personal' ? 'yours, on this machine' : 'its project folder'})</span>
                {s.description ? ` — ${s.description}` : ''}
              </span>
            </label>
          ))}
          <span className="mt-2 flex gap-3">
            <button
              type="button"
              onClick={() => void save()}
              className="text-ink underline underline-offset-2 hover:text-terracotta"
              data-testid="save-role-pack-download"
            >
              Download the pack
            </button>
            <button type="button" onClick={() => setOffer(null)} className="hover:text-ink">
              Cancel
            </button>
          </span>
        </span>
      ) : null}
      {said ? (
        <span className={`text-xs ${said.bad ? 'text-terracotta' : 'text-ink-2'}`} data-testid="save-role-pack-said">
          {said.text}
        </span>
      ) : null}
      {ask?.id ? (
        <button
          type="button"
          data-testid="save-role-pack-allow"
          onClick={() => {
            const id = ask.id!
            void api.vault.setPublic(id, true).then(
              () => save(),
              (e: unknown) => setSaid({ text: e instanceof Error ? e.message : String(e), bad: true }),
            )
          }}
          className="text-xs text-ink underline underline-offset-2 hover:text-terracotta"
        >
          {ask.name} is not a secret — mark it so in the Vault and export
        </button>
      ) : null}
    </span>
  )
}
