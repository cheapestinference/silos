// SiloReviewPage.tsx — the install dialog (Silo Standard: pending →
// consequences → approve), the standard's product moment. /silo/<id>/review.
//
// Moment (docs/product.md): 2 — «What's mine to decide?». Every submission
// lands pending; the owner's click is the only activation there is. Reached
// from the Needs you row the submission lights on Home (and the project page
// of the agent that submitted it), and from the silo's own page while a
// version of it waits. Approving lands on the silo's page, now active;
// rejecting leaves the decision said in place, the row gone from Home.
//
// The page paints the server's consequences answer (installer.ts) and
// derives nothing: WHAT SILOS WILL DO is the authority — the slots rendered
// in the very words and type they will have on Home (the preview, from real
// records or from the manifest's examples, its basis said), the exact paths
// it reads, who writes, what an update loosens; WHAT THE AUTHOR SAYS comes
// after, as a quote — set apart, attributed, never acted on. Changing the
// producer binding re-asks the server, which re-derives requirements and the
// proposed automation for that binding. Nothing here knows a silo by name.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, HelpCircle, X } from 'lucide-react'
import { useStore } from '../../store'
import { goBackTo, routeOf } from '../../lib/router'
import { Fact, PageHeader } from '../PageHeader'
import { siloCrumb, SiloSeal, silosCrumb } from './SiloPage'
import { api, ApiError } from '../../lib/api'
import {
  actionWord,
  approveBlockers,
  dialogTitle,
  KERNEL_PRODUCER,
  kernelReadWords,
  locationWords,
  producerChoices,
  promptGist,
  prose,
  proseList,
  slotPlace,
  splitLocations,
  submittedWords,
} from '../../lib/silo-install'
import { relTime } from '../../lib/rel-time'
import type { SiloConsequences } from '../../lib/types'
import { LookPair } from './SiloLook'

const sentence = (x: string): string => x.charAt(0).toUpperCase() + x.slice(1)

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-3">
      <h3 className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-3">{children}</h3>
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
    </div>
  )
}

// One slot of the preview, in the typography it will have where it lands:
// the pulse in the display face Home's sentence uses, a Needs you row with
// its urgency eyebrow, everything else as the plain line Silos says.
// A slot that starts OFF says so under its place — it is turned on later
// from the silo's page, never by approving.
function SlotSpecimen({ c, slot, says, off = false }: { c: SiloConsequences; slot: string; says: string | null; off?: boolean }) {
  const name = c.name ?? c.id
  const preview = c.derived.preview
  let body: React.ReactNode
  if (slot === 'pulse') {
    body = says ? (
      <p className="font-display text-[18px] leading-snug text-ink">
        {name}: {says}.
      </p>
    ) : (
      <p className="text-[13px] text-ink-3">no sentence yet</p>
    )
  } else if (slot === 'needs-you' && preview) {
    body = (
      <ul className="flex flex-col gap-2">
        {preview.needsYou.map((n, i) => (
          <li key={i}>
            <span className="block font-mono text-[11px] text-ink-2">
              {name.toLowerCase()} · {n.urgency}
              {n.audience === 'producer-agent' ? ' · goes to the producer, not you' : ''}
            </span>
            {n.row ? (
              <span className="block text-[14px] leading-snug text-ink">
                {n.row}
                {n.matches > 1 ? <span className="ml-2 font-mono text-[11px] text-ink-3">and {n.matches - 1} more like it</span> : null}
              </span>
            ) : (
              <span className="block text-[13px] leading-snug text-ink-3">
                nothing matches right now{n.sample ? <> — it would read like «{n.sample}»</> : null}
              </span>
            )}
          </li>
        ))}
      </ul>
    )
  } else {
    body = <p className="text-[13.5px] text-ink">{says ?? '—'}</p>
  }
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-1 py-3 sm:grid-cols-[11rem_1fr]">
      <span className="font-mono text-[11px] text-ink-3 sm:pt-1">
        {slotPlace(slot)}
        {off ? (
          <span className="block text-ink-2" data-testid="silo-review-slot-off">
            starts off — turn it on from its page
          </span>
        ) : null}
      </span>
      <div className={off ? 'min-w-0 opacity-60' : 'min-w-0'}>{body}</div>
    </div>
  )
}

// One source: the places holding something, listed; the empty ones counted
// on one line that unfolds in place (lib/silo-install splitLocations).
function ReadsOf({ r }: { r: SiloConsequences['derived']['reads'][number] }) {
  const [open, setOpen] = useState(false)
  // a kernel source reads no files: the catalog's words, never a path
  if (r.root === 'kernel') {
    return (
      <li data-testid="silo-review-kernel-read">
        <p className="font-mono text-[11.5px] text-ink-2">{r.convention ?? `kernel:${r.kind ?? '?'}`}</p>
        <p className="mt-1 text-[13.5px] text-ink">{kernelReadWords(r)}</p>
      </li>
    )
  }
  const { listed, quiet } = splitLocations(r.locations)
  const row = (l: (typeof r.locations)[number]): React.ReactNode => (
    <li key={l.location} className="flex items-baseline gap-3 border-b border-line/50 py-1">
      <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-ink">{l.path}</span>
      <span className={`shrink-0 font-mono text-[11px] ${l.exists ? 'text-ink-2' : 'text-ink-3'}`}>{locationWords(l)}</span>
    </li>
  )
  return (
    <li>
      <p className="font-mono text-[11.5px] text-ink-2">
        {r.convention ?? `${r.root}:${r.glob}`} · {r.parser}
      </p>
      <ul className="mt-1 flex flex-col">
        {listed.map(row)}
        {open ? quiet.map(row) : null}
      </ul>
      {quiet.length > 0 ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 font-mono text-[11px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
          data-testid="silo-review-quiet-places"
        >
          {open
            ? 'hide the empty places'
            : `${listed.length > 0 ? `and ${quiet.length} more` : quiet.length} place${quiet.length === 1 ? '' : 's'} with nothing there yet — show`}
        </button>
      ) : null}
      {typeof r.truncated === 'string' ? <p className="mt-1 font-mono text-[11px] text-ink-3">{r.truncated}</p> : null}
    </li>
  )
}

export function SiloReviewPage({ siloId }: { siloId: string }) {
  const agents = useStore((s) => s.agents)
  const changePage = useStore((s) => s.changePage)
  const loadSilos = useStore((s) => s.loadSilos)
  const nowTick = useStore((s) => s.nowTick)
  // the crumb's name before the submission has answered (a pending silo has none yet)
  const siloLabel = useStore((s) => s.silos.find((x) => x.id === siloId)?.name ?? siloId)

  const [c, setC] = useState<SiloConsequences | null>(null)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string[] | null>(null) // null until the proposal arrives
  const [automation, setAutomation] = useState(false) // opt-in: nothing activates by itself
  const [promptOpen, setPromptOpen] = useState(false)
  const [stateMapOpen, setStateMapOpen] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [rejected, setRejected] = useState<{ name: string; reason: string | null; told: string | null } | null>(null)
  const seq = useRef(0)

  // the consequences for a binding (null = Silos' own proposal). Answers
  // that arrive out of order are dropped: the newest ask wins.
  // keepError: a re-read after a refusal must not erase the refusal
  const fetchFor = useCallback(
    async (producers: string[] | null, keepError = false): Promise<void> => {
      const n = ++seq.current
      try {
        const next = await api.silos.consequences(siloId, producers ?? undefined)
        if (n !== seq.current) return
        setC(next)
        if (!keepError) setError(null)
        setChosen((prev) => prev ?? next.derived.proposedProducers)
      } catch (e) {
        if (n !== seq.current) return
        if (e instanceof ApiError && e.status === 404) setMissing(true)
        else setError(e instanceof Error ? e.message : String(e))
      }
    },
    [siloId],
  )

  useEffect(() => {
    void fetchFor(null)
  }, [fetchFor])

  const choices = useMemo(() => producerChoices(agents, c?.derived.proposedProducers ?? []), [agents, c])
  const blockers = c && chosen ? approveBlockers(c, chosen) : []

  function toggle(id: string): void {
    const next = chosen?.includes(id) ? chosen.filter((x) => x !== id) : [...(chosen ?? []), id]
    setChosen(next)
    void fetchFor(next)
  }

  async function approve(): Promise<void> {
    if (!c || !chosen) return
    setBusy(true)
    try {
      // the slots the dialog showed as «starts off» go with the approval, so
      // what it showed is what lands (a builtin's born-off pulse; an update
      // keeps the owner's switches)
      await api.silos.approve(siloId, {
        producers: chosen,
        automation: automation && c.derived.proposedAutomation !== null,
        slotsOff: c.derived.slots.filter((s) => s.off === true).map((s) => s.slot),
      })
      await loadSilos()
      // the dialog is done: back to the silo's page if that is where it was
      // opened from, else the page REPLACES the spent dialog (Back never
      // returns to an empty review)
      goBackTo(routeOf({ page: { kind: 'silo', id: siloId } }), () => changePage({ kind: 'silo', id: siloId }))
    } catch (e) {
      // the server's own refusal, said — and what it now derives, re-read
      setError(e instanceof Error ? e.message : String(e))
      void fetchFor(chosen, true)
    } finally {
      setBusy(false)
    }
  }

  async function reject(): Promise<void> {
    if (!c) return
    setBusy(true)
    try {
      const r = await api.silos.reject(siloId, reason.trim() === '' ? null : reason.trim())
      setRejected({
        name: `${c.name ?? c.id}${c.version.to ? ` ${c.version.to}` : ''}`,
        reason: r.reason,
        told: c.submittedBy === 'owner' ? null : c.submittedBy,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const author = c ? (c.submittedBy === 'owner' ? 'the manifest’s' : `${c.submittedBy}’s`) : ''
  const said = c?.authorSays
  const description = prose(said?.description)
  const summary = prose(said?.summary)
  const protocol = proseList(said?.protocol)
  const contract = proseList(said?.sync?.contract)
  const service = prose(said?.sync?.service)
  const auto = c?.derived.proposedAutomation ?? null
  const autoAgent = auto?.agentId ? agents.find((a) => a.id === auto.agentId) : undefined
  const verb = c ? actionWord(c.kind) : 'Install'
  // a silo that brings only a look: nothing to read, nobody to bind
  const lookOnly = c
    ? c.derived.look !== null &&
      c.derived.look !== undefined &&
      c.derived.reads.length === 0 &&
      (c.derived.producerRole === null || c.derived.producerRole === undefined)
    : false

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <PageHeader
        testId="silo-review-header"
        crumbs={[silosCrumb(changePage), siloCrumb(changePage, siloId, c?.name ?? siloLabel)]}
        seal={<SiloSeal />}
        // the question the dialog asks is its title; its answer, once given
        title={rejected ? 'Not installed' : missing ? 'Nothing waits for you' : c ? dialogTitle(c) : <span className="text-ink-3">Reading…</span>}
        facts={
          c && !rejected ? (
            <>
              <Fact className="text-terracotta">waiting for you</Fact>
              <Fact truncate>
                <span className="min-w-0 truncate">{submittedWords(c)}</span>
              </Fact>
              {c.at ? <Fact>{relTime(Date.parse(c.at), nowTick)}</Fact> : null}
            </>
          ) : null
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[56rem] px-4 pb-6 pt-1 sm:px-5">
          {rejected ? (
            <div className="mt-5 max-w-[62ch]" data-testid="silo-review-rejected">
              <p className="text-[14px] text-ink">
                You rejected {rejected.name}. Nothing of it was installed
                {rejected.told ? (
                  <>
                    ; {rejected.told} was told{rejected.reason ? <> — «{rejected.reason}»</> : null}
                  </>
                ) : null}
                .
              </p>
              <button
                type="button"
                onClick={() => {
                  changePage(null)
                  useStore.setState({ mobileView: 'chat' })
                }}
                className="mt-4 font-mono text-[11.5px] text-ink-2 underline-offset-2 hover:text-terracotta hover:underline"
              >
                ‹ Home
              </button>
            </div>
          ) : missing ? (
            <div className="mt-5 max-w-[62ch]">
              <p className="text-[14px] text-ink">
                Nothing of <span className="font-mono">{siloId}</span> waits for your approval — it was decided already, or never submitted.
              </p>
              <button
                type="button"
                onClick={() => changePage({ kind: 'silo', id: siloId })}
                className="mt-3 font-mono text-[11.5px] text-ink-2 underline-offset-2 hover:text-terracotta hover:underline"
              >
                the silo’s page ›
              </button>
            </div>
          ) : c ? (
            <>
              {error ? (
                <div role="alert" className="mt-4 rounded-lg border border-terracotta/40 bg-terracotta-soft px-3 py-2 text-[12.5px] text-ink">
                  {error}
                </div>
              ) : null}

              {/* what it will show you — the preview, rendered: the owner
                  approves what they will SEE, not a list of nouns */}
              <section className="mt-7" aria-label="What it will show you">
                <SectionLabel>What it will show you</SectionLabel>
                {c.derived.preview ? (
                  <p className="mt-2 font-mono text-[11px] text-ink-3" data-testid="silo-review-basis">
                    {c.derived.preview.basis}
                  </p>
                ) : null}
                <div className="mt-2 rounded-xl border border-line bg-panel px-4 divide-y divide-line/70" data-testid="silo-review-preview">
                  {c.derived.slots.map((s) => (
                    <SlotSpecimen key={s.slot} c={c} slot={s.slot} says={s.says} off={s.off === true} />
                  ))}
                  {c.derived.preview?.list ? (
                    <div className="grid grid-cols-1 gap-x-6 gap-y-1 py-3 sm:grid-cols-[11rem_1fr]">
                      <span className="font-mono text-[11px] text-ink-3 sm:pt-0.5">Its page, a row</span>
                      <p className="min-w-0 break-words font-mono text-[12px] text-ink-2">{c.derived.preview.list}</p>
                    </div>
                  ) : null}
                  {c.derived.slots.length === 0 && !c.derived.preview?.list ? (
                    <p className="py-3 text-[13px] text-ink-3">It asks for no place on Home — only its own page.</p>
                  ) : null}
                </div>
              </section>

              {/* the look it brings (spec.theme), drawn from what the kernel
                  resolved — approving makes it a choice, nothing changes */}
              {c.derived.look ? (
                <section className="mt-7" aria-label="What it brings" data-testid="silo-review-look">
                  <SectionLabel>What it brings</SectionLabel>
                  <p className="mt-2 max-w-[62ch] text-[13.5px] text-ink">
                    {c.derived.look.name ? (
                      <>
                        A look, <strong className="font-semibold">{c.derived.look.name}</strong>. Approving adds it to Settings › Appearance beside the built-in
                        looks; nothing changes on screen until someone chooses it, in their own browser.
                      </>
                    ) : (
                      sentence(c.derived.look.says)
                    )}
                  </p>
                  {c.derived.look.light && c.derived.look.dark && c.derived.look.name ? (
                    <div className="mt-4">
                      <LookPair siloId={c.id} decl={{ name: c.derived.look.name, light: c.derived.look.light, dark: c.derived.look.dark }} values />
                    </div>
                  ) : null}
                </section>
              ) : null}

              {lookOnly ? null : (
                <>
                  {/* the exact paths it reads, and what is there today */}
                  <section className="mt-7" aria-label="What it reads">
                    <SectionLabel>What it reads</SectionLabel>
                    {c.derived.reads.length === 0 ? (
                      <p className="mt-2 max-w-[62ch] text-[13.5px] text-ink-2">
                        No files and no records — an edge-only silo keeps the relations you draw, and Silos holds them.
                      </p>
                    ) : null}
                    <ul className="mt-2 flex flex-col gap-3">
                      {c.derived.reads.map((r) => (
                        <ReadsOf key={r.source} r={r} />
                      ))}
                    </ul>
                  </section>

                  {/* who writes it: the role bound to real agents; what each needs */}
                  <section className="mt-7" aria-label="Who writes it">
                    <SectionLabel>Who writes it</SectionLabel>
                    <p className="mt-2 max-w-[62ch] text-[13.5px] text-ink">
                      {c.derived.producerRole === null || c.derived.producerRole === undefined ? (
                        'Nobody writes it but you: it keeps only the relations you draw on its page once it is installed — no agent writes them, and there is nobody to bind.'
                      ) : c.derived.producerRole === KERNEL_PRODUCER ? (
                        'Silos itself keeps these records — kernel data, read-only. No agent writes them and there is nobody to bind.'
                      ) : c.derived.bindsTo === 'protocol' ? (
                        <>
                          Silos keeps its records itself. The agents you bind work in <strong className="font-semibold">{c.derived.producerRole}</strong>: they
                          get its instructions when they start and Silos wakes them on their tasks; the rest keep working as today. You can bind nobody now and
                          change it later on its page.
                        </>
                      ) : c.derived.producerRole === 'any-agent' ? (
                        'Any agent may write its records. Bind agents to give them its instructions at start.'
                      ) : (
                        <>
                          It asks for a <strong className="font-semibold">{c.derived.producerRole}</strong> to write its records. The agents you bind get its
                          instructions when they start; the rest get a one-line pointer.
                        </>
                      )}
                    </p>
                    {c.derived.producerRole !== KERNEL_PRODUCER && c.derived.producerRole ? (
                      <fieldset className="mt-2.5 flex flex-wrap gap-2" aria-label="Producers">
                        {choices.map((a) => {
                          const on = chosen?.includes(a.id) ?? false
                          return (
                            <label
                              key={a.id}
                              className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1 text-[12.5px] focus-within:ring-2 focus-within:ring-terracotta/40 ${on ? 'border-terracotta/50 bg-terracotta-soft text-ink' : 'border-line text-ink-2 hover:border-ink-3'}`}
                            >
                              <input type="checkbox" className="sr-only" checked={on} onChange={() => toggle(a.id)} aria-label={`Bind ${a.name}`} />
                              <span aria-hidden="true">{a.emoji}</span>
                              <span>{a.name}</span>
                              {a.proposed ? <span className="font-mono text-[10px] text-ink-3">proposed</span> : null}
                            </label>
                          )
                        })}
                      </fieldset>
                    ) : null}
                    {c.derived.requirements.length > 0 ? (
                      <ul className="mt-3 flex flex-col gap-1" data-testid="silo-review-requirements">
                        {c.derived.requirements.map((r) => (
                          <li key={r.what} className="flex items-baseline gap-2 text-[12.5px]">
                            <span aria-hidden="true" className={`translate-y-[1px] ${r.met === false ? 'text-terracotta' : 'text-ink-3'}`}>
                              {r.met === false ? <X size={12} /> : r.met ? <Check size={12} /> : <HelpCircle size={12} />}
                            </span>
                            <span className={r.met === false ? 'text-ink' : 'text-ink-2'}>{r.what}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    {auto ? (
                      <div className="mt-4 rounded-xl border border-line px-4 py-3" data-testid="silo-review-automation">
                        <label className="flex cursor-pointer items-start gap-3">
                          <input
                            type="checkbox"
                            checked={automation}
                            onChange={(e) => setAutomation(e.target.checked)}
                            disabled={!auto.cron || !auto.agentId}
                            className="mt-1 accent-[var(--terracotta)]"
                          />
                          <span className="min-w-0">
                            <span className="block text-[13.5px] text-ink">
                              Also create the automation <strong className="font-semibold">{auto.name}</strong>
                            </span>
                            <span className="block font-mono text-[11px] text-ink-2">
                              {auto.says}
                              {auto.agentId ? ` · run by ${autoAgent?.name ?? auto.agentId}` : ' · no agent bound to run it'}
                            </span>
                          </span>
                        </label>
                        <div className="mt-2 pl-7">
                          <p className="text-[12.5px] text-ink-2">It would ask: «{promptGist(auto.prompt)}»</p>
                          <button
                            type="button"
                            onClick={() => setPromptOpen((v) => !v)}
                            className="mt-1 font-mono text-[11px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
                          >
                            {promptOpen ? 'hide the whole prompt' : 'show the whole prompt'}
                          </button>
                          {promptOpen ? (
                            <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-panel px-3 py-2 font-mono text-[11px] text-ink-2">
                              {auto.prompt}
                            </pre>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </section>
                </>
              )}

              {/* an update: what changes, each loosening on its own line */}
              {c.derived.update ? (
                <section className="mt-7" aria-label="What changes">
                  <SectionLabel>What changes</SectionLabel>
                  <ul className="mt-2 flex flex-col gap-1">
                    {c.derived.update.loosening.map((l) => (
                      <li key={l} className="flex items-baseline gap-2 text-[13px] text-ink" data-testid="silo-review-loosening">
                        <span aria-hidden="true" className="font-mono text-[11px] text-terracotta">
                          +
                        </span>
                        {l}
                      </li>
                    ))}
                    {c.derived.update.lines.map((l) => (
                      <li key={l} className="flex items-baseline gap-2 text-[13px] text-ink-2">
                        <span aria-hidden="true" className="font-mono text-[11px] text-ink-3">
                          ·
                        </span>
                        {l}
                      </li>
                    ))}
                    {c.derived.update.loosening.length === 0 ? <li className="font-mono text-[11px] text-ink-3">nothing it may do widens</li> : null}
                    {/* an update keeps the owner's off (server installer.ts):
                        said before the approval, which lands on its page */}
                    {c.derived.update.says ? (
                      <li className="mt-1 text-[13px] text-ink" data-testid="silo-review-stays-off">
                        {c.derived.update.says.charAt(0).toUpperCase() + c.derived.update.says.slice(1)}
                      </li>
                    ) : null}
                  </ul>
                </section>
              ) : null}

              {/* what Silos noticed and does not refuse */}
              {c.derived.notes.length > 0 || c.derived.wants.length > 0 ? (
                <ul className="mt-5 flex flex-col gap-0.5 font-mono text-[11px] text-ink-3">
                  {c.derived.wants.length > 0 ? (
                    <li>
                      loads without {c.derived.wants.length} field{c.derived.wants.length === 1 ? '' : 's'} this Silos does not know yet:{' '}
                      {c.derived.wants.join(', ')}
                    </li>
                  ) : null}
                  {c.derived.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              ) : null}

              {/* the author's prose — a quote, set apart, never authority */}
              {description || summary || protocol.length > 0 || said?.sync ? (
                <section className="mt-8" aria-label="In the author's words">
                  <SectionLabel>{`In ${author} words`}</SectionLabel>
                  <p className="mt-1.5 font-mono text-[10.5px] text-ink-3">quoted as written — Silos shows it and acts only on what it derived above</p>
                  <blockquote
                    className="mt-3 border-l-2 border-line pl-4 font-display text-[14.5px] leading-relaxed text-ink-2"
                    data-testid="silo-review-author"
                  >
                    {description ? <p>{description}</p> : null}
                    {summary ? <p className="mt-2">{summary}</p> : null}
                    {protocol.length > 0 ? (
                      <ol className="mt-2 list-decimal pl-5">
                        {protocol.map((p) => (
                          <li key={p} className="mt-0.5">
                            {p}
                          </li>
                        ))}
                      </ol>
                    ) : null}
                    {said?.sync ? (
                      <div className="mt-3">
                        <p className="text-ink">Its sync{service ? ` with ${service}` : ''} promises:</p>
                        {contract.length > 0 ? (
                          <ul className="mt-1 list-disc pl-5">
                            {contract.map((l) => (
                              <li key={l} className="mt-0.5">
                                {l}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {said.sync.stateMap != null ? (
                          <>
                            <button
                              type="button"
                              onClick={() => setStateMapOpen((v) => !v)}
                              className="mt-1.5 font-mono text-[11px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
                            >
                              {stateMapOpen ? 'hide its state map' : 'show its state map'}
                            </button>
                            {stateMapOpen ? (
                              <pre className="mt-1 overflow-x-auto rounded-lg bg-panel px-3 py-2 font-mono text-[11px] not-italic">
                                {JSON.stringify(said.sync.stateMap, null, 2)}
                              </pre>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </blockquote>
                </section>
              ) : null}
            </>
          ) : error ? (
            <div role="alert" className="mt-4 text-[13px] text-terracotta">
              {error}
            </div>
          ) : null}
        </div>

        {/* the decision — sticky at the foot, its blockers said in words */}
        {c && !rejected && !missing ? (
          <div className="sticky bottom-0 border-t border-line bg-canvas/95 backdrop-blur-sm" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
            <div className="max-w-[56rem] px-4 py-3 sm:px-5">
              {rejecting ? (
                <div className="flex flex-col gap-2">
                  <label className="text-[12.5px] text-ink-2" htmlFor="silo-reject-reason">
                    Why not? <span className="text-ink-3">(optional{c.submittedBy !== 'owner' ? ` — ${c.submittedBy} is told` : ''})</span>
                  </label>
                  <textarea
                    id="silo-reject-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={2}
                    maxLength={500}
                    className="w-full max-w-[62ch] resize-none rounded-lg border border-line bg-panel px-3 py-2 text-[13px] text-ink outline-none focus:border-terracotta/60"
                  />
                  <div className="flex items-center gap-4">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void reject()}
                      className="rounded-full border border-line px-3.5 py-1 text-[12.5px] font-medium text-ink hover:border-terracotta hover:text-terracotta disabled:opacity-50"
                    >
                      Reject {c.name ?? c.id}
                    </button>
                    <button type="button" onClick={() => setRejecting(false)} className="text-[12px] text-ink-2 hover:text-ink">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <button
                    type="button"
                    disabled={busy || blockers.length > 0 || chosen === null}
                    onClick={() => void approve()}
                    className="rounded-full bg-terracotta px-4 py-1.5 text-[13px] font-medium text-on-terracotta hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {verb} {c.name ?? c.id}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRejecting(true)}
                    className="text-[12.5px] text-ink-2 underline-offset-2 hover:text-terracotta hover:underline"
                  >
                    Reject…
                  </button>
                  {blockers.length > 0 ? (
                    <p className="w-full text-[12px] text-ink-2 sm:w-auto sm:flex-1" data-testid="silo-review-blockers">
                      Not yet: {blockers.join('; ')}
                    </p>
                  ) : automation && auto ? (
                    <p className="w-full font-mono text-[11px] text-ink-3 sm:w-auto sm:flex-1">with its automation, {auto.says}</p>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
