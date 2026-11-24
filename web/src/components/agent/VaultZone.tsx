// VaultZone.tsx — the vault from THIS agent's side. Extracted from
// AgentPage.tsx; it is the agent page's Secrets tab. A secret that is this
// agent's alone is deleted here; every other row (shared with other agents,
// its project's, everyone's) is the Vault's to manage — «in the Vault ›»
// opens the Vault on that entry (one house, a pointer elsewhere).
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import type { AgentView, VaultEntry } from '../../lib/types'
import { KeyRound, Signature } from 'lucide-react'
import { effectiveVaultFor, type EffectiveVaultVar } from '../../lib/vault-view'
import { ConfirmButton } from '../ConfirmButton'
import { ScopePill, scopeWords } from '../knows/ScopePill'
import { joinNames } from '../../lib/vault-page'
import { basename } from '../../lib/routes'
import { MODE_DELIVERED, MODE_SIGNED, SignedCallsFold, egressUrl, hostOf } from '../VaultSigning'

export function AgentVaultZone({ agent }: { agent: AgentView }) {
  const changePage = useStore((s) => s.changePage)
  const agents = useStore((s) => s.agents)
  const [entries, setEntries] = useState<VaultEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  async function load(): Promise<void> {
    try {
      setEntries(await api.vault.list())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the vault')
    }
  }
  useEffect(() => {
    setName('')
    setValue('')
    void load()
  }, [agent.id])

  const effective: EffectiveVaultVar[] = useMemo(() => effectiveVaultFor(entries ?? [], agent.id, agent.folder), [entries, agent.id, agent.folder])

  async function add(): Promise<void> {
    if (!name.trim() || !value || saving) return
    setSaving(true)
    try {
      await api.vault.create({ name: name.trim(), value, scope: { type: 'agents', agentIds: [agent.id] } })
      setName('')
      setValue('')
      setError(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the secret')
    } finally {
      setSaving(false)
    }
  }

  async function deleteEntry(id: string): Promise<void> {
    try {
      await api.vault.remove(id)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the secret')
    }
  }

  // a shared visibility list reads as what it is — deleting it would take
  // the secret from every agent on the list, so the badge says so. The pill
  // speaks the ONE scope vocabulary: who sees it,
  // never the raw source word.
  const badgeOf = (v: EffectiveVaultVar): string =>
    v.source === 'agent' && v.entry.scope.type === 'agents' && v.entry.scope.agentIds.length > 1
      ? `Agents · ${joinNames(v.entry.scope.agentIds.map((id) => agents.find((a) => a.id === id)?.name ?? id))}`
      : v.source === 'agent'
        ? scopeWords('agent', agent.name)
        : scopeWords(v.source, agent.name, agent.folder ? basename(agent.folder) : null)

  return (
    <div className="rounded-lg border border-line">
      {effective.length === 0 && entries !== null ? (
        <p className="px-3 pt-3 text-xs text-ink-2">No secrets reach this agent yet — add one below, or share one with it in the Vault.</p>
      ) : (
        <ul className="divide-y divide-line/60">
          {effective.some((v) => v.entry.binding) ? (
            // two classes on one list: the legend says each once
            <li className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 text-[10.5px] text-ink-3">
              <span className="inline-flex items-center gap-1">
                <KeyRound size={10} aria-hidden="true" />
                {effective.filter((v) => !v.entry.binding).length} {MODE_DELIVERED.toLowerCase()}
              </span>
              <span className="inline-flex items-center gap-1">
                <Signature size={11} aria-hidden="true" />
                {effective.filter((v) => v.entry.binding).length} signed by Silos — never in its hands
              </span>
            </li>
          ) : null}
          {effective.map((v) => (
            <li key={v.name} className="px-3 py-1.5 text-xs">
              <div className="flex items-center gap-2">
                {v.entry.binding ? (
                  <Signature size={12} aria-label={MODE_SIGNED} className="shrink-0 text-ink-2" />
                ) : (
                  <KeyRound size={11} aria-label={MODE_DELIVERED} className="shrink-0 text-ink-2/70" />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-ink" title={v.name}>
                  {v.name}
                </span>
                <span className="shrink-0 font-mono text-ink-2">{v.entry.value}</span>
                {v.entry.createdBy === agent.id ? (
                  <span className="shrink-0 text-[10px] text-ink-3" title={`${agent.name} stored this one itself`}>
                    by {agent.name}
                  </span>
                ) : null}
                <span
                  className="shrink-0"
                  title={
                    v.source === 'project'
                      ? v.entry.scope.type === 'folder'
                        ? v.entry.scope.folder
                        : undefined
                      : v.entry.scope.type === 'agents' && v.entry.scope.agentIds.length > 1
                        ? `visible to ${v.entry.scope.agentIds.join(', ')}`
                        : undefined
                  }
                >
                  <ScopePill scope={v.source} label={badgeOf(v)} />
                </span>
                {v.overrides.length > 0 ? (
                  // the shadowed values named in the same scope vocabulary as the pill
                  <span
                    className="shrink-0 text-[10px] text-ink-2"
                    title={`this value (${badgeOf(v)}) shadows the one set for ${v.overrides.map((o) => scopeWords(o, agent.name, agent.folder ? basename(agent.folder) : null)).join(' and ')}`}
                  >
                    overrides {v.overrides.map((o) => scopeWords(o, agent.name, agent.folder ? basename(agent.folder) : null)).join(' · ')}
                  </span>
                ) : null}
                {v.source === 'agent' && v.entry.scope.type === 'agents' && v.entry.scope.agentIds.length === 1 ? (
                  // only a secret that is THIS agent's alone is deletable here —
                  // a shared one is managed on the Vault page, never taken
                  // from the other agents as a side effect of this page.
                  <ConfirmButton
                    onConfirm={() => void deleteEntry(v.entry.id)}
                    ariaLabel={`delete secret ${v.entry.name}`}
                    confirmLabel="sure?"
                    className="shrink-0 rounded px-1 py-0.5 text-[10px] text-ink-2 hover:text-terracotta"
                    armedClassName="shrink-0 rounded bg-terracotta px-1 py-0.5 text-[10px] text-on-terracotta"
                  >
                    delete
                  </ConfirmButton>
                ) : (
                  <button
                    type="button"
                    data-testid="secret-in-vault"
                    onClick={() => changePage({ kind: 'vault', entry: v.entry.id })}
                    title={`${v.name} is managed in the Vault — its visibility, value and delete`}
                    className="shrink-0 rounded px-1 py-0.5 text-[10px] text-ink-2 hover:text-terracotta"
                  >
                    in the Vault ›
                  </button>
                )}
              </div>
              {v.entry.binding ? (
                // signed: the agent never finds it in its env — this is the
                // door it uses instead, and what the call must carry
                <div className="ml-[19px] mt-1 space-y-0.5 text-[10.5px] leading-snug" data-testid="secret-signed">
                  <div className="text-ink-2">
                    {MODE_SIGNED} for <span className="font-mono text-ink-3">{hostOf(v.entry.binding.baseUrl)}</span>
                  </div>
                  <div className="break-all font-mono text-ink">{egressUrl(v.entry.name)}</div>
                  <div className="text-ink-3">
                    with <span className="font-mono">Authorization: Bearer $SILOS_AGENT_TOKEN</span> +{' '}
                    <span className="font-mono">x-silos-turn: $SILOS_TURN</span>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {effective.some((v) => v.entry.binding) ? (
        <div className="border-t border-line/60 px-3 py-2">
          <SignedCallsFold filter={{ agent: agent.id }} showEntry nameOf={(id) => (id === null ? 'you' : (agents.find((a) => a.id === id)?.name ?? id))} />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line/60 px-3 py-2">
        <input
          type="text"
          aria-label="secret name"
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
          placeholder="STRIPE_KEY"
          className="w-28 shrink-0 rounded border border-line bg-canvas px-1.5 py-1 font-mono text-[11px] outline-none focus:border-terracotta"
        />
        <input
          type="password"
          aria-label="secret value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
          placeholder="value"
          className="min-w-0 flex-1 rounded border border-line bg-canvas px-1.5 py-1 font-mono text-[11px] outline-none focus:border-terracotta"
        />
        <button
          type="button"
          onClick={() => void add()}
          disabled={!name.trim() || !value || saving}
          className="shrink-0 rounded bg-terracotta px-2 py-1 text-[11px] font-medium text-on-terracotta disabled:opacity-50"
        >
          Add for {agent.name}
        </button>
        <button type="button" onClick={() => changePage({ kind: 'vault' })} className="shrink-0 text-[11px] text-ink-2 hover:text-terracotta">
          Manage in the Vault ›
        </button>
      </div>
      {error ? <p className="px-3 pb-2 text-xs text-terracotta">{error}</p> : null}
    </div>
  )
}

// Threads — the agent's conversations in two shapes of the same thing: List
// (the usual session list) and Board (the state-based board, filtered to
// this agent). The toggle is UI-session-only (useState) — a gesture, not a
// setting to persist.
