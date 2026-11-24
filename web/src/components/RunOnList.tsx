// RunOnList.tsx — THE list of what an agent's engine can run on: every model,
// grouped by the provider that runs it (the engine's own login, each account
// or login, each key), the current pick checked, each group opening to its
// models (a logged-out account opens to Claude's own sign-in). One list for
// every place that decides what something runs on — a conversation's Run on
// panel (ProviderPanel.tsx) and an automation's editor (the model, not
// just the agent, systematically) — so the choice reads and behaves
// the same wherever it is made. What a group offers is DATA (useModelOptions):
// a key's learned list, OpenCode's catalogue, the Claude catalog.
import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useStore } from '../store'
import { bareGatewayModel, providerNeedsKey, providersForHarness } from '../lib/providers'
import { canonicalProviderId } from '../lib/runs-on'
import { relTime } from '../lib/rel-time'
import { useModelOptions, type ModelOption } from '../hooks/useModelOptions'
import { useHarness } from '../lib/harnesses'
import { ClaudeSignIn } from './ClaudeSignIn'
import type { AgentView, HarnessId, ProviderView } from '../lib/types'

/** A pick: the provider (a real id — 'default' is the machine's Claude
 *  account, or the engine's own login; '' only in an old saved pair, read as
 *  the agent's own account) and the model ('' = that provider's default). */
export interface RunOnPick {
  provider: string
  model: string
}

// the groups an engine offers: its own login (or the machine's Claude
// account) first, then every other provider it can run. Every group is a
// REAL provider: the agent's own default is not a group but the row
// the caller puts above the list — the machine's account titled as itself
// once cleared the pin and ran on the agent's account instead.
function groupsOf(usable: readonly ProviderView[], ownLogin: boolean): Array<{ id: string; provider: ProviderView | null }> {
  return [
    ...(ownLogin
      ? [{ id: 'default', provider: null }]
      : usable.filter((p) => p.kind === 'claude-account' && p.id === 'default').map((p) => ({ id: 'default', provider: p }))),
    ...usable.filter((p) => !(p.kind === 'claude-account' && p.id === 'default')).map((p) => ({ id: p.id, provider: p })),
  ]
}

export function RunOnList({
  agent,
  harness,
  providers,
  picked,
  openGroup,
  onToggleGroup,
  onChoose,
  onAccountChanged,
}: {
  agent: AgentView
  harness: HarnessId
  providers: ProviderView[]
  picked: RunOnPick | null
  openGroup: string
  onToggleGroup: (id: string) => void
  onChoose: (pick: RunOnPick) => void
  onAccountChanged: () => void
}) {
  const d = useHarness(harness)
  const groups = groupsOf(providersForHarness(providers, harness), d.ui.ownLogin)
  return (
    <ul className="divide-y divide-line">
      {groups.map((g) => (
        <ProviderGroup
          key={g.id}
          id={g.id}
          provider={g.provider}
          harness={harness}
          agent={agent}
          providers={providers}
          picked={picked}
          open={openGroup === g.id}
          onToggle={() => onToggleGroup(g.id)}
          onChoose={onChoose}
          onAccountChanged={onAccountChanged}
        />
      ))}
    </ul>
  )
}

// One provider and the models it runs. Its own useModelOptions call: a key's
// learned list, OpenCode's catalogue for the provider, the Claude catalog.
function ProviderGroup({
  id,
  provider,
  harness,
  agent,
  providers,
  picked,
  open,
  onToggle,
  onChoose,
  onAccountChanged,
}: {
  id: string
  provider: ProviderView | null
  harness: HarnessId
  agent: AgentView
  providers: readonly ProviderView[]
  picked: RunOnPick | null
  open: boolean
  onToggle: () => void
  onChoose: (pick: RunOnPick) => void
  onAccountChanged: () => void
}) {
  const catalog = useStore((s) => s.catalog)
  const claudeOptions: ModelOption[] = catalog.length > 0 ? catalog.map((m) => ({ value: m.value, label: m.displayName })) : [{ value: '', label: 'Default' }]
  // an old saved pair without a provider runs on the agent's own account
  const isPicked = picked !== null && canonicalProviderId(picked.provider === '' ? agent.provider : picked.provider) === id
  const pick = useModelOptions(harness, id, isPicked ? picked.model : '', claudeOptions, providers)
  const [typed, setTyped] = useState('')
  const d = useHarness(harness)
  // model ids are `provider/model`, shown raw (OpenCode); a catalogue shows names
  const rawIds = d.ui.models === 'provider-model'
  const kind: ProviderView['kind'] | 'default' = provider?.kind ?? 'default'
  const needsKey = provider !== null && providerNeedsKey(provider)
  const loggedOut = provider?.kind === 'claude-account' && !provider.account.loggedIn
  // a logged-out account is not a dead row: opening it IS signing in
  // (Claude's own sign-in, in a terminal inside the row — ClaudeSignIn)
  const unusable = needsKey
  const signIn = open && loggedOut && provider?.kind === 'claude-account'

  const title = provider === null ? `${d.label}’s own login` : provider.label
  const meta = (): string => {
    if (provider === null) return `whatever ${d.label} uses by default`
    // the way to a key is in this same list, below the groups
    if (needsKey) return 'key needed — add it below'
    if (loggedOut) return 'not logged in · sign in with Claude'
    if (provider.kind === 'claude-account') return provider.account.email ?? provider.account.name
    if (provider.kind === 'harness-native') return `${provider.providerId} · login ${d.label} holds`
    if (provider.kind === 'harness-provider') return `${provider.providerId} · ${provider.apiKey}`
    const when = provider.modelsAt ? ` · listed ${relTime(Date.parse(provider.modelsAt))}` : ''
    return `${provider.apiKey}${when}`
  }
  // the rows: the provider's own list (never the current value appended for
  // selectability — that is for forms); a gateway with no list takes a typed id
  const rows = pick.options.filter((o) => pick.listed.includes(o.value))
  const noList = pick.gateway !== null && pick.listed.length === 0
  // an engine with no model list at all (ui.models 'none'): it picks its own
  // model, so an empty list is the answer, never "still reading"
  const engineList = !(d.ui.models === 'none' && rows.length === 0)
  const count = noList ? 'type a model id' : !engineList ? 'no model list' : rows.length === 1 ? '1 model' : `${rows.length} models`
  // a Claude account runs any model id its catalog does not list yet (a new
  // release, a dated id), and an engine with no list at all takes one too:
  // typed under the list, as the gateway's is
  const typedId = (d.ui.models === 'catalog' && (provider === null || provider.kind === 'claude-account')) || (d.ui.models === 'none' && provider === null)
  // …and a typed id in use reads as its own checked row
  const typedNow =
    typedId && isPicked && picked !== null && picked.model !== '' && picked.model !== 'default' && !rows.some((o) => o.value === picked.model)
      ? picked.model
      : null

  const typedRow = typedId ? (
    <li className="flex items-center gap-2 pl-[30px] pr-2 pt-1">
      <input
        type="text"
        aria-label="another model id"
        value={typed}
        onChange={(e) => setTyped(e.target.value.trim())}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && typed !== '') {
            e.preventDefault()
            onChoose({ provider: id, model: typed })
          }
        }}
        placeholder="another model id…"
        className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1 font-mono text-[11px] outline-none placeholder:text-ink-3 focus:border-terracotta"
      />
      {typed !== '' ? (
        <button
          type="button"
          onClick={() => onChoose({ provider: id, model: typed })}
          className="shrink-0 rounded-md bg-ink px-2.5 py-1 text-[11px] font-medium text-canvas hover:opacity-90"
        >
          Use
        </button>
      ) : null}
    </li>
  ) : null

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${title} — ${count}`}
        onClick={onToggle}
        disabled={unusable}
        className={`flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-panel disabled:cursor-not-allowed disabled:opacity-60 ${open ? 'bg-panel/60' : ''}`}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm text-ink">{title}</span>
            {isPicked ? <span className="shrink-0 text-[11px] text-terracotta">now</span> : null}
          </span>
          <span className="block truncate font-mono text-[11px] text-ink-2">{meta()}</span>
        </span>
        {loggedOut ? (
          <span className="shrink-0 text-[11px] font-medium text-terracotta">{open ? '' : 'Sign in'}</span>
        ) : (
          <span className="shrink-0 text-[11px] text-ink-3">{unusable ? '' : count}</span>
        )}
        <ChevronDown size={13} aria-hidden="true" className={`shrink-0 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {signIn ? (
        <div className="px-4 pb-3 pt-1">
          <ClaudeSignIn account={provider.account.name} onSignedIn={onAccountChanged} onCancel={onToggle} />
        </div>
      ) : open && !unusable ? (
        <ul className="px-4 pb-3">
          {noList ? (
            <li className="flex items-center gap-2 py-1">
              <input
                type="text"
                aria-label="model id"
                value={typed}
                onChange={(e) => setTyped(e.target.value.trim())}
                placeholder="model id as the gateway names it"
                className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-1.5 font-mono text-xs outline-none focus:border-terracotta"
              />
              {/* a gateway's model is stored bare (the launch adds silos-<id>/) */}
              <button
                type="button"
                disabled={typed === ''}
                onClick={() => onChoose({ provider: id, model: pick.gateway ? bareGatewayModel(pick.gateway, typed) : typed })}
                className="shrink-0 rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-canvas hover:opacity-90 disabled:opacity-50"
              >
                Use
              </button>
            </li>
          ) : !engineList ? (
            <>
              <li className="py-1 text-xs text-ink-2">No model list — {d.label} picks</li>
              {typedRow}
            </>
          ) : rows.length === 0 ? (
            <li className="py-1 text-xs text-ink-2">Reading its models…</li>
          ) : (
            <>
              {rows.map((o) => {
                const checked = isPicked && picked?.model === o.value
                const isDefaultRow = o.value === '' || o.value === 'default'
                // the engine's own login keeps its default row; a key has no "no model"
                if (isDefaultRow && (kind === 'anthropic-compatible' || kind === 'harness-provider')) return null
                return (
                  <li key={o.value || '__default__'}>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={checked}
                      data-pick="model"
                      data-provider={id}
                      onClick={() => onChoose({ provider: id, model: o.value })}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-panel ${checked ? 'text-ink' : 'text-ink-2'}`}
                    >
                      <span className={`w-3.5 shrink-0 ${checked ? 'text-terracotta' : 'invisible'}`} aria-hidden="true">
                        <Check size={13} />
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                        {rawIds && provider?.kind !== 'anthropic-compatible' ? o.value || o.label : o.label}
                      </span>
                      {isDefaultRow ? <span className="shrink-0 text-[11px] text-ink-3">default</span> : null}
                    </button>
                  </li>
                )
              })}
              {typedNow ? (
                <li>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked
                    data-pick="model"
                    data-provider={id}
                    onClick={() => onChoose({ provider: id, model: typedNow })}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-panel"
                  >
                    <span className="w-3.5 shrink-0 text-terracotta" aria-hidden="true">
                      <Check size={13} />
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{typedNow}</span>
                    <span className="shrink-0 text-[11px] text-ink-3">typed</span>
                  </button>
                </li>
              ) : null}
              {typedRow}
            </>
          )}
        </ul>
      ) : null}
    </li>
  )
}
