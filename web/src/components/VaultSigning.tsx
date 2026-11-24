// VaultSigning.tsx — the visible face of the signer. A Vault entry reaches
// its agents one of two ways, said with ONE
// vocabulary everywhere (the Vault page, the agent's Secrets tab,
// the conversation's Knows): «In its environment» (delivered — the value is
// in the agent's env) or «Signed by Silos — never in its hands» (the agent
// calls /api/egress/<NAME>/… and Silos adds the credential). Here: the mode
// mark, the binding editor, what signing contains and what it does not
// (the spec's sentences — binding UI text), and the folded log of signed
// calls (owner-only). The value is never touched by any of it.
import { useEffect, useState } from 'react'
import { ChevronRight, KeyRound, ShieldAlert, Signature } from 'lucide-react'
import { api } from '../lib/api'
import { relTimeOf } from '../lib/rel-time'
import type { BindingAsk, BindingResolution, SignedCall, VaultBinding, VaultEntry } from '../lib/types'

export const MODE_DELIVERED = 'In its environment'
export const MODE_SIGNED = 'Signed by Silos — never in its hands'

/** the bound host as people read it — scheme dropped, base path kept */
export function hostOf(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, '')
}

/** the local URL a signed entry is used through (the agent's side of it) */
export function egressUrl(name: string): string {
  return `$SILOS_API/api/egress/${name}/…`
}

/** the entry's mode, inline: an icon and the words, the host when signed */
export function ModeMark({ entry, compact = false }: { entry: VaultEntry; compact?: boolean }) {
  if (entry.binding) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-ink-2" title={`${MODE_SIGNED} · ${entry.binding.baseUrl}`}>
        <Signature size={12} aria-hidden="true" className="shrink-0" />
        <span className="whitespace-nowrap">{compact ? 'signed by Silos' : MODE_SIGNED}</span>
        <span className="truncate font-mono text-[10.5px] text-ink-3">
          <span className="font-sans">for</span> {hostOf(entry.binding.baseUrl)}
        </span>
      </span>
    )
  }
  // delivered is the common case: at rest a quiet key says it (the words
  // in its title and for screen readers), so the signed ones stand out
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-ink-3" title={MODE_DELIVERED}>
      <KeyRound size={11} aria-hidden="true" className="shrink-0" />
      {compact ? <span className="sr-only">{MODE_DELIVERED}</span> : MODE_DELIVERED}
    </span>
  )
}

/** What a signed entry contains, and what it
 *  does not — one source for the Vault and Settings › Territory. */
export const SIGNING_HOLDS: readonly string[] = [
  "The value never enters the agent's process: it cannot be printed, copied to a file or travel in a transcript.",
  'Every use is recorded.',
  'The receiving host is the one you set.',
]
export const SIGNING_DOESNT: readonly string[] = [
  'What the service lets that credential do — if the key can delete invoices, a signed call can delete them. Limiting the actions is up to the service, or to a token with fewer permissions.',
  "The service's response — if it sends the credential itself back (a «list API keys» endpoint, an error that quotes it), the agent sees it. The containment is on the request side.",
]

export function SigningLimits() {
  return (
    <div className="grid gap-3 text-[11px] leading-snug text-ink-2 sm:grid-cols-2" data-testid="signing-limits">
      <div>
        <div className="mb-1 font-medium text-ink">What holds it</div>
        <ul className="space-y-1">
          {SIGNING_HOLDS.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </div>
      <div>
        <div className="mb-1 font-medium text-ink">What doesn't hold it</div>
        <ul className="space-y-1">
          {SIGNING_DOESNT.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}

// the server's own sentences, one row each — never rephrased (never a
// silent lockout, the agents are named)
export function ServerWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null
  return (
    <ul role="status" className="space-y-1 rounded-md border border-line px-2.5 py-2" data-testid="signing-warnings">
      {warnings.map((w) => (
        <li key={w} className="text-[11px] leading-snug text-[var(--health-amber)]">
          {w}
        </li>
      ))}
    </ul>
  )
}

const FORMAT_PRESETS = ['Bearer %s', '%s'] as const

// ---- the proposed binding ------------------------------------------------
// An agent may propose the exact shape its code consumes; the owner still
// signs. The prefill reduces the owner's attention to a tap, so the HOST is
// the hero (where the credential will travel — the only door: the signer
// never passes the egress proxy), a first-time host is impossible not to
// see, a change to a signed entry reads as before → after, and the
// provenance says where it came from without vouching for it.

/** The host as the hero splits it: scheme only when it is not https, the
 *  subdomain and the base path quiet, the registrable domain prominent.
 *  `registrable` is the server's (binding-asks.ts) when it applies to this
 *  host; otherwise the last two labels — presentation only. */
export function hostParts(baseUrl: string, registrable?: string | null): { insecure: boolean; sub: string; domain: string; path: string } {
  let u: URL
  try {
    u = new URL(baseUrl)
  } catch {
    return { insecure: false, sub: '', domain: baseUrl.replace(/^https?:\/\//, ''), path: '' }
  }
  const host = u.hostname.toLowerCase()
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')
  const port = u.port ? `:${u.port}` : ''
  const labels = host.split('.')
  const domain =
    registrable && (host === registrable || host.endsWith(`.${registrable}`))
      ? registrable
      : /^[\d.]+$/.test(host) || host.includes(':') || labels.length <= 2
        ? host
        : labels.slice(-2).join('.')
  const sub = host === domain ? '' : host.slice(0, host.length - domain.length - 1)
  return { insecure: u.protocol === 'http:', sub, domain: `${domain}${port}`, path }
}

/** Where the credential will travel, read at a glance: the registrable
 *  domain large, the rest quiet. Mono — a look-alike is caught letter by
 *  letter, never by shape. */
export function HostHero({ baseUrl, registrable, quiet = false }: { baseUrl: string; registrable?: string | null; quiet?: boolean }) {
  const p = hostParts(baseUrl, registrable)
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline font-mono" data-testid="host-hero" title={baseUrl}>
      {p.insecure ? (
        <span className="mr-1 text-[11px] text-[var(--health-amber)]" title="http: the credential would travel unencrypted">
          http://
        </span>
      ) : null}
      {p.sub ? <span className={`${quiet ? 'text-[10.5px]' : 'text-[12px]'} text-ink-3`}>{p.sub}.</span> : null}
      <span className={`${quiet ? 'text-[12px] font-medium text-ink-2' : 'text-[17px] font-semibold tracking-tight text-ink'} break-all leading-tight`}>
        {p.domain}
      </span>
      {p.path ? <span className={`${quiet ? 'text-[10.5px]' : 'text-[12px]'} break-all text-ink-3`}>{p.path}</span> : null}
    </span>
  )
}

/** «Never seen on this install» — a domain no entry was ever signed for
 *  and no engine calls (binding-asks.ts). Not to be missed. */
export function NeverSeenMark({ domain }: { domain: string }) {
  return (
    <p
      role="note"
      data-testid="never-seen"
      className="flex max-w-[62ch] items-start gap-1.5 rounded-md border border-[var(--health-amber)] bg-[color-mix(in_srgb,var(--health-amber)_7%,transparent)] px-2.5 py-1.5 text-[11.5px] leading-snug text-ink"
    >
      <ShieldAlert size={14} aria-hidden="true" className="mt-px shrink-0 text-[var(--health-amber)]" />
      <span>
        <span className="font-medium">Never seen on this install.</span> No entry here has been signed for <span className="font-mono">{domain}</span>, and no
        engine calls it. Read it letter by letter: the credential goes wherever this says.
      </span>
    </p>
  )
}

/** Where a proposal came from — informative, never a guarantee: a plan file
 *  belongs to its project and nobody signs it. */
export function ProvenanceLine({ ask, nameOf }: { ask: Pick<BindingAsk, 'ref' | 'owner'>; nameOf: (agentId: string) => string }) {
  return (
    <p className="max-w-[62ch] text-[11px] leading-snug text-ink-3" data-testid="ask-provenance">
      Proposed in <span className="font-mono text-ink-2">{ask.ref}</span>, {nameOf(ask.owner)}’s task. Plan files are not signed: this says where the proposal
      sits, not who wrote it — judge the host.
    </p>
  )
}

const sendsOf = (inject: { header: string; format: string }): string => `${inject.header}: ${inject.format.replace('%s', '••••')}`

/** What changes on an entry already signed: now → after, the parts that
 *  move marked. */
export function BindingDiff({ before, after }: { before: VaultBinding; after: VaultBinding }) {
  const hostMoved = before.baseUrl !== after.baseUrl
  const sendsMoved = sendsOf(before.inject) !== sendsOf(after.inject)
  if (!hostMoved && !sendsMoved)
    return (
      <p className="text-[11px] text-ink-3" data-testid="binding-diff">
        Same signing as now.
      </p>
    )
  const cell = (moved: boolean, gone: boolean): string =>
    moved ? (gone ? 'text-ink-3 line-through decoration-ink-3/60' : 'font-medium text-ink') : 'text-ink-3'
  return (
    <dl className="grid grid-cols-[3.2rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[11px]" data-testid="binding-diff">
      <dt className="font-sans text-ink-3">now</dt>
      <dd className="min-w-0 break-all">
        <span className={cell(hostMoved, true)}>{hostOf(before.baseUrl)}</span> <span className={cell(sendsMoved, true)}>{sendsOf(before.inject)}</span>
      </dd>
      <dt className="font-sans text-ink-2">after</dt>
      <dd className="min-w-0 break-all">
        <span className={cell(hostMoved, false)}>{hostOf(after.baseUrl)}</span> <span className={cell(sendsMoved, false)}>{sendsOf(after.inject)}</span>
      </dd>
    </dl>
  )
}

/** A proposal as the task's row shows it (Needs you, the task's page): the
 *  host as hero, what it sends, the never-seen mark, the provenance and the
 *  door to the Vault's editor, prefilled. A broken ask says why, and its
 *  door never prefills. */
export function BindingAskCard({
  ask,
  nameOf,
  onSign,
  onOpenVault,
}: {
  ask: BindingAsk
  nameOf: (agentId: string) => string
  onSign: () => void
  onOpenVault: () => void
}) {
  const broken = ask.problem !== null || ask.entryId === null
  return (
    <div
      data-testid="binding-ask"
      className={`max-w-[62ch] space-y-1.5 border-l-2 py-0.5 pl-3 ${ask.neverSeen && !broken ? 'border-[var(--health-amber)]' : 'border-line'}`}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[12px] text-ink-2">
          Sign <span className="font-mono text-ink">{ask.entry || 'an entry'}</span>
          {ask.baseUrl ? ' for' : ''}
        </span>
        {ask.baseUrl ? <HostHero baseUrl={ask.baseUrl} registrable={ask.registrable} /> : null}
      </div>
      {ask.inject ? <p className="font-mono text-[11px] text-ink-2">sends {sendsOf(ask.inject)}</p> : null}
      {ask.neverSeen && !broken && ask.registrable ? <NeverSeenMark domain={ask.registrable} /> : null}
      {broken ? (
        <p role="alert" className="text-[11.5px] leading-snug text-[var(--health-red)]">
          {ask.problem ?? `${ask.entry} cannot be signed from this ask.`}
        </p>
      ) : null}
      <ProvenanceLine ask={ask} nameOf={nameOf} />
      <div className="flex items-center gap-3 pt-0.5">
        {broken ? (
          <button type="button" onClick={onOpenVault} className="text-[12px] text-ink-2 hover:text-terracotta">
            Open the Vault ›
          </button>
        ) : (
          <button type="button" onClick={onSign} className="rounded-md bg-terracotta px-2.5 py-1 text-xs font-medium text-on-terracotta hover:opacity-90">
            Review and sign ›
          </button>
        )}
      </div>
    </div>
  )
}

/** What a save answered, in one line — the tasks it let go. */
export function resolutionWords(r: BindingResolution | undefined, nameOf: (agentId: string) => string): string | null {
  if (!r || (r.resolved.length === 0 && r.failed.length === 0)) return null
  const parts: string[] = []
  if (r.resolved.length > 0) {
    const refs = r.resolved.map((x) => x.ref).join(', ')
    const who = [...new Set(r.resolved.map((x) => nameOf(x.owner)))].join(', ')
    parts.push(`Unblocked ${refs} — ${who} will check a first signed call.`)
  }
  for (const f of r.failed) parts.push(`${f.ref} still waits: ${f.reason}`)
  return parts.join(' ')
}

/** The binding editor: where it is signed for, with which header, in which
 *  shape. The server validates; its refusal is shown in its words.
 *  `proposals`: the live asks on THIS entry — `prefill` the one the
 *  owner came from. The form starts from it; the owner may pick another, or
 *  edit. Nothing is written but by the owner's save. */
export function BindingEditor({
  entry,
  onSaved,
  onCancel,
  proposals = [],
  prefill = null,
  nameOf = (id) => id,
}: {
  entry: VaultEntry
  onSaved: (warnings: string[], resolved?: BindingResolution) => Promise<void>
  onCancel: () => void
  proposals?: readonly BindingAsk[]
  prefill?: BindingAsk | null
  nameOf?: (agentId: string) => string
}) {
  const start = (p: BindingAsk | null): { baseUrl: string; header: string; format: string } => ({
    baseUrl: p?.baseUrl ?? entry.binding?.baseUrl ?? '',
    header: p?.inject?.header ?? entry.binding?.inject.header ?? 'Authorization',
    format: p?.inject?.format ?? entry.binding?.inject.format ?? 'Bearer %s',
  })
  const [chosen, setChosen] = useState<string | null>(prefill?.key ?? null)
  const [baseUrl, setBaseUrl] = useState(() => start(prefill).baseUrl)
  const [header, setHeader] = useState(() => start(prefill).header)
  const [format, setFormat] = useState(() => start(prefill).format)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const ready = baseUrl.trim() !== '' && header.trim() !== '' && format !== ''
  const preview = `${header.trim() || 'Header'}: ${format.replace('%s', '••••')}`
  const live = proposals.filter((p) => p.problem === null && p.entryId === entry.id)
  const picked = live.find((p) => p.key === chosen) ?? null
  // the mark follows the HOST on screen: shown while the form holds the
  // proposed host the server judged
  const typedUrl = baseUrl.trim().replace(/\/+$/, '')
  const proposedHere = picked !== null && picked.baseUrl !== null && typedUrl === picked.baseUrl ? picked : null

  function choose(p: BindingAsk): void {
    const s = start(p)
    setChosen(p.key)
    setBaseUrl(s.baseUrl)
    setHeader(s.header)
    setFormat(s.format)
    setRefusal(null)
  }

  async function save(): Promise<void> {
    if (!ready || busy) return
    setBusy(true)
    try {
      const binding: VaultBinding = { baseUrl: baseUrl.trim(), inject: { header: header.trim(), format } }
      const { warnings, resolved } = await api.vault.setBinding(entry.id, binding)
      setRefusal(null)
      await onSaved(warnings, resolved)
    } catch (e) {
      setRefusal(e instanceof Error ? e.message : 'Could not sign it')
    } finally {
      setBusy(false)
    }
  }

  const field = 'rounded-md border border-line bg-canvas px-2 py-1.5 font-mono text-[11px] outline-none focus:border-terracotta'
  return (
    <form
      className="space-y-2.5"
      onSubmit={(ev) => {
        ev.preventDefault()
        void save()
      }}
      data-testid="binding-editor"
    >
      {live.length > 0 ? (
        <div className="space-y-1.5" data-testid="binding-proposals">
          <div className="text-[11px] text-ink-2">
            {live.length === 1 ? 'Proposed by the task that waits on it' : `${live.length} tasks propose a signing for ${entry.name} — choosing one is yours`}
          </div>
          {live.length > 1 || chosen === null ? (
            <ul role="radiogroup" aria-label={`proposals for ${entry.name}`} className="space-y-1">
              {live.map((p) => (
                <li key={p.key}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={chosen === p.key}
                    onClick={() => choose(p)}
                    className={`flex w-full min-w-0 flex-wrap items-baseline gap-x-2 rounded-md border px-2 py-1 text-left ${chosen === p.key ? 'border-ink-3 bg-panel' : 'border-line hover:border-ink-3'}`}
                  >
                    {p.baseUrl ? (
                      <HostHero baseUrl={p.baseUrl} registrable={p.registrable} quiet />
                    ) : (
                      <span className="text-[11px] text-ink-3">no shape proposed</span>
                    )}
                    {p.inject ? <span className="font-mono text-[10.5px] text-ink-3">{sendsOf(p.inject)}</span> : null}
                    <span className="ml-auto text-[10.5px] text-ink-3">
                      {p.ref}, {nameOf(p.owner)}’s{p.neverSeen ? <span className="text-[var(--health-amber)]"> · never seen</span> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {live.length > 1 ? (
            <p className="max-w-[62ch] text-[10.5px] leading-snug text-ink-3">
              One entry has one binding. If two consumers need different shapes, they need two entries — the same key stored twice, each signed its own way.
            </p>
          ) : null}
          {picked ? <ProvenanceLine ask={picked} nameOf={nameOf} /> : null}
        </div>
      ) : null}
      {typedUrl !== '' ? (
        <div className="space-y-1.5">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="text-[11px] text-ink-2">The credential travels to</span>
            <HostHero baseUrl={typedUrl} registrable={proposedHere?.registrable ?? null} />
          </div>
          {proposedHere?.neverSeen && proposedHere.registrable ? <NeverSeenMark domain={proposedHere.registrable} /> : null}
          {entry.binding && ready ? <BindingDiff before={entry.binding} after={{ baseUrl: typedUrl, inject: { header: header.trim(), format } }} /> : null}
        </div>
      ) : null}
      <label className="block">
        <span className="mb-1 block text-[11px] text-ink-2">The service it signs for</span>
        <input
          aria-label={`${entry.name} service URL`}
          value={baseUrl}
          onChange={(ev) => setBaseUrl(ev.target.value)}
          placeholder="https://api.example.com"
          className={`w-full ${field}`}
        />
      </label>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-2">Header</span>
          <input aria-label={`${entry.name} header`} value={header} onChange={(ev) => setHeader(ev.target.value)} className={`w-36 ${field}`} />
        </label>
        <label className="block min-w-0 flex-1 basis-40">
          <span className="mb-1 block text-[11px] text-ink-2">
            Format — <span className="font-mono">%s</span> is the value
          </span>
          <input aria-label={`${entry.name} format`} value={format} onChange={(ev) => setFormat(ev.target.value)} className={`w-full ${field}`} />
        </label>
        <div className="flex gap-1 pb-0.5">
          {FORMAT_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setFormat(p)}
              aria-pressed={format === p}
              className={`rounded border px-1.5 py-0.5 font-mono text-[10.5px] ${format === p ? 'border-ink-3 text-ink' : 'border-line text-ink-3 hover:text-ink'}`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <p className="font-mono text-[10.5px] text-ink-3">sends {preview}</p>
      <p className="max-w-[62ch] text-[10.5px] text-ink-3">
        Header only: a service that takes its key in the query (<span className="font-mono">?api_key=</span>) cannot be signed — that entry stays in its
        environment.
      </p>
      {refusal ? (
        <p role="alert" className="max-w-[62ch] text-[11px] leading-snug text-terracotta">
          {refusal}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={!ready || busy}
          className="rounded-md bg-terracotta px-2.5 py-1 text-xs font-medium text-on-terracotta hover:opacity-90 disabled:opacity-40"
        >
          {busy ? 'Signing…' : entry.binding ? 'Save signing' : 'Sign it'}
        </button>
        <button type="button" onClick={onCancel} className="rounded px-1.5 py-0.5 text-xs text-ink-3 hover:text-ink">
          Cancel
        </button>
      </div>
    </form>
  )
}

function statusTone(c: SignedCall): string {
  if (c.error || c.status >= 500) return 'text-[var(--health-red)]'
  if (c.status >= 400) return 'text-[var(--health-amber)]'
  return 'text-ink-2'
}

/** The last signed calls, folded — one summary line at rest (who, when),
 *  the rows on demand. `filter` is the entry's id or the agent's. */
export function SignedCallsFold({
  filter,
  nameOf,
  showEntry = false,
  refreshKey,
}: {
  filter: { entry: string } | { agent: string }
  nameOf: (agentId: string | null) => string
  showEntry?: boolean
  refreshKey?: unknown
}) {
  const [rows, setRows] = useState<SignedCall[] | null>(null)
  const [open, setOpen] = useState(false)
  const key = 'entry' in filter ? `e:${filter.entry}` : `a:${filter.agent}`
  useEffect(() => {
    let cancelled = false
    Promise.resolve(api.vault.signedCalls({ ...filter, limit: 20 }))
      .then((r) => {
        if (!cancelled) setRows(r ?? [])
      })
      .catch(() => {
        if (!cancelled) setRows([])
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshKey])
  if (rows === null) return null
  if (rows.length === 0) {
    return (
      <p className="text-[11px] text-ink-3" data-testid="signed-calls">
        No signed calls yet — each one will show here.
      </p>
    )
  }
  const last = rows[0]!
  // by entry: who called last; by agent: with which entry
  const summary = `${rows.length === 20 ? 'Last 20' : rows.length} signed call${rows.length === 1 ? '' : 's'} · last ${relTimeOf(last.at) ?? ''} ${showEntry ? `with ${last.entry}` : `by ${nameOf(last.agent)}`}`
  return (
    <div data-testid="signed-calls">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-[11px] text-ink-2 hover:text-ink">
        <ChevronRight size={12} aria-hidden="true" className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
        {summary}
      </button>
      {open ? (
        <ul className="mt-1.5 divide-y divide-line/50 font-mono text-[10.5px]">
          {rows.map((c, i) => (
            <li
              key={`${c.at}-${i}`}
              className="grid grid-cols-[minmax(0,7.5rem)_3.2rem_minmax(0,1fr)_2.4rem_3.6rem] items-baseline gap-x-2 py-1 max-sm:grid-cols-[3.2rem_minmax(0,1fr)_2.4rem] max-sm:gap-y-0.5"
            >
              <span
                className={`truncate text-[11px] text-ink max-sm:col-span-3 ${showEntry ? 'font-mono' : 'font-sans'}`}
                title={showEntry ? c.entry : (c.agent ?? 'you')}
              >
                {showEntry ? c.entry : nameOf(c.agent)}
                <span className="text-ink-3 sm:hidden"> · {relTimeOf(c.at)}</span>
              </span>
              <span className="text-ink-2">{c.method}</span>
              <span className="truncate text-ink-2" title={`${c.host}${c.path}`}>
                {showEntry ? <span className="text-ink-3">{hostOf(c.host)}</span> : null}
                {c.path}
              </span>
              <span className={`text-right ${statusTone(c)}`} title={c.error ?? `${c.ms} ms`}>
                {c.status}
              </span>
              <span className="whitespace-nowrap text-right text-ink-3 max-sm:hidden">{relTimeOf(c.at)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
