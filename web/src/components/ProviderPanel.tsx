// ProviderPanel.tsx — "Run on": the ONE editor of what a conversation runs
// on and how it answers — account, model and output style —, in chat and in
// console mode alike, on either engine (one clean picker: click and each
// provider's available models appear, add keys, pick models; the
// composer's model and account chips SHOW the value and open this
// panel — they are no second editor). Opened from the column's runs-on line
// (always; in its alert state the line carries the reason — lib/providers
// cannotRun), from those two chips and from '/model'.
//
// On top, «Agent default — <model · account>»: the row that clears this
// conversation's pins, so it follows its agent again. Then
// one list: every model this agent's engine can run, grouped by the
// provider that runs it — the engine's own login, each account or login,
// each key — with the current pick checked. Each group opens to its models
// (the picked provider's group is open; the others say how many they hold).
// A click on a model is the decision: a chat takes it on the next message
// (the panel closes); a console is one process and restarts with it, so the
// click selects and a bar asks for the restart in plain words. Adding a key
// or importing a login happens in the same list, below the groups: the new
// provider appears as a group with its models, nothing typed but the key.
//
// What a group offers is DATA, never a list in Silos: a key's models are
// what the gateway lists for it (re-read at boot and every 6 h), an OpenCode
// login's are OpenCode's catalogue for that provider, an account's are the
// Claude catalog (useModelOptions). Only what the engine can run appears
// (providersForHarness): a Claude account never on OpenCode.
//
// Geometry = KnowsDrawer's: anchored to the transcript's edge beside the
// column on lg (never a full cover), a bottom sheet below lg. Esc / ✕ / a
// click outside close it without applying (useModalBehavior).
import { useEffect, useRef, useState } from 'react'
import { Check, ExternalLink, TriangleAlert, X } from 'lucide-react'
import { useStore } from '../store'
import { rereadSentence } from '../lib/context'
import { api } from '../lib/api'
import { CHEAPESTINFERENCE_BASE_URL, CHEAPESTINFERENCE_KEYS_URL, gatewayHost, isCheapestProvider, providersForHarness } from '../lib/providers'
import { canonicalProviderId, runsOnLine } from '../lib/runs-on'
import type { ModelOption } from '../hooks/useModelOptions'
import { useModalBehavior, useDismissOnOutside } from './Modal'
import { useHarness } from '../lib/harnesses'
import { ClaudeSignIn } from './ClaudeSignIn'
import { RunOnList, type RunOnPick } from './RunOnList'
import { OutputStyleRow, styleNow } from './OutputStyleRow'
import { useOutputStyles } from '../hooks/useOutputStyles'
import type { AgentView, HarnessDescriptor, HarnessId, ProviderView } from '../lib/types'

const PANEL_CLASS =
  'fixed inset-x-0 bottom-0 z-20 flex max-h-[80vh] w-full flex-col border-t border-line bg-canvas shadow-xl outline-none lg:absolute lg:inset-x-auto lg:right-0 lg:top-0 lg:max-h-none lg:w-[min(480px,calc(100%-16rem))] lg:max-w-full lg:border-l lg:border-t-0'

type KeyProvider = Extract<ProviderView, { kind: 'anthropic-compatible' }>

export type { RunOnPick } from './RunOnList'

// The model a provider runs when the current one is not among its options:
// its first REAL model. The "Default / OpenCode's own" row ('') is only
// right for the engine's own login — on a key it means "no model", the
// silent swap this panel exists to prevent.
export function defaultModelFor(options: readonly ModelOption[], providerKind: ProviderView['kind'] | 'default'): string {
  const real = options.filter((o) => o.value !== '' && o.value !== 'default')
  if (providerKind === 'anthropic-compatible' || providerKind === 'harness-provider') return real[0]?.value ?? ''
  return options[0]?.value ?? ''
}

export function ProviderPanel({ agent }: { agent: AgentView }) {
  const panel = useStore((s) => s.providerPanel)
  const close = useStore((s) => s.closeProviderPanel)
  const providers = useStore((s) => s.providers)
  const loadProviders = useStore((s) => s.loadProviders)
  const loadOverview = useStore((s) => s.loadOverview)
  const applyPref = useStore((s) => s.applyConversationPref)
  const setTurn = useStore((s) => s.setTurnOverride)
  const catalog = useStore((s) => s.catalog)
  const selected = useStore((s) => s.selected)
  // a pick on a started conversation makes the engine read all of it again
  // (another account, model or style: no cache to reuse) — said with its
  // measured size, else not said
  const reread = useStore((s) =>
    s.selected && s.detail?.meta.folder === s.selected.folder && s.detail.meta.id === s.selected.id ? rereadSentence(s.detail.meta.contextTokens) : null,
  )
  const chatMode = useStore((s) => s.chatMode)
  // a NEW conversation already showing a console: claude was launched when
  // the view opened, with the picks of THAT moment. Nothing is persisted
  // yet (zero tokens, no transcript), so a later pick relaunches it — that
  // is the only way "a pick is what the conversation starts on" stays true.
  const newConsole = useStore((s) => s.selected === null && s.newChatOpen && s.pendingConsoleId !== null)
  const pinnedProvider = useStore((s) => (selected ? s.convPrefs.provider : s.pendingConvPrefs.provider))
  const pinnedModel = useStore((s) => (selected ? s.convPrefs.model : s.pendingConvPrefs.model))
  const pinnedStyle = useStore((s) => (selected ? s.convPrefs.outputStyle : s.pendingConvPrefs.outputStyle))
  // the conversation's engine, else the agent's, else the default engine
  const d = useHarness(useStore((s) => s.detail?.meta.harness) ?? agent.framework)
  const harness: HarnessId = d.id
  const ref = useRef<HTMLDivElement>(null)
  const open = panel !== null
  useModalBehavior(ref, close, { enabled: open })
  useDismissOnOutside(ref, close, { enabled: open, owner: 'run-on' })
  // the voice it answers in — only where the engine has output styles
  const styles = useOutputStyles(agent.id, open && d.caps.outputStyles, selected)

  // what the conversation runs on now — the checked row and the open group.
  // No pin = the agent's default (the row above the groups is checked); a
  // pin of either half checks the pair it makes with the agent's other half
  const pinned = pinnedProvider != null || pinnedModel != null
  const effectiveProvider = canonicalProviderId(pinnedProvider ?? agent.provider)
  const current: RunOnPick | null = pinned ? { provider: effectiveProvider, model: pinnedModel ?? agent.model ?? '' } : null
  // the group it runs on opens with the panel — unless that account is
  // logged out: opening one IS signing in, a gesture the owner makes, never
  // a side effect of looking
  const loggedOutNow = providers.some((p) => p.id === effectiveProvider && p.kind === 'claude-account' && !p.account.loggedIn)
  const [openGroup, setOpenGroup] = useState<string>(loggedOutNow ? '\u0000' : effectiveProvider)
  // console mode: a click selects, the bar restarts (a running turn ends)
  const [pending, setPending] = useState<RunOnPick | null>(null)
  const requestConsoleRestart = useStore((s) => s.requestConsoleRestart)
  const [makeDefault, setMakeDefault] = useState(false)
  // «Next message only» (a chat's one-shot, the chips' old «next turn
  // only»): a pick travels with the next send and clears itself
  const [turnOnly, setTurnOnly] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setOpenGroup(loggedOutNow ? '\u0000' : effectiveProvider)
    setPending(null)
    setMakeDefault(false)
    setTurnOnly(false)
    setNote(null)
    void loadProviders() // fresh lists each time: a key's models may have changed
    // seed once per opening — later picks are the user's
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null
  const usable = providersForHarness(providers, harness)
  const inConsole = chatMode === 'console' && selected !== null
  const scope = selected ? 'this conversation' : 'the new conversation'
  // the one-shot exists where turns are sent by Silos: a started chat
  const oneShot = selected !== null && !inConsole && turnOnly

  // the pin itself (+ the agent's default when asked); returns what the
  // server could do about a live console
  async function pin(pick: RunOnPick): Promise<'live' | 'restart' | 'next-turn' | 'pending' | 'failed'> {
    const provider = pick.provider === '' ? null : pick.provider
    const model = pick.model === '' ? null : pick.model
    if (oneShot) {
      setTurn({ provider, model })
      return 'next-turn'
    }
    const applied = await applyPref({ provider, model })
    if (makeDefault) {
      try {
        await api.agents.update(agent.id, { provider: provider ?? 'default', model: model ?? '' })
        loadOverview().catch(() => undefined) // the agents list catches up; a failed refresh is not a failed pick
      } catch (e) {
        setNote(e instanceof Error ? e.message : String(e))
        return 'failed'
      }
    }
    return applied
  }

  // a click is the decision. A chat takes it on the next message. A live
  // console takes it IN PLACE when it can ('live': Claude's /model, or
  // OpenCode's recent-models cycle verified on its screen); when the running
  // process cannot reach that model the server answers 'restart' and the
  // console relaunches with the pick right away (a restart is fine, as long
  // as the pick takes effect). The pin is
  // saved either way.
  async function choose(pick: RunOnPick): Promise<void> {
    setPending(pick)
    const applied = await pin(pick)
    if (applied === 'failed') return
    if (applied === 'restart' || (newConsole && chatMode === 'console')) requestConsoleRestart()
    close()
  }

  // «Agent default»: both pins cleared — at both levels, the one-shot too —
  // so the conversation follows whatever its agent runs on
  async function chooseAgentDefault(): Promise<void> {
    setTurn({ provider: null, model: null })
    const applied = await applyPref({ provider: null, model: null })
    if (applied === 'restart' || (newConsole && chatMode === 'console')) requestConsoleRestart()
    close()
  }

  // a style is read when the claude starts: a live console relaunches on it
  // (pushPin answers 'restart'), a chat takes it on the next message.
  // "Also make it the default" saves it as the agent's too.
  async function chooseStyle(style: string | null): Promise<void> {
    if (oneShot) {
      setTurn({ outputStyle: style })
      close()
      return
    }
    const applied = await applyPref({ outputStyle: style })
    if (makeDefault && style !== null) {
      try {
        await api.agents.update(agent.id, { outputStyle: style })
        loadOverview().catch(() => undefined)
      } catch (e) {
        setNote(e instanceof Error ? e.message : String(e))
        return
      }
    }
    if (applied === 'restart' || (newConsole && chatMode === 'console')) requestConsoleRestart()
    close()
  }

  const picked = pending ?? current
  // the agent's own pair, in the runs-on line's voice
  const agentDefault = runsOnLine({ agent, providers, catalog, harness })
  const keys = usable.filter((p): p is KeyProvider => p.kind === 'anthropic-compatible')

  return (
    <div ref={ref} role="dialog" aria-modal="false" aria-label="Run on" tabIndex={-1} className={PANEL_CLASS}>
      <header className="flex shrink-0 items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">Run on</p>
          <p className="truncate text-xs text-ink-2">
            {agent.name} · {d.label} · {scope}
          </p>
          {panel.reason ? (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs text-terracotta" data-testid="cannot-run-reason">
              <TriangleAlert size={13} aria-hidden="true" className="mt-px shrink-0" />
              <span className="min-w-0 break-words">{panel.reason}</span>
            </p>
          ) : null}
        </div>
        <button type="button" aria-label="Close run on" onClick={close} className="shrink-0 rounded-md p-1 text-ink-2 hover:bg-panel hover:text-ink">
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={picked === null}
          data-testid="run-on-agent-default"
          onClick={() => void chooseAgentDefault()}
          className="flex w-full items-center gap-2 border-b border-line px-4 py-2.5 text-left hover:bg-panel"
        >
          <span className={`w-3.5 shrink-0 ${picked === null ? 'text-terracotta' : 'invisible'}`} aria-hidden="true">
            <Check size={13} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-ink">Agent default</span>
            <span className="block truncate font-mono text-[11px] text-ink-2">{agentDefault}</span>
          </span>
          {picked === null ? <span className="shrink-0 text-[11px] text-terracotta">now</span> : null}
        </button>
        <RunOnList
          agent={agent}
          harness={harness}
          providers={providers}
          picked={picked}
          openGroup={openGroup}
          onToggleGroup={(id) => setOpenGroup((v) => (v === id ? '\u0000' : id))}
          onChoose={(pick) => void choose(pick)}
          onAccountChanged={() => void loadProviders()}
        />
        {d.caps.outputStyles ? (
          <OutputStyleRow
            agentName={agent.name}
            agentStyle={agent.outputStyle}
            styles={styles}
            now={styleNow(pinnedStyle, agent.outputStyle)}
            started={selected !== null}
            onChoose={(s) => void chooseStyle(s)}
          />
        ) : null}
        <div className={d.caps.outputStyles ? 'border-t border-line px-4 py-3' : 'px-4 py-3'}>
          {d.ui.loginImport ? (
            <ImportLogins
              d={d}
              imported={new Set(usable.flatMap((p) => (p.kind === 'harness-provider' || p.kind === 'harness-native' ? [p.providerId] : [])))}
              onImported={(id) => {
                void loadProviders()
                setOpenGroup(id)
              }}
            />
          ) : null}
          {d.providerKinds.includes('claude-account') ? (
            <AddClaudeAccount
              onReady={(id) => {
                void loadProviders()
                setOpenGroup(id)
              }}
              onCreated={() => void loadProviders()}
            />
          ) : null}
          <PasteKey
            existing={keys}
            onConnected={(id) => {
              void loadProviders()
              setOpenGroup(id)
            }}
          />
        </div>
      </div>

      <footer className="shrink-0 border-t border-line px-4 py-3">
        <p className="mb-2 text-[11px] text-ink-2">
          {inConsole
            ? 'A pick switches the console in place when it can; otherwise the console relaunches on it (a running turn ends).'
            : oneShot
              ? 'A pick rides the next message only — then this conversation is back on what it runs on now.'
              : selected
                ? 'A pick applies to the next message and stays.'
                : 'A pick is what the conversation starts on.'}
          {selected !== null && reread ? ` ${reread}` : ''}
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {selected !== null && !inConsole ? (
            <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-2">
              <input
                type="checkbox"
                checked={turnOnly}
                onChange={(e) => {
                  setTurnOnly(e.target.checked)
                  if (e.target.checked) setMakeDefault(false)
                }}
                className="h-3.5 w-3.5 accent-terracotta"
              />
              Next message only
            </label>
          ) : null}
          <label className={`flex items-center gap-2 text-xs text-ink-2 ${oneShot ? 'opacity-50' : 'cursor-pointer'}`}>
            <input
              type="checkbox"
              checked={makeDefault}
              disabled={oneShot}
              onChange={(e) => setMakeDefault(e.target.checked)}
              className="h-3.5 w-3.5 accent-terracotta"
            />
            Also make it {agent.name}&rsquo;s default
          </label>
        </div>
        {note ? <p className="mt-1 text-xs text-terracotta">{note}</p> : null}
      </footer>
    </div>
  )
}

// The engine's logins not yet imported (ids only reach the browser): one
// click copies that key into a Silos provider server-side; it then appears as
// a group. Shown only where the descriptor names a login import
// (ui.loginImport), and fetched from the routes it names.
function ImportLogins({ d, imported, onImported }: { d: HarnessDescriptor; imported: Set<string>; onImported: (id: string) => void }) {
  const engine = d.label
  const listRoute = d.ui.loginImport?.list
  const [ids, setIds] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    Promise.resolve(api.providers.engineLogins(d))
      .then((v) => {
        if (!cancelled) setIds(v ?? [])
      })
      .catch(() => {
        if (!cancelled) setIds([])
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the descriptor's route is the identity
  }, [listRoute])
  const pending = (ids ?? []).filter((id) => !imported.has(id))
  async function importOne(id: string): Promise<void> {
    setBusy(id)
    setError(null)
    try {
      const p = await api.providers.importLogin(d, id, id)
      onImported(p.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  if (pending.length === 0 && !error) return null
  return (
    <div className="mb-3">
      <ul className="flex flex-col gap-1">
        {pending.map((id) => (
          <li key={id} className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-line px-3 py-1.5">
            <span className="min-w-0 truncate font-mono text-xs text-ink">
              {id} <span className="text-ink-2">{`· login ${engine} holds`}</span>
            </span>
            <button
              type="button"
              aria-label={`import ${id}`}
              disabled={busy !== null}
              onClick={() => void importOne(id)}
              className="shrink-0 rounded-lg border border-line px-2 py-0.5 text-xs font-medium text-ink hover:border-ink-2 disabled:opacity-50"
            >
              {busy === id ? 'Importing…' : 'Import'}
            </button>
          </li>
        ))}
      </ul>
      {error ? <p className="mt-1 text-xs text-terracotta">{error}</p> : null}
    </div>
  )
}

// Another Claude subscription: a name, then Claude's own sign-in right here
// (ClaudeSignIn). The account exists from the name on — a sign-in left
// halfway shows up as a "not logged in" group that signs in when opened.
function AddClaudeAccount({ onCreated, onReady }: { onCreated: () => void; onReady: (providerId: string) => void }) {
  const [openBox, setOpenBox] = useState(false)
  const [name, setName] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const slug = name.trim().toLowerCase()

  async function create(): Promise<void> {
    setError(null)
    try {
      const r = await api.accounts.create(slug)
      setCreated(r.name)
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  function reset(): void {
    setOpenBox(false)
    setName('')
    setCreated(null)
    setError(null)
  }

  if (!openBox) {
    return (
      <button
        type="button"
        onClick={() => setOpenBox(true)}
        className="mb-2 flex w-full items-center justify-between rounded-lg border border-dashed border-line px-3 py-2 text-left text-sm text-ink-2 hover:border-ink-2 hover:text-ink"
      >
        <span>Add a Claude account</span>
        <span className="font-mono text-[11px] text-ink-3">another subscription, signed in with Claude</span>
      </button>
    )
  }
  return (
    <div className="mb-2 flex flex-col gap-2 rounded-lg border border-dashed border-line p-3">
      {created === null ? (
        <>
          <div className="flex items-center gap-2">
            <input
              type="text"
              aria-label="account name"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && slug !== '') void create()
              }}
              placeholder="a name for it: work, personal…"
              className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-1.5 text-xs outline-none focus:border-terracotta"
            />
            <button
              type="button"
              onClick={() => void create()}
              disabled={slug === ''}
              className="shrink-0 rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-canvas hover:opacity-90 disabled:opacity-50"
            >
              Sign in
            </button>
            <button type="button" onClick={reset} className="shrink-0 text-xs text-ink-2 hover:text-ink">
              Cancel
            </button>
          </div>
          {error ? <p className="text-xs text-terracotta">{error}</p> : null}
        </>
      ) : (
        <ClaudeSignIn
          account={created}
          onSignedIn={() => {
            const id = `account:${created}`
            reset()
            onReady(id)
          }}
          onCancel={reset}
        />
      )}
    </div>
  )
}

// Add a key. Folded to one line until asked; endpoint = cheapestinference
// unless "other endpoint" is opened. Connect = ONE server call that verifies
// the key against the endpoint and stores it only if it works (the same key
// again = the same row), already named after the models it reaches — the
// new provider then appears as a group with its models. A refused key leaves
// nothing behind and shows the provider's words. The key never comes back
// from the server whole (masked), and is never echoed.
function PasteKey({ existing, onConnected }: { existing: KeyProvider[]; onConnected: (id: string, models: string[]) => void }) {
  const [openBox, setOpenBox] = useState(false)
  const [key, setKey] = useState('')
  const [other, setOther] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const endpoint = other ? baseUrl.trim() : CHEAPESTINFERENCE_BASE_URL
  const hasCheapest = existing.some(isCheapestProvider)

  async function connect(): Promise<void> {
    setError(null)
    setBusy('Verifying…')
    try {
      const { provider, models } = await api.providers.connect({
        label: endpoint === CHEAPESTINFERENCE_BASE_URL ? 'cheapestinference' : gatewayHost(endpoint),
        baseUrl: endpoint,
        apiKey: key.trim(),
      })
      setKey('')
      setOpenBox(false)
      onConnected(provider.id, models ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  if (!openBox) {
    return (
      <button
        type="button"
        onClick={() => setOpenBox(true)}
        className="flex w-full items-center justify-between rounded-lg border border-dashed border-line px-3 py-2 text-left text-sm text-ink-2 hover:border-ink-2 hover:text-ink"
      >
        <span>Add a key</span>
        <span className="font-mono text-[11px] text-ink-3">cheapestinference, or any Anthropic-compatible endpoint</span>
      </button>
    )
  }
  const input = 'rounded-lg border border-line bg-canvas px-3 py-1.5 outline-none focus:border-terracotta'
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-line p-3">
      <div className="flex items-center justify-between gap-2 text-xs text-ink-2">
        {other ? (
          <input
            type="text"
            aria-label="base url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://…/anthropic"
            className={`${input} min-w-0 flex-1 font-mono text-xs`}
          />
        ) : (
          <span>
            <span className="font-mono text-ink">
              cheapest<span className="text-terracotta">inference</span>
            </span>
            {' · '}
            <a
              href={CHEAPESTINFERENCE_KEYS_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 font-medium text-terracotta hover:opacity-80"
            >
              {hasCheapest ? 'your keys' : 'get a key'}
              <ExternalLink size={10} aria-hidden="true" />
            </a>
          </span>
        )}
        <button type="button" onClick={() => setOther((v) => !v)} className="shrink-0 font-medium text-ink-2 hover:text-ink">
          {other ? 'cheapestinference' : 'other endpoint'}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          aria-label="api key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={hasCheapest && !other ? 'paste another key (sk-…)' : 'paste the key (sk-…)'}
          className={`${input} min-w-0 flex-1 font-mono text-xs`}
        />
        <button
          type="button"
          onClick={() => void connect()}
          disabled={busy !== null || key.trim() === '' || (other && !/^https?:\/\//.test(baseUrl.trim()))}
          className="shrink-0 rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-canvas hover:opacity-90 disabled:opacity-50"
        >
          {busy ?? 'Connect'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpenBox(false)
            setError(null)
          }}
          className="shrink-0 text-xs text-ink-2 hover:text-ink"
        >
          Cancel
        </button>
      </div>
      {error ? <p className="text-xs text-terracotta">{error}</p> : null}
    </div>
  )
}
