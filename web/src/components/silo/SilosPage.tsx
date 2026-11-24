// SilosPage — Settings › Silos (/settings/silos), the QUIET inventory of
// dimensions (low-key on purpose; one address —
// the old /silos is gone). Three groups, parent of /silo/<id>, by where each
// silo stands in what Silos ships (lib/silo-settings.ts): Recommended (what
// Silos installs for you), Optional (what it ships for the asking, with
// «Install…»), Installed by you — each tile saying its moment (active with
// its live pulse term, waiting for approval, not installed, uninstalled with
// what stayed on disk) — and the «Install a silo…» door at the foot. Every
// gesture here only SUBMITS (resubmit, catalog, paste) and hands over to the
// dialog at /silo/<id>/review: nothing is decided on this page.
// Doors: the line under Home's pulse, the pulse names themselves, every silo
// page's «Silos» crumb, ⌘K «Settings › Silos», and the quiet SiloDoor.
import { useEffect, useState, type ReactNode } from 'react'
import { useStore } from '../../store'
import { api, ApiError } from '../../lib/api'
import {
  groupSilos,
  groupSize,
  installedFacts,
  stateWord,
  waitingAction,
  waitingFacts,
  uninstalledFacts,
  uninstalledAction,
  type SiloGroup,
} from '../../lib/silo-settings'
import { Tile, TileGrid } from '../Tile'
import type { SiloAvailable, SiloDescriptor, SiloPulseTerm, SiloUninstalled } from '../../lib/types'

// the quiet primitives, same voice as Settings' reading column
function Group({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-8 border-t border-line pt-6">
      <header className="mb-3">
        <h3 className="font-display text-[16px] leading-tight text-ink">{title}</h3>
        {description ? <p className="mt-0.5 max-w-prose text-[12.5px] leading-relaxed text-ink-2">{description}</p> : null}
      </header>
      <div className="text-sm text-ink-2">{children}</div>
    </section>
  )
}
function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 border-t border-line py-2.5 first:border-t-0 first:pt-0">
      <div className="min-w-0">
        <div className="text-sm text-ink">{label}</div>
        {hint ? <div className="mt-0.5 text-xs leading-relaxed text-ink-2">{hint}</div> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  )
}
const QUIET_BTN =
  'rounded-md border border-line bg-panel px-2.5 py-1 text-xs font-medium text-ink transition-colors duration-150 hover:border-ink-2 disabled:opacity-50'

// inside Settings' column — Settings carries the title bar and the nav
export function SilosPage() {
  const changePage = useStore((s) => s.changePage)
  const siloTick = useStore((s) => s.siloTick)
  const [data, setData] = useState<{ silos: SiloDescriptor[]; uninstalled?: SiloUninstalled[]; available?: SiloAvailable[] } | null | 'error'>(null)
  // each active silo's live pulse term — the inventory breathes a little
  const [pulse, setPulse] = useState<readonly SiloPulseTerm[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<{ id: string; text: string } | null>(null)
  // the «Install a silo…» door: a pasted manifest becomes a normal submission
  const [doorOpen, setDoorOpen] = useState(false)
  const [doorText, setDoorText] = useState('')
  const [doorBusy, setDoorBusy] = useState(false)
  const [doorError, setDoorError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.resolve(api.silos.list())
      .then((r) => {
        if (!cancelled) setData(r)
      })
      .catch(() => {
        if (!cancelled) setData('error')
      })
    Promise.resolve(api.board())
      .then((b) => {
        if (!cancelled) setPulse(b.silos?.pulse ?? [])
      })
      .catch(() => {
        /* no term, the facts line stands alone */
      })
    return () => {
      cancelled = true
    }
  }, [siloTick])

  const review = (id: string): void => changePage({ kind: 'silo', id, review: true })
  async function submit(id: string): Promise<void> {
    setBusy(id)
    setFailed(null)
    try {
      await api.silos.resubmit(id)
      review(id)
    } catch (e) {
      // one submission per id: one already waiting is the dialog to open
      if (e instanceof ApiError && e.status === 409 && typeof e.body === 'object' && e.body !== null && 'submission' in e.body) review(id)
      else setFailed({ id, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }
  // installing from the catalog: same landing as every submission
  async function install(id: string): Promise<void> {
    setBusy(id)
    setFailed(null)
    try {
      await api.silos.installAvailable(id)
      review(id)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && typeof e.body === 'object' && e.body !== null && 'submission' in e.body) review(id)
      else setFailed({ id, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }
  // the pasted manifest: parse here (a JSON typo is said in place), validate
  // on the server (its exact words come back), land on the review dialog
  async function submitDoor(): Promise<void> {
    let manifest: unknown
    try {
      manifest = JSON.parse(doorText)
    } catch (e) {
      setDoorError(`That is not JSON yet — ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    setDoorBusy(true)
    setDoorError(null)
    try {
      const r = await api.silos.submitManifest(manifest)
      setDoorOpen(false)
      setDoorText('')
      review(r.submission.id)
    } catch (e) {
      if (e instanceof ApiError && typeof e.body === 'object' && e.body !== null) {
        const b = e.body as { error?: string; submission?: { id?: string }; validation?: { errors?: Array<{ where?: string; message?: string }> } }
        if (e.status === 409 && typeof b.submission?.id === 'string') {
          review(b.submission.id)
          return
        }
        const lines = (b.validation?.errors ?? [])
          .slice(0, 4)
          .map((x) => `${x.where ? `${x.where}: ` : ''}${x.message ?? ''}`)
          .filter((s) => s !== '')
        setDoorError(lines.length > 0 ? lines.join('\n') : (b.error ?? e.message))
      } else setDoorError(e instanceof Error ? e.message : String(e))
    } finally {
      setDoorBusy(false)
    }
  }

  const body = (children: ReactNode): ReactNode => (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-[60rem] px-6 pb-16 pt-8 md:px-10">
          <h2 className="font-display text-[19px] leading-tight text-ink">Silos</h2>
          <p className="mt-1 max-w-[62ch] text-[13px] text-ink-2">
            Install, review and retire the silos of this Silos. The ones in use live on Home, each with its tile.
          </p>
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </div>
  )

  if (data === null) return body(<p>Loading…</p>)
  if (data === 'error') return body(<p>The silo registry could not be read.</p>)
  const g = groupSilos(data.silos, data.uninstalled, data.available ?? [])
  const failure = (id: string): ReactNode =>
    failed?.id === id ? (
      <span role="alert" className="mt-1 block text-terracotta">
        {failed.text}
      </span>
    ) : null
  const name = (x: { id: string; name: string | null }): string => x.name ?? x.id
  const termOf = (id: string): string | null => pulse.find((t) => t.silo === id)?.term ?? null

  // every silo is a tile that says its moment in its name line — installed
  // (opens its page), waiting for you, uninstalled, on offer
  const tiles = (x: SiloGroup): ReactNode[] => [
    ...x.installed.map((d) => (
      <Tile
        key={d.id}
        testId={`silo-installed-${d.id}`}
        name={stateWord(d)}
        accent={d.state !== 'active'}
        door="Open"
        onOpen={() => changePage({ kind: 'silo', id: d.id })}
        lead={name(d)}
      >
        {termOf(d.id) ? <span className="block text-[14px] text-ink">{termOf(d.id)}</span> : null}
        <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-2">{installedFacts(d)}</span>
      </Tile>
    )),
    ...x.waiting.map((d) => {
      const act = waitingAction(d)
      return (
        <Tile key={d.id} testId={`silo-waiting-${d.id}`} name="Waiting for approval" live lead={name(d)}>
          <span className="block text-[12.5px] leading-snug text-ink-2">
            {waitingFacts(d)}
            {act.kind === 'none' ? <span className="mt-0.5 block">{act.says}</span> : null}
            {failure(d.id)}
          </span>
          <span className="mt-3 flex items-center gap-2">
            {act.kind === 'review' ? (
              <button type="button" onClick={() => review(d.id)} className={QUIET_BTN}>
                Review…
              </button>
            ) : null}
            {act.kind === 'submit' ? (
              <button type="button" disabled={busy === d.id} onClick={() => void submit(d.id)} className={QUIET_BTN}>
                {busy === d.id ? 'Submitting…' : 'Submit for approval…'}
              </button>
            ) : null}
            <button type="button" onClick={() => changePage({ kind: 'silo', id: d.id })} className="text-xs text-ink-2 hover:text-terracotta">
              Open ›
            </button>
          </span>
        </Tile>
      )
    }),
    ...x.available.map((a) => (
      <Tile key={a.id} testId={`silo-available-${a.id}`} name={`Not installed${a.version ? ` · ${a.version}` : ''}`} lead={a.name ?? a.id}>
        {a.description ? <span className="line-clamp-3 block text-[12.5px] leading-snug text-ink-2">{a.description}</span> : null}
        {failure(a.id)}
        <span className="mt-3 flex">
          <button type="button" disabled={busy === a.id} onClick={() => void install(a.id)} className={QUIET_BTN}>
            {busy === a.id ? 'Submitting…' : 'Install…'}
          </button>
        </span>
      </Tile>
    )),
    ...x.uninstalled.map((u) => {
      const act = uninstalledAction(u)
      return (
        <Tile key={u.id} testId={`silo-uninstalled-${u.id}`} name="Uninstalled" quiet lead={u.name}>
          {/* a recommended one says what is missing while it is out */}
          {u.loses ? <span className="block text-[12.5px] leading-snug text-ink">{u.loses}</span> : null}
          <span className="block text-[12.5px] leading-snug text-ink-2">
            {uninstalledFacts(u)}
            {act.kind !== 'reinstall' ? <span className="mt-0.5 block">{act.says}</span> : null}
            {failure(u.id)}
          </span>
          <span className="mt-3 flex">
            {act.kind === 'review' ? (
              <button type="button" onClick={() => review(u.id)} className={QUIET_BTN}>
                Review…
              </button>
            ) : null}
            {act.kind === 'reinstall' ? (
              <button type="button" disabled={busy === u.id} onClick={() => void submit(u.id)} className={QUIET_BTN}>
                {busy === u.id ? 'Submitting…' : `Reinstall${act.version ? ` ${act.version}` : ''}…`}
              </button>
            ) : null}
          </span>
        </Tile>
      )
    }),
  ]

  return body(
    <>
      {/* three groups by where a silo stands in what Silos ships — never by
          how it is doing: what Silos installs for you, what it offers, and
          what you brought. Silos is built of silos; each is removable */}
      {groupSize(g.recommended) > 0 ? (
        <Group
          title="Recommended"
          description="Silos installs these for you — tasks, agents that work on their own, and what your conversations leave running. Each can be removed from its page, which says what you would lose."
        >
          <TileGrid cols={2}>{tiles(g.recommended)}</TileGrid>
        </Group>
      ) : null}
      {groupSize(g.optional) > 0 ? (
        <Group title="Optional" description="Ways of working Silos ships for the asking. Install one when you need it; it asks for your approval first.">
          <TileGrid cols={2}>{tiles(g.optional)}</TileGrid>
        </Group>
      ) : null}
      <Group title="Installed by you" description="Silos you or your agents brought — each arrived as a manifest and waited for your approval.">
        {groupSize(g.yours) === 0 ? (
          <p className="text-[12.5px] text-ink-2">None yet. An agent can draft one for you, or you paste a manifest below.</p>
        ) : (
          <TileGrid cols={2}>{tiles(g.yours)}</TileGrid>
        )}
      </Group>
      <Group
        title="Install a silo"
        description="Paste a silo.json (or pick the file). It lands as a submission — the review dialog says what it would read and show before you approve anything."
      >
        {doorOpen ? (
          <div className="max-w-[62ch]">
            <textarea
              value={doorText}
              onChange={(e) => {
                setDoorText(e.target.value)
                setDoorError(null)
              }}
              placeholder='{"apiVersion": "silo-standard/v0", "metadata": { "id": "…" }, …}'
              spellCheck={false}
              rows={10}
              className="w-full rounded-lg border border-line bg-panel px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-ink-3"
              data-testid="silo-door-text"
            />
            {doorError ? (
              <p role="alert" className="mt-1 whitespace-pre-line text-[12.5px] text-terracotta" data-testid="silo-door-error">
                {doorError}
              </p>
            ) : null}
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                disabled={doorBusy || doorText.trim() === ''}
                onClick={() => void submitDoor()}
                className={QUIET_BTN}
                data-testid="silo-door-submit"
              >
                {doorBusy ? 'Submitting…' : 'Submit for review…'}
              </button>
              <label className={`${QUIET_BTN} cursor-pointer`}>
                Pick a file…
                <input
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f)
                      void f.text().then((t) => {
                        setDoorText(t)
                        setDoorError(null)
                      })
                  }}
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  setDoorOpen(false)
                  setDoorError(null)
                }}
                className="text-xs text-ink-3 hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <Row label="A silo.json you wrote or were given" hint="Nothing activates on paste — it only becomes a pending submission.">
            <button type="button" onClick={() => setDoorOpen(true)} className={QUIET_BTN} data-testid="silo-door-open">
              Install a silo…
            </button>
          </Row>
        )}
      </Group>
    </>,
  )
}
