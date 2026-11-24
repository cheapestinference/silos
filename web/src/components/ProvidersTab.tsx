// ProvidersTab.tsx — Providers v1: Settings › Accounts & providers. The
// install's unattended provider, then three tiers, in order: first Claude
// accounts — this machine's own login included, its one house — (identity, login via terminal — NEVER a
// claude.ai login button in the product), then key-based providers
// (cheapestinference as a one-step widget + custom BYOK), then one section
// per engine that runs its own providers (descriptor providerKinds has
// 'harness-provider' — today OpenCode: import from OpenCode's auth.json,
// own key or OpenCode's login). Every row with config can "Copy config" (no key). Every key
// travels whole only toward the server; here it's only ever seen masked
// (sk-…last4). Verification errors come from the server and are shown as-is.
import { EngineSignIn } from './EngineSignIn'
import { Fragment, useCallback, useEffect, useState } from 'react'
import { Check, Copy, ExternalLink, Plus, RefreshCw } from 'lucide-react'
import { ClaudeSignIn } from './ClaudeSignIn'
import { api } from '../lib/api'
import type { ClaudeAccountView, HarnessDescriptor, MachineHeads, PlatformSettingsView, ProviderView, RateWindow, StartingSetClass } from '../lib/types'
import { WhereItLoads } from './knows/WhereItLoads'
import { canonicalProviderId, providerLabel } from '../lib/runs-on'
import { useHarnessDescriptors } from '../lib/harnesses'
import { limitLabel } from '../lib/rate-limits'
import { CHEAPESTINFERENCE_BASE_URL, CHEAPESTINFERENCE_KEYS_URL, isCheapestProvider } from '../lib/providers'
import { relTime } from '../lib/rel-time'
import { ConfirmButton } from './ConfirmButton'
import { classOffWords, classOn, classOnWords, classTitle, classWhat } from '../lib/starting-set'

// the proxy's baseUrl's single source of truth: lives in lib/providers.ts
// (shared with the rate-limit banner's nudge). Re-exported for this
// module's importers (an EXACT comparison — 'cheapestinference.com.evil.io' doesn't pass).
export { CHEAPESTINFERENCE_BASE_URL, CHEAPESTINFERENCE_KEYS_URL }

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// the 5h window bar — only when there IS data (the resident/ChatService
// capture it from a real turn's rate_limit_event); with no data, an honest
// "no usage data yet" instead of a bar invented at 0%.
function WindowBar({ window: w }: { window: RateWindow | null | undefined }) {
  if (!w || typeof w.utilization !== 'number') {
    return <p className="font-mono text-[11px] text-ink-2">5h window · no usage data yet</p>
  }
  const pct = Math.max(0, Math.min(100, Math.round(w.utilization)))
  const hot = pct >= 80 || w.status === 'rejected'
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between font-mono text-[11px] text-ink-2">
        <span>
          {limitLabel(w.kind, w.resetsAt)} · {pct}%
        </span>
        {w.resetsAt ? <span>resets {timeOf(w.resetsAt)}</span> : null}
      </div>
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-canvas"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="5h window usage"
      >
        <div className={`h-full rounded-full ${hot ? 'bg-terracotta' : 'bg-ink/50'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function StatusDot({ active, label }: { active: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5 font-mono text-[11px] text-ink-2">
      <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${active ? 'bg-terracotta' : 'border border-ink-2'}`} />
      {label}
    </span>
  )
}

function AccountCard({ account, onRefresh }: { account: ClaudeAccountView; onRefresh: () => void }) {
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const identity = account.email

  async function verify(): Promise<void> {
    setVerifying(true)
    setError(null)
    try {
      await api.accounts.verify(account.name)
      onRefresh()
    } catch (e) {
      // surface the failure instead of a silently-stopped spinner + an
      // unhandled rejection — same as the provider verifies in this file.
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-3 rounded-xl border border-line bg-panel p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-terracotta-soft font-display text-sm text-terracotta">
          {(identity ?? account.name).slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{account.name === 'default' ? 'This machine' : account.name}</p>
          <p className="truncate text-xs text-ink-2">{account.email ?? 'no email on record'}</p>
        </div>
        <StatusDot active={account.loggedIn} label={account.loggedIn ? 'logged in' : 'not logged in'} />
      </div>
      {account.plan ? <p className="font-mono text-[11px] text-ink-2">{account.plan}</p> : null}
      {account.shared === false ? (
        <p className="text-[12px] leading-snug text-amber-700 dark:text-amber-400">
          This account keeps its own transcripts — conversations run on it stay out of the sidebar. Move its projects/ into ~/.claude/projects and Silos will
          link it.
        </p>
      ) : null}
      <WindowBar window={account.window} />
      {account.configDir ? (
        <div className="flex items-center justify-between gap-2">
          <p className="truncate font-mono text-[10.5px] text-ink-2" title={account.configDir}>
            {account.configDir}
          </p>
          {!account.loggedIn && !signingIn ? (
            <button
              type="button"
              onClick={() => setSigningIn(true)}
              className="shrink-0 rounded-lg bg-ink px-2 py-1 text-xs font-medium text-canvas hover:opacity-90"
            >
              Sign in
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void verify()}
            disabled={verifying}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs font-medium text-ink hover:border-ink-2 disabled:opacity-50"
          >
            <RefreshCw size={11} aria-hidden="true" className={verifying ? 'animate-spin' : ''} />
            Verify
          </button>
        </div>
      ) : (
        <p className="font-mono text-[10.5px] text-ink-2">uses the claude login of this machine</p>
      )}
      {signingIn && account.configDir ? (
        <ClaudeSignIn
          account={account.name}
          onSignedIn={() => {
            setSigningIn(false)
            onRefresh()
          }}
          onCancel={() => setSigningIn(false)}
        />
      ) : null}
      {error ? <p className="text-xs text-terracotta">{error}</p> : null}
    </div>
  )
}

// "Connect another account": the server creates the CLAUDE_CONFIG_DIR; the
// sign-in is Claude's own, in a terminal right here (ClaudeSignIn) or with
// the returned command in the owner's terminal — never a login of Silos's.
export function ConnectAccount({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [command, setCommand] = useState<string | null>(null)
  const [newAccount, setNewAccount] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [verification, setVerification] = useState<string | null>(null)
  const [ownTerminal, setOwnTerminal] = useState(false)
  // Cancel: the account stays (its card offers Sign in); the box folds
  function reset(): void {
    setOpen(false)
    setName('')
    setCommand(null)
    setNewAccount(null)
    setVerification(null)
    setOwnTerminal(false)
  }

  async function create(): Promise<void> {
    setError(null)
    try {
      const r = await api.accounts.create(name.trim())
      setCommand(r.command)
      setNewAccount(r.name)
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function copy(): Promise<void> {
    if (!command) return
    await navigator.clipboard.writeText(command).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  async function verify(): Promise<void> {
    if (!newAccount) return
    setVerification(null)
    try {
      const account = await api.accounts.verify(newAccount)
      setVerification(account.loggedIn ? `Logged in${account.email ? ` as ${account.email}` : ''}.` : 'Not logged in yet — run the command first.')
      onCreated()
    } catch (e) {
      setVerification(e instanceof Error ? e.message : String(e))
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full max-w-sm items-center justify-center gap-2 rounded-xl border border-dashed border-line p-4 text-sm text-ink-2 hover:border-ink-2 hover:text-ink"
      >
        <Plus size={14} aria-hidden="true" />
        Connect another account
      </button>
    )
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-3 rounded-xl border border-dashed border-line p-4">
      <p className="text-sm font-medium text-ink">Connect another account</p>
      {command === null ? (
        <>
          <div className="flex items-center gap-2">
            <input
              type="text"
              aria-label="account name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="work, personal…"
              className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm outline-none focus:border-terracotta"
            />
            <button
              type="button"
              onClick={() => void create()}
              disabled={name.trim() === ''}
              className="shrink-0 rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-canvas hover:opacity-90 disabled:opacity-50"
            >
              Create
            </button>
          </div>
          {error ? <p className="text-xs text-terracotta">{error}</p> : null}
        </>
      ) : (
        <>
          {verification?.startsWith('Logged in') ? (
            <p className="flex items-center gap-2 text-sm text-ink" role="status">
              <Check size={14} aria-hidden="true" className="text-terracotta" />
              {verification}
            </p>
          ) : !ownTerminal && newAccount ? (
            <>
              <ClaudeSignIn
                account={newAccount}
                onSignedIn={(a) => {
                  setVerification(`Logged in${a.email ? ` as ${a.email}` : ''}.`)
                  onCreated()
                }}
                onCancel={reset}
              />
              <button type="button" onClick={() => setOwnTerminal(true)} className="self-start text-[11px] text-ink-3 hover:text-ink-2">
                Sign in from your own terminal instead
              </button>
            </>
          ) : (
            <>
              <p className="text-xs text-ink-2">Run this in your terminal, then verify:</p>
              <div className="flex items-center gap-2 rounded-lg bg-canvas p-2">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[11px] text-ink">{command}</code>
                <button type="button" aria-label="copy login command" onClick={() => void copy()} className="shrink-0 rounded p-1 text-ink-2 hover:text-ink">
                  {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                </button>
              </div>
              <div className="flex items-center justify-between gap-2">
                <button type="button" onClick={() => setOwnTerminal(false)} className="text-[11px] text-ink-3 hover:text-ink-2">
                  Sign in here instead
                </button>
                <button
                  type="button"
                  onClick={() => void verify()}
                  className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink hover:border-ink-2"
                >
                  Verify
                </button>
              </div>
              {verification ? (
                <p className="min-w-0 truncate text-xs text-ink-2" title={verification}>
                  {verification}
                </p>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  )
}

type VerifyState = { phase: 'idle' | 'checking' } | { phase: 'ok' } | { phase: 'error'; message: string }

// the cheapestinference widget: a link to its site to get the key, ONE row
// per key (a subscriber holds one key per pool — three pools, three rows,
// each named after the models its key reaches), a paste field that adds the
// next one (or re-pastes a key the server invalidated), real server-side
// verification, and the models each key reaches (POST /api/providers/:id/models).
type KeyProvider = Extract<ProviderView, { kind: 'anthropic-compatible' }>

export function CheapestCard({ providers, onChange }: { providers: KeyProvider[]; onChange: () => void }) {
  const [key, setKey] = useState('')
  const [state, setState] = useState<VerifyState>({ phase: 'idle' })
  const [busy, setBusy] = useState(false)
  // a row whose key the server cleared (baseUrl changed without a re-paste):
  // the paste field repairs THAT row instead of adding another
  const needsKey = providers.find((p) => p.apiKey === '') ?? null

  async function connect(): Promise<void> {
    setBusy(true)
    setState({ phase: 'checking' })
    try {
      if (needsKey) {
        // repairing a row the server cleared: re-paste, then verify (which
        // also refreshes and names what the key reaches)
        await api.providers.update(needsKey.id, { apiKey: key.trim() })
        const r = await api.providers.verify(needsKey.id)
        setState(r.ok ? { phase: 'ok' } : { phase: 'error', message: r.error ?? 'error' })
      } else {
        // a new key: ONE call that verifies first and stores only what works,
        // the row already named after the models it reaches (same key = same row)
        await api.providers.connect({ label: 'cheapestinference', baseUrl: CHEAPESTINFERENCE_BASE_URL, apiKey: key.trim() })
        setState({ phase: 'ok' })
      }
      setKey('')
      onChange()
    } catch (e) {
      setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const connected = providers.length > 0
  return (
    <div className="flex w-full max-w-sm flex-col gap-3 rounded-xl border border-line bg-panel p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-sm font-semibold lowercase tracking-tight text-ink">
          cheapest<span className="text-terracotta">inference</span>
        </p>
        {connected && !needsKey && state.phase !== 'error' ? <StatusDot active label={state.phase === 'checking' ? 'checking…' : 'connected'} /> : null}
      </div>
      <p className="text-xs text-ink-2">
        Flat-rate pools with an Anthropic-compatible endpoint — agents run through it unchanged. One key per pool; each row says which models its key reaches,
        re-read from the gateway at boot and every 6 h.
      </p>
      <a
        href={CHEAPESTINFERENCE_KEYS_URL}
        target="_blank"
        rel="noreferrer"
        className="flex w-fit items-center gap-1 text-xs font-medium text-terracotta hover:opacity-80"
      >
        {connected ? 'Your keys' : 'Get your key'}
        <ExternalLink size={11} aria-hidden="true" />
      </a>
      {providers.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {providers.map((p) => (
            <CheapestRow key={p.id} p={p} onChange={onChange} />
          ))}
        </ul>
      ) : null}
      {needsKey ? <p className="text-xs text-terracotta">Key required — paste it again to reconnect.</p> : null}
      <div className="flex items-center gap-2">
        <input
          type="password"
          aria-label="cheapestinference api key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={needsKey ? 'paste the key again…' : connected ? 'paste another pool’s key (sk-…)' : 'paste your key (sk-…)'}
          className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-1.5 font-mono text-xs outline-none focus:border-terracotta"
        />
        <button
          type="button"
          onClick={() => void connect()}
          disabled={busy || key.trim() === ''}
          className="shrink-0 rounded-lg bg-terracotta px-3 py-1.5 text-xs font-medium text-on-terracotta hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Verifying…' : connected && !needsKey ? 'Add another key' : 'Connect'}
        </button>
      </div>
      {state.phase === 'error' ? <p className="text-xs text-terracotta">{state.message}</p> : null}
    </div>
  )
}

// one cheapestinference key: what it reaches, its masked key, Verify / Copy config / Remove
function CheapestRow({ p, onChange }: { p: KeyProvider; onChange: () => void }) {
  const [state, setState] = useState<VerifyState>({ phase: 'idle' })
  const hasKey = p.apiKey !== ''

  async function verify(): Promise<void> {
    setState({ phase: 'checking' })
    const r = await api.providers.verify(p.id).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    setState(r.ok ? { phase: 'ok' } : { phase: 'error', message: r.error ?? 'error' })
    if (r.ok) {
      // refresh what the key reaches while we are at it
      const found = await Promise.resolve(api.providers.discoverModels(p.id)).catch(() => null)
      if (found?.ok) onChange()
    }
  }

  async function remove(): Promise<void> {
    await api.providers.delete(p.id)
    onChange()
  }

  const models = p.models ?? []
  return (
    <li className="flex flex-col gap-0.5 rounded-lg border border-line bg-canvas px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm text-ink">{p.label}</span>
        {hasKey ? (
          <span className="shrink-0 font-mono text-[11px] text-ink-2">{p.apiKey}</span>
        ) : (
          <span className="shrink-0 text-[11px] text-terracotta">key required</span>
        )}
      </div>
      <p className="font-mono text-[11px] text-ink-2">
        {models.length > 0 ? models.join(' · ') : 'models not listed yet — Verify asks'}
        {p.modelsAt ? <span className="text-ink-3"> · listed {relTime(Date.parse(p.modelsAt))}</span> : null}
      </p>
      <div className="mt-1 flex items-center gap-3 text-xs">
        {hasKey ? (
          <button type="button" onClick={() => void verify()} className="font-medium text-ink-2 hover:text-ink">
            {state.phase === 'checking' ? 'Checking…' : 'Verify'}
          </button>
        ) : null}
        {state.phase === 'ok' ? <StatusDot active label="connected" /> : null}
        {state.phase === 'error' ? (
          <span className="min-w-0 truncate text-terracotta" title={state.message}>
            {state.message}
          </span>
        ) : null}
        <CopyConfig p={p} />
        <ConfirmButton
          onConfirm={() => void remove()}
          confirmLabel="Remove?"
          className="font-medium text-ink-2 hover:text-terracotta"
          armedClassName="font-medium text-terracotta"
        >
          Remove
        </ConfirmButton>
      </div>
    </li>
  )
}

// custom BYOK: any endpoint compatible with the Anthropic API.
export function CustomCard({ onChange }: { onChange: () => void }) {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')
  const [state, setState] = useState<VerifyState>({ phase: 'idle' })
  const [busy, setBusy] = useState(false)

  async function addProvider(): Promise<void> {
    setBusy(true)
    setState({ phase: 'checking' })
    try {
      const created = await api.providers.create({ label: label.trim(), baseUrl: baseUrl.trim(), apiKey: key.trim() })
      const r = await api.providers.verify(created.id)
      setState(r.ok ? { phase: 'ok' } : { phase: 'error', message: r.error ?? 'error' })
      setLabel('')
      setBaseUrl('')
      setKey('')
      onChange()
    } catch (e) {
      setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full max-w-sm items-center justify-center gap-2 rounded-xl border border-dashed border-line p-4 text-sm text-ink-2 hover:border-ink-2 hover:text-ink"
      >
        <Plus size={14} aria-hidden="true" />
        Custom provider
      </button>
    )
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-2 rounded-xl border border-dashed border-line p-4">
      <p className="text-sm font-medium text-ink">Custom provider</p>
      <p className="text-xs text-ink-2">Any Anthropic-compatible endpoint, with your own key.</p>
      <input
        type="text"
        aria-label="provider name"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="name"
        className="rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm outline-none focus:border-terracotta"
      />
      <input
        type="text"
        aria-label="base url"
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder="https://…/anthropic"
        className="rounded-lg border border-line bg-canvas px-3 py-1.5 font-mono text-xs outline-none focus:border-terracotta"
      />
      <input
        type="password"
        aria-label="api key"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="api key"
        className="rounded-lg border border-line bg-canvas px-3 py-1.5 font-mono text-xs outline-none focus:border-terracotta"
      />
      <div className="mt-1 flex items-center justify-end gap-3">
        {state.phase === 'error' ? (
          <p className="mr-auto min-w-0 truncate text-xs text-terracotta" title={state.message}>
            {state.message}
          </p>
        ) : null}
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink-2 hover:text-ink">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void addProvider()}
          disabled={busy || label.trim() === '' || baseUrl.trim() === '' || key.trim() === ''}
          className="rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-canvas hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Verifying…' : 'Add provider'}
        </button>
      </div>
    </div>
  )
}

function ProviderRow({ p, onChange }: { p: Extract<ProviderView, { kind: 'anthropic-compatible' }>; onChange: () => void }) {
  const [state, setState] = useState<VerifyState>({ phase: 'idle' })

  async function verify(): Promise<void> {
    setState({ phase: 'checking' })
    const r = await api.providers.verify(p.id).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    setState(r.ok ? { phase: 'ok' } : { phase: 'error', message: r.error ?? 'error' })
  }

  async function remove(): Promise<void> {
    await api.providers.delete(p.id)
    onChange()
  }

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-panel px-3 py-2">
      <span className="min-w-0 truncate text-sm font-medium text-ink">{p.label}</span>
      <span className="min-w-0 truncate font-mono text-[11px] text-ink-2" title={p.baseUrl}>
        {p.baseUrl}
      </span>
      {p.apiKey === '' ? (
        // an invalidated key (the baseUrl changed without re-pasting it) — honest, not a gap
        <span className="text-[11px] text-terracotta">key required</span>
      ) : (
        <span className="font-mono text-[11px] text-ink-2">{p.apiKey}</span>
      )}
      <span className="ml-auto flex items-center gap-3">
        {state.phase === 'ok' ? <StatusDot active label="connected" /> : null}
        {state.phase === 'error' ? (
          <span className="max-w-56 truncate text-xs text-terracotta" title={state.message}>
            {state.message}
          </span>
        ) : null}
        <button type="button" onClick={() => void verify()} className="text-xs font-medium text-ink-2 hover:text-ink">
          {state.phase === 'checking' ? 'Checking…' : 'Verify'}
        </button>
        <CopyConfig p={p} />
        <ConfirmButton
          onConfirm={() => void remove()}
          confirmLabel="Remove?"
          className="text-xs font-medium text-ink-2 hover:text-terracotta"
          armedClassName="text-xs font-medium text-terracotta"
        >
          Remove
        </ConfirmButton>
      </span>
    </li>
  )
}

// "Copy config" (export): the provider as config to paste
// elsewhere — never with its key (the server puts a placeholder). The forms
// are the engines that export one (ui.providerExport) and run this kind; an
// engine's own provider (harness-*) only its engine's. One form copies at
// once; several ask which, in registration order — which reproduces today's
// "for Claude / for OpenCode" for an Anthropic-compatible endpoint (Claude
// Code registers first) and a direct opencode.json copy for an OpenCode one.
function exportChoices(list: readonly HarnessDescriptor[], p: Exclude<ProviderView, { kind: 'claude-account' }>): { target: string; label: string }[] {
  return list
    .filter((d) => d.providerKinds.includes(p.kind) && (p.kind === 'anthropic-compatible' || p.harness === d.id))
    .flatMap((d) => (d.ui.providerExport ? [d.ui.providerExport] : []))
}

function CopyConfig({ p }: { p: Exclude<ProviderView, { kind: 'claude-account' }> }) {
  const [choosing, setChoosing] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const choices = exportChoices(useHarnessDescriptors(), p)

  async function copy(target: string): Promise<void> {
    setChoosing(false)
    try {
      const snippet = await api.providers.exportConfig(p.id, target)
      await navigator.clipboard.writeText(snippet)
      setNote('Copied — paste your key where it says so')
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    }
    setTimeout(() => setNote(null), 2500)
  }

  const btn = 'text-xs font-medium text-ink-2 hover:text-ink'
  if (note) return <span className="text-xs text-ink-2">{note}</span>
  if (choices.length === 0) return null
  if (choosing) {
    return (
      <span className="flex items-center gap-2 text-xs text-ink-2">
        {choices.map((c, i) => (
          <Fragment key={c.target}>
            {i > 0 ? <span aria-hidden="true">/</span> : null}
            <button type="button" onClick={() => void copy(c.target)} className={btn}>
              {c.label}
            </button>
          </Fragment>
        ))}
      </span>
    )
  }
  return (
    <button type="button" onClick={() => (choices.length > 1 ? setChoosing(true) : void copy(choices[0]!.target))} className={btn}>
      Copy config
    </button>
  )
}

type EngineProvider = Extract<ProviderView, { kind: 'harness-provider' | 'harness-native' }>

// One engine's own provider: its catalogue id, then what it runs on — its
// own key (masked), a cleared key waiting for a re-paste, or the engine's login.
function EngineProviderRow({ p, engine, onChange }: { p: EngineProvider; engine: string; onChange: () => void }) {
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const needsKey = p.kind === 'harness-provider' && p.apiKey === ''

  async function saveKey(): Promise<void> {
    setError(null)
    try {
      await api.providers.update(p.id, { apiKey: key.trim() })
      setKey('')
      onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function remove(): Promise<void> {
    await api.providers.delete(p.id)
    onChange()
  }

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-panel px-3 py-2">
      <span className="min-w-0 truncate text-sm font-medium text-ink">{p.label}</span>
      <span className="font-mono text-[11px] text-ink-2">{p.providerId}</span>
      {p.kind === 'harness-native' ? (
        <span className="text-[11px] text-ink-2">{`login from ${engine} · shared by every ${engine} agent`}</span>
      ) : needsKey ? (
        <span className="text-[11px] text-terracotta">key needed — paste it again</span>
      ) : (
        <span className="font-mono text-[11px] text-ink-2">{p.apiKey}</span>
      )}
      <span className="ml-auto flex items-center gap-3">
        <CopyConfig p={p} />
        <ConfirmButton
          onConfirm={() => void remove()}
          confirmLabel="Remove?"
          className="text-xs font-medium text-ink-2 hover:text-terracotta"
          armedClassName="text-xs font-medium text-terracotta"
        >
          Remove
        </ConfirmButton>
      </span>
      {needsKey ? (
        <div className="flex w-full items-center gap-2 pt-1">
          <input
            type="password"
            aria-label={`${p.label} api key`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={`paste the ${p.providerId} key`}
            className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-1 font-mono text-xs outline-none focus:border-terracotta"
          />
          <button
            type="button"
            onClick={() => void saveKey()}
            disabled={key.trim() === ''}
            className="shrink-0 rounded-lg bg-ink px-3 py-1 text-xs font-medium text-canvas hover:opacity-90 disabled:opacity-50"
          >
            Save key
          </button>
          {error ? <span className="text-xs text-terracotta">{error}</span> : null}
        </div>
      ) : null}
    </li>
  )
}

// "Import from <engine>": the logins the engine already holds (ids only reach
// the browser; the routes are the descriptor's ui.loginImport). One click copies that one key
// into a Silos provider, server-side; an id already imported reads greyed.
// Shown only where the descriptor names a login import (ui.loginImport).
function ImportFromEngine({ d, logins, imported, onChange }: { d: HarnessDescriptor; logins: string[] | null; imported: Set<string>; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function importOne(id: string): Promise<void> {
    setBusy(id)
    setError(null)
    try {
      await api.providers.importLogin(d, id, id)
      onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-2 rounded-xl border border-line bg-panel p-4">
      <p className="text-sm font-medium text-ink">{`Import from ${d.label}`}</p>
      {logins === null ? (
        <p className="text-xs text-ink-2">{`Reading ${d.label}’s logins…`}</p>
      ) : logins.length === 0 ? (
        <p className="text-xs text-ink-2">
          {`${d.label} has no logins on this machine.`}
          {d.ui.loginCommand ? (
            <>
              {' Run '}
              <span className="font-mono">{d.ui.loginCommand}</span>
              {', then come back.'}
            </>
          ) : null}
        </p>
      ) : (
        <>
          <p className="text-xs text-ink-2">{`The logins ${d.label} holds. Importing copies that key into Silos; ${d.label}’s file stays as it is.`}</p>
          <ul className="flex flex-col">
            {logins.map((id) => {
              const done = imported.has(id)
              return (
                <li key={id} className="flex items-center justify-between gap-2 py-1">
                  <span className={`font-mono text-xs ${done ? 'text-ink-3' : 'text-ink'}`}>{id}</span>
                  {done ? (
                    <span className="text-[11px] text-ink-3">imported</span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`import ${id}`}
                      onClick={() => void importOne(id)}
                      disabled={busy !== null}
                      className="rounded-lg border border-line px-2 py-0.5 text-xs font-medium text-ink hover:border-ink-2 disabled:opacity-50"
                    >
                      {busy === id ? 'Importing…' : 'Import'}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
      {error ? <p className="text-xs text-terracotta">{error}</p> : null}
    </div>
  )
}

// A new provider of an engine by hand: its own key for an id the engine
// catalogues, or the engine's own login for that id (nothing stored).
export function EngineCustomCard({ d, logins, onChange }: { d: HarnessDescriptor; logins: string[]; onChange: () => void }) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<'harness-provider' | 'harness-native'>('harness-provider')
  const [label, setLabel] = useState('')
  const [providerId, setProviderId] = useState('')
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function add(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const base = { harness: d.id, label: label.trim(), providerId: providerId.trim() }
      await api.providers.create(kind === 'harness-provider' ? { kind, ...base, apiKey: key.trim() } : { kind, ...base })
      setLabel('')
      setProviderId('')
      setKey('')
      setOpen(false)
      onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full max-w-sm items-center justify-center gap-2 rounded-xl border border-dashed border-line p-4 text-sm text-ink-2 hover:border-ink-2 hover:text-ink"
      >
        <Plus size={14} aria-hidden="true" />
        {`${d.label} provider`}
      </button>
    )
  }

  const input = 'rounded-lg border border-line bg-canvas px-3 py-1.5 outline-none focus:border-terracotta'
  return (
    <div className="flex w-full max-w-sm flex-col gap-2 rounded-xl border border-dashed border-line p-4">
      <p className="text-sm font-medium text-ink">{`${d.label} provider`}</p>
      <div className="flex gap-2" role="radiogroup" aria-label="runs on">
        {(
          [
            ['harness-provider', 'Its own key'],
            ['harness-native', `${d.label}’s login`],
          ] as const
        ).map(([value, text]) => (
          <label
            key={value}
            className="flex flex-1 cursor-pointer items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-1.5 text-xs text-ink-2 hover:text-ink has-[:checked]:border-terracotta has-[:checked]:text-ink"
          >
            <input
              type="radio"
              name={`${d.id}-kind`}
              value={value}
              checked={kind === value}
              onChange={() => setKind(value)}
              className="h-3.5 w-3.5 accent-terracotta"
            />
            {text}
          </label>
        ))}
      </div>
      <p className="text-xs text-ink-2">
        {kind === 'harness-provider'
          ? 'Silos keeps the key and gives it to each agent that uses this provider.'
          : `Nothing stored here: agents use the login ${d.label} already has — shared by every ${d.label} agent.`}
      </p>
      <input
        type="text"
        aria-label="provider name"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="name"
        className={`${input} text-sm`}
      />
      <input
        type="text"
        aria-label={`${d.id} provider id`}
        list={`${d.id}-login-ids`}
        value={providerId}
        onChange={(e) => setProviderId(e.target.value)}
        placeholder={d.ui.providerIdPlaceholder ?? 'provider id'}
        className={`${input} font-mono text-xs`}
      />
      <datalist id={`${d.id}-login-ids`}>
        {logins.map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>
      {kind === 'harness-provider' ? (
        <input
          type="password"
          aria-label="api key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="api key"
          className={`${input} font-mono text-xs`}
        />
      ) : null}
      <div className="mt-1 flex items-center justify-end gap-3">
        {error ? (
          <p className="mr-auto min-w-0 truncate text-xs text-terracotta" title={error}>
            {error}
          </p>
        ) : null}
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink-2 hover:text-ink">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void add()}
          disabled={busy || label.trim() === '' || providerId.trim() === '' || (kind === 'harness-provider' && key.trim() === '')}
          className="rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-canvas hover:opacity-90 disabled:opacity-50"
        >
          Add provider
        </button>
      </div>
    </div>
  )
}

export function ProvidersTab() {
  const [providers, setProviders] = useState<ProviderView[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((): void => {
    // Promise.resolve(...) — the same defensive pattern as AccountFooter (Sidebar.tsx).
    Promise.resolve(api.providers.list())
      .then((p) => {
        setProviders(p ?? [])
        setError(null)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // the engines that run their own providers, in registration order
  const engines = useHarnessDescriptors().filter((d) => d.providerKinds.includes('harness-provider'))

  const accounts = (providers ?? []).filter((p): p is Extract<ProviderView, { kind: 'claude-account' }> => p.kind === 'claude-account')
  const byKey = (providers ?? []).filter((p): p is Extract<ProviderView, { kind: 'anthropic-compatible' }> => p.kind === 'anthropic-compatible')
  const cheapest = byKey.filter(isCheapestProvider)
  const rest = byKey.filter((p) => !isCheapestProvider(p))

  return (
    <div className="flex flex-col divide-y divide-line">
      {error ? <p className="pt-8 text-sm text-terracotta">{error}</p> : null}
      {providers !== null ? <UnattendedSwitch providers={providers} /> : null}
      <section className="py-8 first:pt-8">
        <h2 className="font-display text-[19px] leading-tight text-ink">Claude accounts</h2>
        <p className="mb-4 mt-1 max-w-prose text-[13px] leading-relaxed text-ink-2">
          Each account is its own claude login with its own usage window. Signing in is Claude’s own sign-in — here, or in your terminal.
        </p>
        {providers === null ? (
          <p className="text-sm text-ink-2">Loading…</p>
        ) : (
          <div className="flex flex-wrap items-start gap-3">
            {accounts.map((c) => (
              <AccountCard key={c.id} account={c.account} onRefresh={load} />
            ))}
            <ConnectAccount onCreated={load} />
          </div>
        )}
      </section>
      <StartingSetSections />
      <section className="py-8">
        <h2 className="font-display text-[19px] leading-tight text-ink">Inference providers</h2>
        <p className="mb-4 mt-1 max-w-prose text-[13px] leading-relaxed text-ink-2">
          Anthropic-compatible endpoints, selectable per agent — and usable as fallback when an account hits its limit.
        </p>
        <div className="flex flex-wrap items-start gap-3">
          <CheapestCard providers={cheapest} onChange={load} />
          <CustomCard onChange={load} />
        </div>
        {rest.length > 0 ? (
          <ul className="mt-3 flex max-w-2xl flex-col gap-2">
            {rest.map((p) => (
              <ProviderRow key={p.id} p={p} onChange={load} />
            ))}
          </ul>
        ) : null}
      </section>
      {engines.map((d) => (
        <EngineProvidersSection
          key={d.id}
          d={d}
          providers={(providers ?? []).filter((p): p is EngineProvider => (p.kind === 'harness-provider' || p.kind === 'harness-native') && p.harness === d.id)}
          onChange={load}
        />
      ))}
    </div>
  )
}

// The install's unattended provider: what every
// turn with nobody in front runs on. The policy is LINKED, never paraphrased
// — Silos cannot keep a sentence about what Anthropic allows true. Agents
// whose engine cannot run the pick keep their own account, said beside it.
// No /api/settings (an older server): the section is not drawn.
const USAGE_POLICY_URL = 'https://www.anthropic.com/legal/aup'

function UnattendedSwitch({ providers }: { providers: ProviderView[] }) {
  const [view, setView] = useState<PlatformSettingsView | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    Promise.resolve(api.platformSettings.get())
      .then((v) => {
        if (live) setView(v ?? null)
      })
      .catch(() => {
        if (live) setView(null)
      })
    return () => {
      live = false
    }
  }, [])
  if (view === null) return null
  const current = view.unattendedProvider
  // a stored id that no longer exists runs nothing: each agent's own stands
  const known = current !== null && providers.some((p) => p.id === canonicalProviderId(current))
  const choose = (raw: string): void => {
    const id = raw === '' ? null : raw
    setSaving(true)
    setError(null)
    api.platformSettings
      .setUnattendedProvider(id)
      .then((v) => setView(v))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false))
  }
  return (
    <section className="py-8 first:pt-8" data-testid="unattended-switch">
      <h2 className="font-display text-[19px] leading-tight text-ink">Unattended turns</h2>
      <p className="mb-4 mt-1 max-w-prose text-[13px] leading-relaxed text-ink-2">
        Heartbeats, task wakes and automations use this. A Claude subscription is for your own use — if this install works for someone else’s business, use an
        API key.{' '}
        <a
          href={USAGE_POLICY_URL}
          target="_blank"
          rel="noreferrer"
          className="whitespace-nowrap text-ink underline decoration-line underline-offset-2 hover:decoration-ink"
        >
          Anthropic’s usage policy ›
        </a>
      </p>
      <div className="flex max-w-2xl flex-wrap items-center gap-x-3 gap-y-2">
        <label htmlFor="unattended-provider" className="text-sm text-ink">
          Unattended turns run on
        </label>
        <select
          id="unattended-provider"
          value={known ? canonicalProviderId(current) : ''}
          disabled={saving}
          onChange={(e) => choose(e.target.value)}
          className="min-w-0 max-w-full rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm text-ink outline-none focus:border-terracotta disabled:opacity-60"
        >
          <option value="">Each agent’s own account</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {providerLabel(providers, p.id)}
            </option>
          ))}
        </select>
      </div>
      {known && view.keepOwnAccount.length > 0 ? (
        <p className="mt-2 text-xs text-ink-2">Agents on {view.keepOwnAccount.join(' and ')} keep their own account.</p>
      ) : null}
      {error ? (
        <p className="mt-2 text-xs text-terracotta" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}

// «New projects — what your Claude account sends» (spec tools-origin §8):
// the user's starting set, its one house. Per engine that declares classes,
// one switch per class — what a project loads when its first agent of that
// engine arrives (server/src/starting-set.ts). Each line says Recommended,
// or offers «Back to recommended» when it differs. A project that exists
// keeps what it has: its own Tools and Skills switch it. No /api/settings
// or no class (an older server, an engine that declares none): not drawn.
// A class whose origin this whole machine keeps off (its head in the user's
// own settings — GET /api/loads/machine) says so on its line: a new project
// can't add it whatever its switch here; «change ›» opens that head's
// machine line right there (spec scopes §5).
function StartingSetSections() {
  const [view, setView] = useState<PlatformSettingsView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [machine, setMachine] = useState<MachineHeads | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    Promise.resolve(api.platformSettings.get())
      .then((v) => {
        if (live) setView(v ?? null)
      })
      .catch(() => {
        if (live) setView(null)
      })
    return () => {
      live = false
    }
  }, [])
  useEffect(() => {
    let live = true
    Promise.resolve()
      .then(() => api.folders.machineHeads())
      .then(
        (v) => {
          if (live) setMachine(v ?? null)
        },
        () => {
          if (live) setMachine(null)
        },
      )
    return () => {
      live = false
    }
  }, [tick])
  const headOf = (engine: string, c: StartingSetClass) =>
    c.origin ? machine?.engines.find((e) => e.engine === engine)?.heads.find((h) => h.id === c.origin) : undefined
  const engines = Object.entries(view?.startingSet ?? {}).filter(([, classes]) => classes.length > 0)
  if (engines.length === 0) return null
  const set = (engine: string, id: string, to: boolean | null): void => {
    setBusy(`${engine}:${id}`)
    setError(null)
    api.platformSettings
      .setStartingSet({ [engine]: { [id]: to } })
      .then((v) => setView(v))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null))
  }
  return (
    <>
      {engines.map(([engine, classes]) => (
        <section key={engine} className="py-8" data-testid="starting-set">
          {/* one origin: whose it is; several (this machine + the account, D6): what they start with */}
          <h2 className="font-display text-[19px] leading-tight text-ink">
            {new Set(classes.map((c) => c.from)).size > 1 ? 'New projects — what they start with' : `New projects — what ${classes[0]!.from} sends`}
          </h2>
          <p className="mb-4 mt-1 max-w-prose text-[13px] leading-relaxed text-ink-2">
            What a project loads when its first agent arrives. Projects that exist keep what they have — each one switches it in its Tools and Skills.
          </p>
          <ul className="max-w-2xl divide-y divide-line overflow-hidden rounded-lg border border-line">
            {classes.map((c) => {
              const on = classOn(c, {})
              const differs = on !== c.recommended
              const key = `${engine}:${c.id}`
              return (
                <li key={c.id} className="flex items-start gap-4 px-4 py-3" data-testid={`starting-${c.id}`}>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-baseline gap-x-2 text-[14px] leading-6 text-ink">
                      {/* the head says whose: the line names what */}
                      {new Set(classes.map((x) => x.from)).size > 1 ? classTitle(c) : classWhat(c)}
                      {differs ? (
                        <button
                          type="button"
                          disabled={busy === key}
                          onClick={() => set(engine, c.id, null)}
                          className="text-[11.5px] text-ink-2 underline decoration-line underline-offset-2 hover:text-terracotta disabled:opacity-50"
                        >
                          Back to recommended
                        </button>
                      ) : (
                        <span className="text-[11.5px] text-terracotta">Recommended</span>
                      )}
                    </p>
                    <p className="text-[12.5px] leading-5 text-ink-2">{on ? classOnWords(c) : classOffWords(c)}</p>
                    {(() => {
                      const h = headOf(engine, c)
                      if (!h || (!h.off && opened !== key)) return null
                      return (
                        <>
                          {h.off ? (
                            <p className="mt-0.5 text-[12px] leading-5 text-[var(--health-amber)]" data-testid="machine-keeps-off">
                              Off for this whole machine — new projects can’t add it
                              <span className="text-ink-3"> · </span>
                              <button
                                type="button"
                                aria-expanded={opened === key}
                                onClick={() => setOpened(opened === key ? null : key)}
                                className="text-ink-2 hover:text-terracotta"
                              >
                                change ›
                              </button>
                            </p>
                          ) : null}
                          {opened === key ? (
                            <div className="-ml-[34px] mt-1">
                              <WhereItLoads
                                row={{ key: `head:${c.origin}`, label: `${c.what} from ${c.from}`, kind: 'head', engine, at: h.at }}
                                head={c.origin!}
                                machineEngine={engine}
                                page={{ scope: 'project' }}
                                indent={false}
                                onChanged={() => setTick((t) => t + 1)}
                              />
                            </div>
                          ) : null}
                        </>
                      )
                    })()}
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={classTitle(c)}
                    disabled={busy === key}
                    onClick={() => set(engine, c.id, !on)}
                    className={`relative mt-1 h-[18px] w-8 shrink-0 rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40 disabled:opacity-60 ${on ? 'bg-terracotta' : 'bg-ink-3/35'}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`absolute top-[2px] size-[14px] rounded-full bg-canvas shadow-sm transition-[left] duration-150 ${on ? 'left-[16px]' : 'left-[2px]'}`}
                    />
                  </button>
                </li>
              )
            })}
          </ul>
          {error ? (
            <p className="mt-2 text-xs text-terracotta" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      ))}
    </>
  )
}

// One engine's providers (`${label} providers`): import its logins (when the
// descriptor names a login import), add one by hand, and the rows.
function EngineProvidersSection({ d, providers, onChange }: { d: HarnessDescriptor; providers: EngineProvider[]; onChange: () => void }) {
  // the engine's logins (ids only) — for the import list and the id field,
  // fetched from the route its descriptor names (ui.loginImport.list)
  const [logins, setLogins] = useState<string[] | null>(d.ui.loginImport ? null : [])
  const importable = d.ui.loginImport !== null
  const listRoute = d.ui.loginImport?.list
  useEffect(() => {
    if (!importable) return
    let cancelled = false
    Promise.resolve(api.providers.engineLogins(d))
      .then((ids) => {
        if (!cancelled) setLogins(ids ?? [])
      })
      .catch(() => {
        if (!cancelled) setLogins([])
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the descriptor's route is the identity
  }, [importable, listRoute])
  const imported = new Set(providers.map((p) => p.providerId))

  return (
    <section className="py-8">
      <h2 className="font-display text-[19px] leading-tight text-ink">{`${d.label} providers`}</h2>
      <p className="mb-4 mt-1 max-w-prose text-[13px] leading-relaxed text-ink-2">{d.ui.providersAbout ?? `For agents that run on ${d.label}.`}</p>
      {/* its own sign-in by link (a ChatGPT subscription on OpenCode) */}
      {d.ui.signIn ? (
        <div className="mb-3 max-w-sm">
          <EngineSignIn d={d} onSignedIn={() => onChange()} />
        </div>
      ) : null}
      <div className="flex flex-wrap items-start gap-3">
        {importable ? <ImportFromEngine d={d} logins={logins} imported={imported} onChange={onChange} /> : null}
        <EngineCustomCard d={d} logins={logins ?? []} onChange={onChange} />
      </div>
      {providers.length > 0 ? (
        <ul className="mt-3 flex max-w-2xl flex-col gap-2">
          {providers.map((p) => (
            <EngineProviderRow key={p.id} p={p} engine={d.label} onChange={onChange} />
          ))}
        </ul>
      ) : null}
    </section>
  )
}
