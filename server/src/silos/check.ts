// silos/check.ts — silo-check, the author's half of the install door (Silo
// Standard annex v0.x «Standalone silo-check»; conformance.md: «prints the same
// thing as the validator's text preview»). A third party iterates a silo.json in
// any editor and reads, before pasting it into /silos, exactly what the door
// will answer:
//
//   - not JSON → the parser's words with line and column (the paste door says
//     the same «not JSON yet» before it ever reaches the server);
//   - JSON → the REAL validator (validator.ts validateSilo — imported, never
//     re-implemented): every error in the standard's own words with its
//     position and its conformance check;
//   - an id Silos still serves natively (native.ts — static, the same on
//     every Silos) → the door's refusal in its own words, exit 1, even when
//     the manifest validates;
//   - valid → the consequences the install dialog derives, rendered as text:
//     the slots in the words Home will use (the validator's preview, from the
//     manifest's examples — there is no disk here), what it reads, who writes
//     it and what the actions let each side write, where needs-you rows go
//     (audience: producer-agent), the sync's cadence and proposed automation,
//     requirements, wants and notes, and the brief its producer is handed.
//
// Standalone: no registry, no reader, no server. What only an installed Silos
// knows (ids approved there before, whether the producer holds a token today,
// the records on its disk) is said as such, never guessed.
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { validateSilo, KERNEL_PRODUCER, type Preview, type ValidationResult } from './validator.js'
import { cronForCadence, slotsSay } from './installer.js'
import { kernelKind } from './kernel-kinds.js'
import { bindsThroughKernel, instructedElsewhere, producerBrief } from './producer-brief.js'
import { HOUSE_DIMENSIONS, type Dimensions } from './native.js'
import { closestPair, resolveTheme, sayRatio, THEME_MODES } from './theme-rule.js'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

export interface CheckOptions {
  now?: number // the clock the preview reads (`due < now`) — tests pin it
  schemaPath?: string
  // the dimensions that come with Silos (native.ts) — static knowledge of
  // every Silos: a native id is refused at the door in these words
  dimensions?: Dimensions
}

// What the install dialog would tell the owner, as lines of text.
export interface CheckPreview {
  title: string // «Install Invoices 0.1.0?»
  basis: Preview['basis']
  shows: Array<{ place: string; says: string }> // the slots, then the list row
  reads: string[]
  writes: string[]
  routing: string[] // needs-you entries that go to the producer, not the owner
  automation: string | null
  requirements: string[]
  wants: string[]
  notes: string[]
  brief: string | null // what a bound producer is handed at start; null for kernel data
  look: string[] // the look it brings (spec.theme): its name, its colours, its closest pair per mode
}

export interface CheckResult {
  ok: boolean
  findings: string[]
  preview?: CheckPreview
  validation?: ValidationResult // the validator's own answer, untouched
}

const SLOT_PLACE: Record<string, string> = {
  pulse: 'Home’s pulse',
  'needs-you': 'Needs you',
  rail: 'The rail',
  'agent-section': 'The producer’s page',
  'project-machinery': 'The project’s machinery',
  lens: 'A lens',
}

// The JSON parser's words, with the position as line and column — Node
// already says «(line L column C)» for most errors; added when it does not.
function jsonFinding(text: string, e: unknown): string {
  let msg = e instanceof Error ? e.message : String(e)
  const at = /at position (\d+)\b(?! \(line)/.exec(msg)
  if (at) {
    const pos = Number(at[1])
    const before = text.slice(0, pos).split('\n')
    msg += ` (line ${before.length} column ${before[before.length - 1]!.length + 1})`
  }
  if (/Unexpected end of JSON input/.test(msg)) msg += ' — the file ends before the JSON closes'
  return `That is not JSON yet — ${msg}`
}

export function checkSilo(raw: string, opts: CheckOptions = {}): CheckResult {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  if (text.trim() === '') return { ok: false, findings: ['The file is empty — a silo is one JSON object (apiVersion, metadata, spec)'] }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (e) {
    return { ok: false, findings: [jsonFinding(text, e)] }
  }
  const now = opts.now ?? Date.now()
  const v = validateSilo(value, { now, dimensions: opts.dimensions ?? HOUSE_DIMENSIONS, ...(opts.schemaPath ? { schemaPath: opts.schemaPath } : {}) })
  // a dimension Silos still serves natively: every Silos' door refuses its
  // id whatever the manifest says (the validator's check 2, which submit
  // answers 409) — said first, in the door's own words
  if (v.native !== undefined) {
    const id = (value as { metadata: { id: string } }).metadata.id
    const rest = v.errors.filter((e) => !(e.check === 2 && e.where === 'metadata.id' && e.message === v.native))
    return { ok: false, findings: [`${v.native} — the install door refuses the id ${JSON.stringify(id)}, on every Silos`, ...rest.map(finding)], validation: v }
  }
  if (!v.ok) return { ok: false, findings: v.errors.map(finding), validation: v }
  return { ok: true, findings: [], preview: previewOf(value as Json, v), validation: v }
}

// One validator error as a line: its position, its words (the schema's
// messages already open with the position — not said twice), its check.
function finding(e: ValidationResult['errors'][number]): string {
  const words = e.message.startsWith(`${e.where} `) ? e.message : `${e.where}: ${e.message}`
  return `${words} [conformance §${e.check}]`
}

function previewOf(m: Json, v: ValidationResult): CheckPreview {
  const meta = m.metadata as Json
  const spec = m.spec as Json
  const name = String(meta.name)
  const producer = isObj(spec.producer) ? spec.producer : {}
  const role = String(producer.role)
  const kernel = role === KERNEL_PRODUCER
  const preview = v.preview!

  // what it will show — the slots in the dialog's words, then its page's row
  const shows: CheckPreview['shows'] = []
  for (const s of slotsSay(m, preview)) {
    const place = SLOT_PLACE[s.slot] ?? s.slot
    if (s.slot === 'pulse') shows.push({ place, says: s.says ? `${name}: ${s.says}.` : 'no sentence yet' })
    else if (s.slot === 'needs-you') {
      for (const n of preview.needsYou) {
        const head = `${n.urgency}${n.audience === 'producer-agent' ? ' · goes to the producer, not you' : ''}`
        const body = n.row
          ? `${n.row}${n.matches > 1 ? ` (and ${n.matches - 1} more like it)` : ''}`
          : `nothing matches right now${n.sample ? ` — it would read like «${n.sample}»` : ''}`
        shows.push({ place: `${place} · ${head}`, says: body })
      }
    } else shows.push({ place, says: s.says ?? '—' })
  }
  if (preview.list) shows.push({ place: 'Its page, a row', says: preview.list })

  // what it reads — per source, with the cadence it promises
  const reads: string[] = []
  for (const s of Array.isArray(spec.sources) ? (spec.sources as Json[]) : []) {
    const conv = v.conventions.find((c) => c.source === s.id)?.convention ?? `${String(s.root)}:?`
    if (s.root === 'kernel') {
      const kk = kernelKind(String(s.kind))
      reads.push(`${conv} — ${kk ? kk.reads : `the kernel's ${String(s.kind)}`} (no files: Silos keeps these records)`)
      continue
    }
    const where = s.root === 'agent-state' ? `every agent's $SILOS_AGENT_STATE/${String(s.glob)}` : `${String(s.glob)} inside every project folder Silos knows`
    reads.push(`${conv} · ${String(s.parser)} — ${where}`)
    const ex = isObj(s.expects) ? s.expects : null
    if (ex) {
      const who = ex.producer === 'sync' ? 'a sync' : 'an agent'
      reads.push(
        isStr(ex.cadence)
          ? `  written by ${who}, at least every ${ex.cadence} — past that, every slot of the silo says its data is stale`
          : `  written by ${who}; no cadence declared, so it never reads as stale`,
      )
    }
  }

  // who writes it, and what the actions let each side write
  const writes: string[] = []
  const relations = (Array.isArray(spec.relations) ? spec.relations : []).filter(isObj)
  for (const r of relations)
    writes.push(
      `the owner draws ${String(r.name)} (${String(r.from)} → ${String(r.to)}${r.acyclic === true ? ', never a loop' : ''}) on its page — Silos keeps it; no agent writes it`,
    )
  if (!isObj(spec.producer)) {
    /* edge-only: no producer to bind */
  } else if (bindsThroughKernel(m))
    writes.push(
      `Silos itself keeps these records, about the agents the owner binds to ${role} — those agents get its instructions at start and write nothing in it`,
    )
  else if (kernel) writes.push('Silos itself keeps these records — kernel data, read-only. No agent writes them and there is nobody to bind.')
  else if (role === 'any-agent')
    writes.push(`any agent may write its records${isStr(producer.via) ? ` (via ${producer.via})` : ''} — the owner binds the ones who get its instructions`)
  else
    writes.push(
      `it asks for a ${role} to write its records — the owner binds one or more agents to that role when approving${isObj(producer.sync) ? `; it syncs from ${String((producer.sync as Json).service)}` : ''}`,
    )
  const actions = (Array.isArray(spec.actions) ? spec.actions : []).filter(isObj)
  const ownerWritable = new Set(
    Object.values(isObj(spec.kinds) ? spec.kinds : {})
      .filter(isObj)
      .flatMap((k) => (Array.isArray(k.ownerWritable) ? k.ownerWritable.filter(isStr) : [])),
  )
  for (const a of actions) {
    const target = isStr(a.subKind) ? a.subKind : isStr(a.kind) ? a.kind : null
    const on = target ? ` on ${target}` : ''
    const fields = Object.keys(isObj(a.fields) ? a.fields : {})
    switch (a.verb) {
      case 'set-field': {
        const held = fields.filter((f) => ownerWritable.has(f))
        writes.push(
          `the owner may set ${fields.join(', ') || 'no field'}${on}${isObj(producer.sync) && held.length > 0 ? ` — held over the sync in the owner's overlay (${held.join(', ')})` : ''}`,
        )
        break
      }
      case 'agent-record-write':
        writes.push(`the producer may change its own records${on} through the API, with its token`)
        break
      case 'append-item':
        writes.push(`${Array.isArray(a.by) ? a.by.join(' and ') : isStr(a.by) ? a.by : 'the owner'} may add items${on}`)
        break
      case 'move-item':
        writes.push(`items${on} may be moved${a.betweenParents === true ? ' between parents' : ''}`)
        break
      case 'message-agent':
        writes.push(
          `the owner may message the producer${on}${Array.isArray(a.templates) && a.templates.length > 0 ? ` from ${a.templates.length} written template${a.templates.length === 1 ? '' : 's'}` : ''}`,
        )
        break
      case 'open':
        writes.push('open a record (writes nothing)')
        break
      case 'ack':
        writes.push('mark a row seen (writes nothing to the records)')
        break
      default:
        break
    }
  }

  // where needs-you rows go when the author routes them to the producer
  const routing: string[] = []
  const entries = (
    isObj(spec.surfaces) && Array.isArray((spec.surfaces as Json)['needs-you']) ? ((spec.surfaces as Json)['needs-you'] as unknown[]) : []
  ).filter(isObj)
  for (const [i, n] of entries.entries()) {
    if (n.audience !== 'producer-agent' || n.urgency === 'blocking') continue
    routing.push(
      `entry ${i} (${String(n.urgency)}): rows matching «${String(n.when)}» go to the agents bound to ${role}, not to the owner's inbox — Home only counts them, until «${String(n.clears)}». Approving the manifest grants this; the owner can send an entry back to their own inbox (audienceOff). With no producer bound, the owner keeps the rows.`,
    )
  }

  // the sync's schedule, as the dialog proposes it (opt-in at approval)
  let automation: string | null = null
  if (isObj(producer.sync)) {
    const src = (Array.isArray(spec.sources) ? (spec.sources as Json[]) : []).find(
      (s) => isObj(s.expects) && s.expects.producer === 'sync' && isStr(s.expects.cadence),
    )
    if (src) {
      const cadence = String((src.expects as Json).cadence)
      const c = cronForCadence(cadence)
      automation = `the dialog offers to create «${name} — ${String((producer.sync as Json).service)} sync», ${c ? c.says : `but the cadence ${cadence} has no cron form — set the schedule by hand`} — opt-in, run by the first bound producer`
    } else automation = 'no automation is offered — no sync source declares expects.producer sync with a cadence'
  }

  // the look it brings — what the dialog draws as swatches, said as values
  const look: string[] = []
  const theme = resolveTheme(spec.theme)
  if (theme) {
    look.push(`a look, ${theme.name} — approving offers it in Settings › Appearance; nothing changes on screen until someone chooses it`)
    for (const mode of THEME_MODES) {
      const t = theme[mode]
      const c = closestPair(theme, mode)
      look.push(
        `${mode}: background ${t.background} · panel ${t.panel} · text ${t.text} · accent ${t.accent} on-accent ${t['on-accent']} — closest pair ${c.fg} on ${c.bg} ${sayRatio(c.ratio)} (at least ${c.min}:1)`,
      )
    }
  }

  const requirements = v.requirements.map(
    (r) => `${r.what}${r.met === null ? ' — checked on the Silos it is installed on (Settings › Territory)' : r.met ? '' : ' — not met'}`,
  )

  return {
    title: `Install ${name} ${String(meta.version)}?`,
    basis: preview.basis,
    shows,
    reads,
    writes,
    routing,
    automation,
    requirements,
    wants: v.wants,
    notes: [
      ...v.notes,
      'checked standalone: an id the owner approved before on their Silos stays reserved there, and only there will the dialog count real records',
    ],
    // what a bound agent whose session lacks the silo's `via` skill gets
    // a silo with no producer (edge-only, a look only) briefs nobody
    brief: kernel || !isObj(spec.producer) || instructedElsewhere(m, []) ? null : producerBrief(m, '<the bound agent>'),
    look,
  }
}

// The text silo-check prints.
export function renderCheck(r: CheckResult, file?: string): string {
  const out: string[] = []
  if (!r.ok) {
    out.push(
      `${file ? `${file}: ` : ''}${r.validation?.ok ? 'validates, but the install door refuses it' : 'does not validate'} — ${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}`,
    )
    for (const f of r.findings) out.push(`  ${f}`)
    return out.join('\n')
  }
  const p = r.preview!
  out.push(`${file ? `${file}: ` : ''}validates against the Silo Standard v0`)
  out.push('', `What the install dialog will tell the owner — «${p.title}»`)
  const section = (title: string, lines: string[]): void => {
    if (lines.length === 0) return
    out.push('', title)
    for (const l of lines) out.push(`  ${l}`)
  }
  section(
    `What it will show you (${p.basis})`,
    p.shows.map((s) => `${s.place}: ${s.says}`),
  )
  if (p.shows.length === 0) section('What it will show you', ['It asks for no place on Home — only its own page.'])
  section('What it brings', p.look)
  section('What it reads', p.reads)
  section('Who writes it', [...p.writes, ...p.requirements, ...(p.automation ? [p.automation] : [])])
  section('Where its Needs you rows go', p.routing)
  section('Said, not refused', [
    ...(p.wants.length > 0
      ? [`loads without ${p.wants.length} field${p.wants.length === 1 ? '' : 's'} this Silos does not know yet: ${p.wants.join(', ')}`]
      : []),
    ...p.notes,
  ])
  if (p.brief) section('What a bound producer is handed at start', p.brief.split('\n'))
  return out.join('\n')
}

// The CLI: silo-check <file.silo.json>… — prints each, exits 0 when all
// validate, 1 when any does not (2 on usage).
export function runSiloCheck(argv: readonly string[], io: { cwd: string; out: (s: string) => void; err: (s: string) => void; now?: number }): number {
  const files = argv.filter((a) => a !== '--')
  if (files.length === 0 || files.includes('-h') || files.includes('--help')) {
    io.err('usage: npm run silo-check -- path/to/my.silo.json [more.silo.json …]')
    return 2
  }
  let failed = false
  for (const [i, f] of files.entries()) {
    const path = isAbsolute(f) ? f : resolve(io.cwd, f)
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (e) {
      io.err(`${f}: cannot be read — ${e instanceof Error ? e.message : String(e)}`)
      failed = true
      continue
    }
    const r = checkSilo(raw, io.now !== undefined ? { now: io.now } : {})
    if (i > 0) io.out('')
    io.out(renderCheck(r, f))
    if (!r.ok) failed = true
  }
  return failed ? 1 : 0
}
