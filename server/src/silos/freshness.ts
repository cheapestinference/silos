// silos/freshness.ts — is a silo's data still coming in? (Silo Standard v0
// «Freshness»). A source declares `expects {cadence, producer}`;
// once its last write is older than the cadence, every slot of the silo says
// so — one term, composed only of what the disk says:
//
//   «no new invoices since Oct 28 · the Invoicing sync last wrote Oct 29, 08:00 UTC»
//   «never synced yet»            (a sync source that never wrote a record)
//   «nothing written yet»         (an agent source that never wrote one)
//
// The first date is the newest record's own moment (its envelope `at`), the
// second the newest file write. Several stale sources collapse into one term;
// owner changes waiting on records the sync no longer writes (overlay
// orphans) join it. A kernel source declares no cadence and is not judged.
import type { SiloReading } from './reader.js'
import type { OverlayOrphan } from './overlay.js'

export interface FreshnessSource {
  source: string
  cadence: string // '24h'
  producer: 'agent' | 'sync'
  lastWrite: string | null
  newestAt: string | null
  stale: boolean
}

export interface Freshness {
  stale: boolean // a source is past its cadence, or never wrote, or a kernel source's reads stopped
  term: string | null // the one sentence every slot says; null when fresh
  sources: FreshnessSource[] // only sources that declare a cadence
  orphans: number
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }
export function cadenceMs(cadence: string): number | null {
  const m = /^(\d+)(m|h|d)$/.exec(cadence)
  return m ? Number(m[1]) * UNIT_MS[m[2]!]! : null
}

// English plural of a kind name (kinds are English identifiers in the
// reference manifests: case, plan, invoice, document).
export function pluralOf(noun: string): string {
  if (/(s|x|z|ch|sh)$/.test(noun)) return `${noun}es`
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`
  return `${noun}s`
}

// 'Oct 29, 08:00 UTC'; a day-only value ('2026-10-28') stays a day: 'Oct 28'.
// The formatters are built once (toLocale*String builds one per call: a
// records page of a few hundred rows spent 100–150 ms there) — the
// same locales and options, so the same words.
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const HOUR_MINUTE = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
export function formatMoment(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const day = DAY.format(t)
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return day
  return `${day}, ${HOUR_MINUTE.format(t)} UTC`
}

// '20 min ago' · '3 h ago' · '2 d ago' — coarse on purpose: the term lands
// in the silo's status, and a finer clock would rewrite it every refresh.
export function formatAgo(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

function producerPhrase(manifest: Json, producer: 'agent' | 'sync'): string {
  const p = isObj(manifest.spec) && isObj(manifest.spec.producer) ? manifest.spec.producer : {}
  if (producer === 'sync' && isObj(p.sync) && typeof p.sync.service === 'string') return `the ${p.sync.service} sync`
  if (producer === 'sync') return 'the sync'
  const role = typeof p.role === 'string' ? p.role : ''
  return role === '' || role === 'any-agent' ? 'its producers' : role
}

export function freshnessOf(manifest: Json, reading: SiloReading, orphans: readonly OverlayOrphan[], now: number): Freshness {
  const spec = isObj(manifest.spec) ? manifest.spec : {}
  const kinds = isObj(spec.kinds) ? Object.keys(spec.kinds) : []
  const noun = kinds.length === 1 ? pluralOf(kinds[0]!) : 'records'
  const sources: FreshnessSource[] = []
  const terms: Array<{ text: string; age: number }> = []
  for (const s of (Array.isArray(spec.sources) ? spec.sources : []).filter(isObj)) {
    const expects = isObj(s.expects) ? s.expects : null
    if (!expects || typeof expects.cadence !== 'string') continue
    const ms = cadenceMs(expects.cadence)
    if (ms === null) continue
    const producer = expects.producer === 'sync' ? 'sync' : 'agent'
    const id = String(s.id)
    const seen = reading.sources[id] ?? { lastWrite: null, newestAt: null }
    const lastMs = seen.lastWrite ? Date.parse(seen.lastWrite) : null
    const stale = lastMs === null || now - lastMs > ms
    sources.push({ source: id, cadence: expects.cadence, producer, lastWrite: seen.lastWrite, newestAt: seen.newestAt, stale })
    if (!stale) continue
    if (lastMs === null) {
      terms.push({ text: producer === 'sync' ? 'never synced yet' : 'nothing written yet', age: Infinity })
    } else {
      const since = seen.newestAt ?? seen.lastWrite!
      terms.push({
        text: `no new ${noun} since ${formatMoment(since)} · ${producerPhrase(manifest, producer)} last wrote ${formatMoment(seen.lastWrite!)}`,
        age: now - lastMs,
      })
    }
  }
  // several stale sources: the stalest one speaks for all
  terms.sort((a, b) => b.age - a.age)
  const parts: string[] = []
  if (terms.length > 0)
    parts.push(terms.length === 1 ? terms[0]!.text : `${terms[0]!.text} (and ${terms.length - 1} more source${terms.length > 2 ? 's' : ''})`)
  if (orphans.length > 0)
    parts.push(
      `${orphans.length} owner change${orphans.length === 1 ? '' : 's'} wait${orphans.length === 1 ? 's' : ''} on ${orphans.length === 1 ? 'a record' : 'records'} the sync no longer writes`,
    )
  return { stale: terms.length > 0, term: parts.length > 0 ? parts.join(' · ') : null, sources, orphans: orphans.length }
}
