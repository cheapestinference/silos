// digest.ts — the daily digest band on Home, in words.
// The server composed the counts (server/src/digest.ts) and summed the unread
// digests into one band; this file only says them. Counts and real rows,
// never prose that invents: a block with nothing to say is left out.
import type { DigestBand } from './types'

export interface DigestWords {
  title: string // «This morning» · «Yesterday morning» · «Since Friday 08:00»
  since: string | null // «since yesterday 08:00» (one digest only — a summed band's title already says it)
  waits: string
  happened: string[]
  coming: string[] | null // null: no silo declares a due date
}

const pad = (n: number): string => String(n).padStart(2, '0')
export const hhmm = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const dayKey = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// today · yesterday · Friday (within the week) · Oct 12
export function dayWord(ms: number, now: number): string {
  const start = (t: number): number => {
    const d = new Date(t)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const days = Math.round((start(now) - start(ms)) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return new Date(ms).toLocaleDateString('en-US', { weekday: 'long' })
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const words = (n: number): string => (n >= 0 && n < 10 ? ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][n]! : String(n))
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)

function list(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

export function digestWords(band: DigestBand, now: number, nameOf: (agentId: string, fallback: string) => string): DigestWords {
  const from = Date.parse(band.from)
  const to = Date.parse(band.to)
  const single = band.dates.length === 1
  const title =
    single && band.through === dayKey(now)
      ? 'This morning'
      : single && band.through === dayKey(now - 86_400_000)
        ? 'Yesterday morning'
        : `Since ${dayWord(from, now)} ${hhmm(from)}`
  const since = single ? `since ${dayWord(from, now)} ${hhmm(from)}` : null

  // what waited at the hour — past tense: the live inbox is right below
  const w = band.waits
  const loud = w.blocking + w.due
  let waits = loud === 0 ? `At ${hhmm(to)} nothing waited on you.` : `At ${hhmm(to)} ${loud === 1 ? 'one thing' : `${words(loud)} things`} needed you`
  if (loud > 0) {
    waits += w.blocking > 0 && w.due > 0 ? ` (${w.blocking} blocking)` : ''
    waits += w.oldest ? ` — the oldest since ${dayWord(Date.parse(w.oldest.at), now)} ${hhmm(Date.parse(w.oldest.at))}: ${w.oldest.voice}.` : '.'
  }
  // the task lines beside them, said as the server says them, never counted as waits
  const lines = (w.lines ?? []).filter((l) => l.count > 0 && typeof l.voice === 'string' && l.voice.trim() !== '')
  if (lines.length > 0) waits += ` ${lines.map((l) => l.voice.trim()).join('; ')}.`

  const h = band.happened
  const happened: string[] = []
  const conv = h.conversations.reduce((n, c) => n + c.count, 0)
  if (conv > 0) {
    const per = h.conversations.map((c) => `${nameOf(c.agentId, c.name)} ${c.count}`)
    happened.push(
      `${plural(conv, 'conversation')} of yours finished${h.conversations.length > 1 ? ` — ${list(per)}` : ` with ${nameOf(h.conversations[0]!.agentId, h.conversations[0]!.name)}`}.`,
    )
  }
  // messages each worked in a conversation of its own (origin message) —
  // HISTORY: a saved digest may carry them, no new one does (no message
  // wakes anyone); their own line, never counted as conversations
  const msgs = h.messages ?? []
  const worked = msgs.reduce((n, m) => n + m.count, 0)
  if (worked > 0) {
    happened.push(
      msgs.length === 1
        ? `${nameOf(msgs[0]!.agentId, msgs[0]!.name)} worked on ${plural(worked, 'message')} in conversations of their own.`
        : `${plural(worked, 'message')} worked in conversations of their own — ${msgs.map((m) => `${nameOf(m.agentId, m.name)} ${m.count}`).join(', ')}.`,
    )
  }
  const sum = (f: (r: DigestBand['happened']['runs'][number]) => number): number => h.runs.reduce((n, r) => n + f(r), 0)
  const runs = sum((r) => r.runs)
  if (runs > 0) {
    const acted = sum((r) => r.acted)
    const noNews = sum((r) => r.noNews)
    const failed = sum((r) => r.failed)
    const recovered = sum((r) => r.recovered)
    const parts = [
      acted > 0 ? `acted ${times(acted)}` : '',
      noNews > 0 ? `${noNews} with no news` : '',
      failed > 0 ? `${failed} failed` : '',
      recovered > 0 ? `${recovered} failed and recovered on ${recovered === 1 ? 'its' : 'their'} own` : '',
    ].filter(Boolean)
    const who = h.runs.length === 1 ? `${nameOf(h.runs[0]!.agentId, h.runs[0]!.name)}'s automations` : 'Automations'
    const per = h.runs.length > 1 ? ` (${h.runs.map((r) => `${nameOf(r.agentId, r.name)} ${r.runs}`).join(', ')})` : ''
    happened.push(`${who} ran ${times(runs)}${per}${parts.length > 0 ? ` — ${list(parts)}` : ''}.`)
  }
  if (h.planTasksDone !== null && h.planTasksDone > 0) happened.push(`${plural(h.planTasksDone, 'plan task')} done.`)
  const bySilo = new Map<string, { name: string; parts: string[] }>()
  for (const s of h.silos) {
    const e = bySilo.get(s.silo) ?? { name: s.siloName, parts: [] }
    e.parts.push(`${s.count} ${s.label}`)
    bySilo.set(s.silo, e)
  }
  for (const s of bySilo.values()) happened.push(`${s.name}: ${list(s.parts)}.`)
  if (happened.length === 0) happened.push('Nothing finished since then.')

  const coming =
    band.coming === null
      ? null
      : band.coming.length === 0
        ? ['Nothing falls due in the next 7 days.']
        : band.coming.map(
            (c) =>
              `${c.siloName}: ${plural(c.count, c.kind)} due in the next 7 days — the first on ${new Date(Date.parse(c.firstDue)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: /^\d{4}-\d{2}-\d{2}$/.test(c.firstDue) ? 'UTC' : undefined })}.`,
          )

  return { title, since, waits, happened, coming }
}
