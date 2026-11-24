import type { FenceScope } from '../lib/types'

// What an agent's fence covers, in places — read back by the server from
// the very rules both engines launch with (territory.ts fenceScope). One
// row per band: where it works, what it may only read, what it is kept out
// of, and how it meets the API. Shared by Settings › Territory
// (`kept` off: the common part is said once above the list) and the
// agent's Settings, its territory (`kept` on: the whole picture for one agent).

const KEPT_LABEL: Record<FenceScope['blocked'][number]['kind'], string> = {
  silos: "Silos' own data",
  claude: 'Claude login, settings & memory',
  agents: "other agents' state",
  private: '',
}

/** The kept-out groups as phrases; private paths stay literal. */
type Phrase = { text: string; mono: boolean; title?: string }
export function keptOutPhrases(scope: FenceScope): Phrase[] {
  return scope.blocked.flatMap((b): Phrase[] =>
    b.kind === 'private' ? b.paths.map((p) => ({ text: p, mono: true })) : [{ text: KEPT_LABEL[b.kind], mono: false, title: b.paths.join('\n') }],
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="mt-1.5 text-ink-3 first:mt-0 sm:mt-0">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </>
  )
}

function Paths({ paths }: { paths: string[] }) {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
      {paths.map((p) => (
        <span key={p} className="break-all font-mono">
          {p}
        </span>
      ))}
    </span>
  )
}

/** `on` false: the agent is not fenced — the honest one-liner, and (with
 *  `preview`) what turning it on would keep it out of. `privateExceptions`:
 *  configured private paths this agent is NOT kept out of (it works inside
 *  or around one) — the only private-path news in the brief form. */
export function FenceScopeLines({
  scope,
  on,
  kept,
  preview = false,
  privateExceptions = [],
}: {
  scope: FenceScope
  on: boolean
  kept: boolean
  preview?: boolean
  privateExceptions?: string[]
}) {
  if (!on) {
    return (
      <div className="text-[12px] leading-relaxed text-ink-2" data-testid="fence-scope-off">
        <p>Its territory is off — it reads and writes everything you can (it still meets the API as itself).</p>
        {preview && scope.blocked.length > 0 ? (
          <p className="mt-1 text-ink-3">
            Fenced, it would be kept out of{' '}
            {keptOutPhrases(scope).map((k, i, all) => (
              <span key={k.text}>
                <span className={k.mono ? 'font-mono' : undefined} title={k.title}>
                  {k.text}
                </span>
                {i < all.length - 2 ? ', ' : i === all.length - 2 ? ' and ' : '.'}
              </span>
            ))}
          </p>
        ) : null}
      </div>
    )
  }
  const reads = scope.readOnly.map((p) => p.replace(/^.*\/context\//, 'context/'))
  return (
    <dl className="grid grid-cols-1 gap-x-3 text-[12px] leading-relaxed sm:grid-cols-[6.5rem_1fr] sm:gap-y-1" data-testid="fence-scope">
      <Row label="works in">
        <Paths paths={[...scope.works, ...(scope.state ? [scope.state] : [])]} />
      </Row>
      {reads.length > 0 ? (
        <Row label="reads only">
          <span title="Other roles' notes in the same project: it can read them, not change them">
            <Paths paths={reads} />
          </span>
        </Row>
      ) : null}
      {(scope.noChange ?? []).length > 0 ? (
        <Row label="can't change">
          <span title={(scope.noChange ?? []).join('\n')}>what its engine loads — skills, plugins, MCP and engine settings</span>
        </Row>
      ) : null}
      {kept ? (
        <Row label="kept out of">
          <span className="flex flex-wrap gap-x-3 gap-y-0.5">
            {keptOutPhrases(scope).map((k) => (
              <span key={k.text} className={k.mono ? 'font-mono' : undefined} title={k.title}>
                {k.text}
              </span>
            ))}
          </span>
        </Row>
      ) : privateExceptions.length > 0 ? (
        <Row label="also reaches">
          <span title="A private path it works inside, or around, stays open to it">
            <Paths paths={privateExceptions} />
          </span>
        </Row>
      ) : null}
      <Row label="API">as itself — the roster, its inbox, its automations</Row>
      {kept ? <Row label="commands">a plain cat is held too — a script or interpreter runs as you</Row> : null}
    </dl>
  )
}
