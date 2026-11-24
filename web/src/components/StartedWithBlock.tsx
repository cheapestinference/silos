// StartedWithBlock.tsx — what THIS conversation started with, measured from
// its own transcript: the first
// reply's real token count, split by owner — this conversation · its agent ·
// the project · the Silos platform · your machine · the Claude account ·
// Claude Code — in proportion to each part's recorded size. One line and a
// bar; it expands IN the column into the parts grouped by owner, and every
// part opens the exact text the conversation received. Flags only what asks
// for something (a start hook whose output was cut, an MCP server that
// failed). Nothing here is an estimate except the split, said as such.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, ChevronRight, KeyRound } from 'lucide-react'
import { api } from '../lib/api'
import { OWNER_ORDER, ownerTone, type Owner, type OwnerContext } from '../lib/owners'
import { OwnerLabel } from './OwnerLabel'
import { Modal } from './Modal'
import { useGoHome } from './knows/go-home'
import { useStore } from '../store'
import { sessionViewOf } from '../store/selectors'
import type { FolderLoads, LoadsRow, StartProblem, StartedWith, StartedWithPart } from '../lib/types'
import { alertWords, sharedLink, signInWords } from '../lib/loads-view'
import { SignInDoor } from './knows/SignInDoor'
import { tokenWords } from '../lib/usage'
import { contextColorClass, knownWindow } from '../lib/context'
import { useHarness } from '../lib/harnesses'

const fmt = (n: number): string => n.toLocaleString('en-US')
// size on disk-ish terms (also said in MB): bytes ≈
// characters for this mostly-ASCII text — real per part; the now-total only
// exists in tokens, scaled by the conversation's own measured chars/tokens ratio
const short = (n: number): string => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`)
const dayOf = (iso: string | null): string | null => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : null)

const KIND_WORD: Record<string, string> = {
  system: 'System prompt',
  tools: 'Built-in tools',
  instructions: 'Instructions',
  'memory-index': 'Memory index',
  skills: 'Skill listing',
  agents: 'Subagent listing',
  deferred: 'Deferred tool names',
  mcp: 'MCP server',
  hook: 'Start hook',
  context: 'Session context',
  prelude: 'Silos prelude',
  outcome: 'Run instruction',
  first: 'Your first message',
}

// a path said under its owner's heading: relative to the project folder,
// ~ for the home directory — the owner is already in the group title
function partLabel(p: StartedWithPart, folder: string | null | undefined): string {
  let l = p.label
  if (folder && l.startsWith(folder.replace(/\/+$/, '') + '/')) l = l.slice(folder.replace(/\/+$/, '').length + 1)
  l = l.replace(/^\/home\/[^/]+\//, '~/')
  // a plugin's server is named as its Tools row, with its plugin
  if (p.kind === 'mcp' && p.group) l = `${l} · ${p.group} plugin`
  // a plugin's own listing lines say whose they are
  if ((p.kind === 'skills' || p.kind === 'agents') && p.group) return `${KIND_WORD[p.kind]} · ${p.group} plugin`
  return p.kind === 'hook' || p.kind === 'mcp' || p.kind === 'instructions' ? `${KIND_WORD[p.kind]} › ${l}` : (KIND_WORD[p.kind] ?? l)
}

// listings arrive as deltas (several records of one kind): one row each,
// a plugin's own lines apart (its row in Tools); a plugin's MCP servers are
// one row per plugin («product-management plugin · 14 servers») — dozens of
// 49-token rows say nothing more
function mergeParts(parts: StartedWithPart[]): StartedWithPart[] {
  const out = new Map<string, StartedWithPart & { n?: number }>()
  for (const p of parts) {
    const plugin = p.kind === 'mcp' ? p.group : undefined
    const k = `${p.owner}|${p.kind}|${p.kind === 'skills' || p.kind === 'agents' || p.kind === 'deferred' ? (p.group ?? '') : (plugin ?? p.label)}`
    const prev = out.get(k)
    if (prev) out.set(k, { ...prev, chars: prev.chars + p.chars, tokens: prev.tokens + p.tokens, ref: prev.ref ?? p.ref, n: (prev.n ?? 1) + 1 })
    else out.set(k, { ...p, n: 1 })
  }
  return [...out.values()].map(({ n, ...p }) =>
    p.kind === 'mcp' && p.group && (n ?? 1) > 1 ? { ...p, label: `${p.group} plugin · ${n} servers`, group: undefined, ref: undefined } : p,
  )
}

export function useStartedWith(folder: string | null, id: string | null): StartedWith | null | undefined {
  // undefined = loading; null = an engine that can't say
  const [sw, setSw] = useState<StartedWith | null | undefined>(undefined)
  useEffect(() => {
    if (!folder || !id) {
      setSw(null)
      return
    }
    let cancelled = false
    setSw(undefined)
    Promise.resolve()
      .then(() => api.startedWith(folder, id))
      .then((v) => {
        if (!cancelled) setSw(v ?? null)
      })
      .catch(() => {
        if (!cancelled) setSw(null)
      })
    return () => {
      cancelled = true
    }
  }, [folder, id])
  return sw
}

/** A start problem's row is turned off NOW at a place this conversation
 *  follows: its own line in «Where it loads» says off — else (no line: an
 *  engine without places, a conversation the server doesn't know) the
 *  folder holds it. The alert then says so, and offers no «Turn off». */
export function heldNow(row: LoadsRow | undefined, thread: string | null): boolean {
  if (!row) return false
  const line = row.at?.find((l) => l.place === 'conversation' && (!thread || l.conversation === thread))
  return line ? line.result === 'off' : row.state === 'held' || row.heldHere !== undefined
}

/** The rows the problems land on, as the folder's inventory reads them now
 *  for this conversation (GET …/loads?conversation=) — read only when a
 *  problem names a row; null until read (or when the read fails). */
function useProblemRows(cwd: string | null, id: string, keys: string, version: number): { rows: Map<string, LoadsRow>; thread: string | null } | null {
  const [v, setV] = useState<{ rows: Map<string, LoadsRow>; thread: string | null } | null>(null)
  useEffect(() => {
    setV(null)
    if (!cwd || !keys) return
    let cancelled = false
    const want = new Set(keys.split('\n'))
    Promise.resolve()
      .then(() => api.folders.loads(cwd, undefined, id))
      .then(
        (l: FolderLoads | null) => {
          if (cancelled || !l || !Array.isArray(l.rows)) return
          setV({ rows: new Map(l.rows.filter((r) => want.has(r.key)).map((r) => [r.key, r])), thread: l.conversation?.thread ?? null })
        },
        () => {
          /* unread: the alert as the start said it */
        },
      )
    return () => {
      cancelled = true
    }
  }, [cwd, id, keys, version])
  return v
}

export function OwnerBar({ byOwner, own, total, tall = false }: { byOwner: Partial<Record<Owner, number>>; own: Owner; total: number; tall?: boolean }) {
  const parts = OWNER_ORDER.filter((o) => (byOwner[o] ?? 0) > 0)
  if (total <= 0 || parts.length === 0) return null
  return (
    <div
      className={`flex w-full gap-px overflow-hidden rounded-sm ${tall ? 'h-3' : 'h-2'}`}
      role="img"
      aria-label={parts.map((o) => `${o} ${fmt(byOwner[o]!)} tokens`).join(', ')}
    >
      {parts.map((o) => (
        <span key={o} style={{ flexGrow: byOwner[o], flexBasis: 0, minWidth: 3 }} className={ownerTone(o, own)} />
      ))}
    </div>
  )
}

// `after`: what the conversation's column says under the size (its «outgrew
// its work» line) — inside this row, never a block of its own
export function StartedWithBlock({
  folder,
  id,
  ctx,
  initiallyOpen = false,
  own = 'conversation',
  after,
}: {
  folder: string
  id: string
  ctx: OwnerContext
  initiallyOpen?: boolean
  own?: Owner
  after?: ReactNode
}) {
  const sw = useStartedWith(folder, id)
  const [open, setOpen] = useState(initiallyOpen)
  const [reading, setReading] = useState<StartedWithPart | null>(null)
  const [problemsOpen, setProblemsOpen] = useState(false)
  const goHome = useGoHome()
  // In a conversation the bar weighs what it carries NOW (not just what it
  // started with): the total is
  // the latest reply's real input; what it inherits is as measured at its
  // first reply; «this conversation» is the rest — it grows each turn and
  // shrinks when it compacts, shown as is. Off a conversation (the agent's At
  // start) it stays the first reply.
  const weighs = !ctx.offConversation && sw?.measured === true && (sw.contextNow?.tokens ?? 0) > 0
  // what that size costs: every step re-reads it, and the cache reads
  // this conversation's replies have billed so far (its transcript's own
  // usage, detail.context.cost) — measured or not said
  const reread = useStore((s) =>
    s.detail?.meta.folder === folder && s.detail.meta.id === id ? (s.detail.context?.cost?.byModel.reduce((n, m) => n + m.cacheReadTokens, 0) ?? null) : null,
  )
  // the size as a share of its model's window (a context size is never
  // without its %) — the same window «% context» uses everywhere (lib/context
  // knownWindow): unknown model or an engine that reports none → no %
  const meta = useStore((s) => (s.detail?.meta.folder === folder && s.detail.meta.id === id ? s.detail.meta : null))
  const reportsWindow = useHarness(meta?.harness).ui.contextPercent
  // a console still running since that start keeps what it started with
  const running = useStore((s) => sessionViewOf(s.agents, { folder, id })?.live === true)
  const knowsVersion = useStore((s) => s.knowsVersion)
  const problemKeys = (sw?.problems ?? [])
    .map((p) => p.row)
    .filter((k): k is string => !!k)
    .join('\n')
  const now = useProblemRows(meta?.cwd ?? ctx.folder ?? null, id, problemKeys, knowsVersion.skills + knowsVersion.context)
  const window = knownWindow(meta?.model, reportsWindow)
  const { byOwner, total, since } = useMemo(() => {
    const m: Partial<Record<Owner, number>> = {}
    for (const p of sw?.parts ?? []) m[p.owner] = (m[p.owner] ?? 0) + p.tokens
    const start = sw?.totalTokens ?? 0
    if (!weighs) return { byOwner: m, total: start, since: 0 }
    const inherited = start - (m.conversation ?? 0)
    const now = sw!.contextNow!.tokens
    const mine = Math.max(0, now - inherited)
    const first = m.conversation ?? 0
    m.conversation = mine
    return { byOwner: m, total: Math.max(now, inherited), since: Math.max(0, mine - first) }
  }, [sw, weighs])
  if (!sw || sw.totalTokens === null) return null
  // start problems: ONE folded alert in a panel (a panel does not itemize
  // errors): names and their doors, never the error text nor how often —
  // those live on the row a door opens, by the key the server's inventory
  // made (problems[].row: the copy that really loaded, spec tools-origin §9)
  const problems: StartProblem[] = sw.problems ?? sw.failedMcpServers.map((f) => ({ kind: 'failed' as const, name: f.name, label: f.name }))
  const failed = problems.filter((p) => p.kind === 'failed')
  const signIns = problems.filter((p) => p.kind === 'needs-auth')
  const cut = sw.parts.filter((p) => p.truncated)
  // turned off since that start (at a place it follows): said, no «Turn off»
  const held = (p: StartProblem): boolean => !!p.row && now !== null && heldNow(now.rows.get(p.row), now.thread)
  const openSignIns = signIns.filter((p) => !held(p))
  const offWords =
    sw.mode === 'console' && running ? 'turned off — this console still carries it until restarted' : 'turned off — new conversations won’t load it'
  const said = alertWords(failed, signIns, cut)
  // every problem turned off since: the folded line says it, quietly
  const alert = said && cut.length === 0 && problems.length > 0 && problems.every(held) ? { text: `${said.text} · turned off`, amber: false } : said
  const link = sharedLink(openSignIns.map((p) => p.signIn))
  // the doors leave the conversation the way the Knows doors do: its
  // agent's tab, carrying the conversation («‹ <title>»), on the row; no
  // agent to open (a conversation of no agent): the project's tab
  const toTools = (h: { item?: string; filter?: 'sign-in' }): void => {
    const st = useStore.getState()
    const agentId = (st.page?.kind === 'agent' ? st.page.id : null) ?? st.detail?.meta.agentId ?? sessionViewOf(st.agents, st.selected)?.agentId ?? null
    if (agentId) st.openDossier('tools', h)
    else if (ctx.folder) goHome({ kind: 'project', folder: ctx.folder, tab: 'tools', ...h })
  }
  const canOpen = (p: StartProblem): boolean => !!p.row && !!ctx.folder
  const owners = OWNER_ORDER.filter((o) => (byOwner[o] ?? 0) > 0)
  return (
    <section aria-label="Started with" className="border-b border-line px-3 py-2.5" data-testid="started-with">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="group/s flex w-full items-baseline gap-2 text-left">
        <ChevronRight size={11} aria-hidden="true" className={`shrink-0 self-center text-ink-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="text-[11.5px] text-ink-2 group-hover/s:text-terracotta">{weighs ? 'Context size' : 'Started with'}</span>
        <span className="ml-auto font-mono text-[11px] tabular-nums text-ink">{fmt(total)} tokens</span>
        {weighs && window !== null
          ? (() => {
              const pct = Math.min(100, Math.max(0, Math.round((total / window) * 100)))
              return (
                <span
                  data-testid="context-pct"
                  title={`${fmt(total)} of ${fmt(window)} tokens — this model's context window`}
                  className={`font-mono text-[11px] tabular-nums text-ink-2 ${contextColorClass(pct)}`.trim()}
                >
                  {pct}%
                </span>
              )
            })()
          : null}
      </button>
      {/* at rest the row is the figure, its % and the bar (it must not take
          much room): the provenance line and what a step
          re-reads open with the row; only the outgrew line — it carries a
          door — stays at rest */}
      {weighs ? after : null}
      {/* folded by default: the bar alone — the legend lives
          in the expanded view, where each owner group already carries its
          color chip, label and amount */}
      {sw.measured ? (
        <div className="mt-1.5">
          <OwnerBar byOwner={byOwner} own={own} total={total} />
        </div>
      ) : null}
      {alert ? (
        <div className="mt-1.5" data-testid="start-problems" data-tone={alert.amber ? 'amber' : 'quiet'}>
          <button
            type="button"
            onClick={() => setProblemsOpen((v) => !v)}
            aria-expanded={problemsOpen}
            className={`flex w-full items-center gap-1.5 text-left text-[11.5px] hover:underline ${alert.amber ? 'text-[var(--health-amber)]' : 'text-ink-2'}`}
          >
            {alert.amber ? (
              <AlertTriangle size={11} aria-hidden="true" className="shrink-0" />
            ) : (
              <KeyRound size={11} aria-hidden="true" className="shrink-0 text-ink-3" />
            )}
            <span className="min-w-0 truncate">{alert.text}</span>
            <ChevronRight size={11} aria-hidden="true" className={`shrink-0 transition-transform ${problemsOpen ? 'rotate-90' : ''}`} />
          </button>
          {problemsOpen ? (
            <ul className="mt-1 space-y-0.5 pl-[17px]">
              {failed.map((p) => (
                <li key={`fail-${p.name}`} className="flex items-baseline gap-2 text-[11.5px] text-ink" data-held={held(p) ? 'true' : undefined}>
                  <span className="min-w-0 flex-1 truncate" title={held(p) ? `${p.name} · ${offWords}` : p.name}>
                    {p.label} didn’t start{held(p) ? <span className="text-ink-3"> · {offWords}</span> : null}
                  </span>
                  {canOpen(p) ? (
                    <button type="button" onClick={() => toTools({ item: p.row! })} className="shrink-0 text-[11px] text-ink-2 hover:text-terracotta">
                      {held(p) ? 'See it ›' : 'Turn off ›'}
                    </button>
                  ) : null}
                </li>
              ))}
              {signIns.filter(held).map((p) => (
                <li key={`held-${p.name}`} className="flex items-baseline gap-2 text-[11.5px] text-ink" data-held="true">
                  <span className="min-w-0 flex-1 truncate" title={`${p.name} · ${offWords}`}>
                    {signInWords([p])}
                    <span className="text-ink-3"> · {offWords}</span>
                  </span>
                  {canOpen(p) ? (
                    <button type="button" onClick={() => toTools({ item: p.row! })} className="shrink-0 text-[11px] text-ink-2 hover:text-terracotta">
                      See it ›
                    </button>
                  ) : null}
                </li>
              ))}
              {openSignIns.length > 0 ? (
                // ONE line for the sign-ins: all at one outside page
                // (connectors: claude.ai) — that page; else Tools narrowed
                // to them, each row its own door (one: its own row)
                <li className="flex items-baseline gap-2 text-[11.5px] text-ink">
                  {link ? (
                    <>
                      <span className="min-w-0 flex-1 truncate">{signInWords(openSignIns)}</span>
                      <SignInDoor door={link} onConsole={null} className="shrink-0 text-[11px]" />
                    </>
                  ) : ctx.folder && openSignIns.some((p) => p.row) ? (
                    <button
                      type="button"
                      onClick={() => toTools(openSignIns.length === 1 && openSignIns[0]!.row ? { item: openSignIns[0]!.row } : { filter: 'sign-in' })}
                      className="min-w-0 flex-1 truncate text-left hover:text-terracotta"
                    >
                      {signInWords(openSignIns)} ›
                    </button>
                  ) : (
                    <span className="min-w-0 flex-1 truncate">{signInWords(openSignIns)}</span>
                  )}
                </li>
              ) : null}
              {cut.map((p) => (
                <li key={`cut-${p.label}`} className="flex items-baseline gap-2 text-[11.5px] text-ink">
                  <span className="min-w-0 flex-1 truncate">{p.label}: start output cut</span>
                  {p.ref ? (
                    <button type="button" onClick={() => setReading(p)} className="shrink-0 text-[11px] text-ink-2 hover:text-terracotta">
                      Show it
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <div className="mt-2 space-y-0.5 pl-[17px]">
          {/* the provenance line left (it did not help); only the one case
              where it changes the reading stays */}
          {!sw.measured ? <p className="text-[11px] text-ink-3">Total only — no record of the parts.</p> : null}
          {weighs ? (
            <p className="text-[11px] leading-snug text-ink-2" data-testid="context-reread">
              Each step re-reads about this much
              {reread !== null && reread > 0 ? (
                <>
                  {' '}
                  · <span className="font-mono tabular-nums">{tokenWords(reread)}</span> re-read so far
                </>
              ) : null}
              .
            </p>
          ) : null}
        </div>
      ) : null}
      {open && sw.measured ? (
        <div className="mt-2.5 space-y-2.5" data-testid="started-with-parts">
          {owners.map((o) => (
            <div key={o}>
              <p className="flex items-baseline gap-1.5 text-[11.5px]">
                {/* the color chip maps the group to its slice of the bar;
                    glyphs stay out */}
                <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-[2px] ${ownerTone(o, own)}`} />
                {/* the Claude account's parts load only on its login: named */}
                <OwnerLabel
                  owner={o}
                  ctx={o === 'account' && sw.accounts.length ? { ...ctx, accountName: sw.accounts[sw.accounts.length - 1]!.email } : ctx}
                  size="sm"
                  glyph={false}
                />
                <span className="ml-auto font-mono text-[10.5px] tabular-nums text-ink-2">{fmt(byOwner[o]!)}</span>
              </p>
              <ul className="mt-0.5">
                {mergeParts(sw.parts.filter((p) => p.owner === o))
                  .sort((a, b) => b.tokens - a.tokens)
                  .map((p, i) => (
                    <li key={`${p.kind}:${p.label}:${i}`}>
                      <button
                        type="button"
                        disabled={!p.ref}
                        onClick={() => setReading(p)}
                        className="group/p flex w-full items-baseline gap-2 rounded px-1 py-0.5 pl-3.5 text-left enabled:hover:bg-panel disabled:cursor-default"
                      >
                        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink group-enabled/p:group-hover/p:text-terracotta">
                          {partLabel(p, ctx.folder)}
                          {p.loginBound && sw.accounts.length ? (
                            <span className="text-ink-3"> · only on {sw.accounts[sw.accounts.length - 1]!.email}</span>
                          ) : null}
                        </span>
                        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-ink-3">{short(p.tokens)}</span>
                      </button>
                    </li>
                  ))}
                {o === 'conversation' && since > 0 ? (
                  <li className="flex items-baseline gap-2 px-1 py-0.5 pl-3.5">
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink">Turns since — messages, tool results, replies</span>
                    <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-ink-3">{short(since)}</span>
                  </li>
                ) : null}
              </ul>
            </div>
          ))}
          {/* the tools it has NOW: their count, a door to its agent's Tools
              tab opened from this conversation (each fact once) */}
          {sw.now && sw.now.mcp.length > 0 ? (
            <button
              type="button"
              onClick={() => useStore.getState().openDossier('tools')}
              data-testid="tools-now-door"
              className="group/t mt-2.5 flex w-full items-baseline gap-2 border-t border-line/60 pt-2 text-left"
            >
              <span className="text-[11.5px] text-ink-2 group-hover/t:text-terracotta">
                {sw.now.mcp.length} MCP {sw.now.mcp.length === 1 ? 'server' : 'servers'} now
              </span>
              <ChevronRight size={11} aria-hidden="true" className="shrink-0 self-center text-ink-3 group-hover/t:text-terracotta" />
            </button>
          ) : null}
          {sw.pendingMcp > 0 ? (
            <p className="text-[11px] text-ink-3">
              {sw.pendingMcp} MCP {sw.pendingMcp === 1 ? 'server' : 'servers'} connected after the first reply — not counted here.
            </p>
          ) : null}
          {sw.accounts.length > 1 ? (
            <p className="text-[11px] leading-snug text-ink-3">
              Claude account over time: {sw.accounts.map((a) => `${a.email}${dayOf(a.at) ? ` (${dayOf(a.at)})` : ''}`).join(' → ')}
            </p>
          ) : null}
        </div>
      ) : null}
      {reading ? <PartText folder={folder} id={id} part={reading} ctx={ctx} onClose={() => setReading(null)} /> : null}
    </section>
  )
}

function PartText({ folder, id, part, ctx, onClose }: { folder: string; id: string; part: StartedWithPart; ctx: OwnerContext; onClose: () => void }) {
  const [text, setText] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    if (!part.ref) {
      setText(null)
      return
    }
    Promise.resolve()
      .then(() => api.startedWithPart(folder, id, part.ref!))
      .then((r) => {
        if (!cancelled) setText(r?.text ?? null)
      })
      .catch(() => {
        if (!cancelled) setText(null)
      })
    return () => {
      cancelled = true
    }
  }, [folder, id, part.ref])
  return (
    <Modal onClose={onClose} label={`${KIND_WORD[part.kind] ?? part.label} — what this conversation received`} size="xl">
      <p className="text-[15px] text-ink">
        {KIND_WORD[part.kind] ?? part.label}
        {part.kind === 'hook' || part.kind === 'mcp' || part.kind === 'instructions' ? ` › ${part.label}` : ''}
      </p>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-[12px] text-ink-2">
        <OwnerLabel owner={part.owner} ctx={ctx} size="sm" />{' '}
        <span className="font-mono text-[11px] tabular-nums">
          · {fmt(part.chars)} characters · ≈ {fmt(part.tokens)} tokens
        </span>
      </p>
      <p className="mt-1 text-[11.5px] text-ink-3">Exactly what this conversation received at its first reply.</p>
      <pre className="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-panel p-3 font-mono text-[11.5px] leading-relaxed text-ink">
        {text === undefined ? 'Reading…' : text === null ? 'This part has no recorded text.' : text}
      </pre>
    </Modal>
  )
}
