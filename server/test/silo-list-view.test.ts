// The list archetype's view attributes (21-11): `first` (what comes first —
// the mirror of fold), `groupBy` (one dimension, rows together, counts over
// the whole matching set, the no-value group last and named, contiguous
// across pages), the search `q` (counted honestly), and the field's
// presentation (`label`, `unit`) — read by views.ts and voice.ts, refused
// in plain words by the validator when malformed.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { recordsPage, type RecordsPage, type RecordsQuery } from '../src/silos/views.js'
import { validateSilo, type ValidatorContext } from '../src/silos/validator.js'
import type { SiloEntry } from '../src/silos/registry.js'
import type { SiloReading } from '../src/silos/reader.js'

type Json = Record<string, any>
const REF_DIR = join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference')
const ref = (id: string): Json => JSON.parse(readFileSync(join(REF_DIR, `${id}.silo.json`), 'utf8'))
const NOW = Date.parse('2026-11-21T12:00:00Z')
const ago = (h: number): string => new Date(NOW - h * 3_600_000).toISOString()
const ctx = (): ValidatorContext => ({ now: NOW, isAgent: (v) => ['writer'].includes(v) })

// a synthetic kind: jobs, grouped by their `lane`, `stuck` first, `done` folded
function manifest(view: Json = {}): Json {
  return {
    apiVersion: 'silo-standard/v0',
    metadata: { id: 'jobs', version: '0.1.0', name: 'Jobs', description: 'Synthetic jobs for the list archetype.' },
    spec: {
      producer: { role: 'writer', instructions: { summary: 'Write one record per job.', protocol: ['One file per job.'] } },
      sources: [{ id: 'jobs', type: 'files', root: 'project', glob: 'context/jobs/*.json', parser: 'json', expects: { producer: 'agent' } }],
      kinds: {
        job: {
          envelope: {
            id: { field: 'id' },
            identity: { template: '{{title}}' },
            state: { field: 'state' },
            at: { field: 'startedAt' },
            anchors: [{ hub: 'folder', from: 'location' }],
            updatedBy: { field: 'updatedBy', fallback: 'agent' },
          },
          states: [
            { value: 'running', label: { one: 'running', many: 'running' } },
            { value: 'stuck', label: { one: 'stuck', many: 'stuck' } },
            { value: 'done', label: { one: 'done', many: 'done' }, terminal: true },
          ],
          fields: {
            title: { type: 'string', required: true },
            startedAt: { type: 'timestamp', required: true, label: 'started' },
            lane: { type: 'string', optional: true },
            load: { type: 'number', optional: true, label: 'load', unit: '%' },
            size: { type: 'number', optional: true },
          },
          examples: [{ id: 'j1', title: 'Build the site', startedAt: '2026-11-20T08:00:00Z', lane: 'web', load: 12.25, state: 'running' }],
        },
      },
      views: [
        {
          id: 'jobs',
          archetype: 'list',
          kind: 'job',
          columns: ['identity', 'state', 'load', 'size', 'at'],
          facets: ['state', 'lane'],
          groupBy: 'lane',
          first: { when: 'state = stuck' },
          fold: { when: 'state = done' },
          ...view,
        },
      ].map((v) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined))),
    },
  }
}

function page(m: Json, rows: Json[], q: RecordsQuery = {}): RecordsPage {
  const entry = { id: 'jobs', manifest: m, status: { manifest: { name: 'Jobs' }, state: 'active', freshness: null, conventions: [] } } as unknown as SiloEntry
  const reading = {
    records: rows.map((r) => ({
      silo: 'jobs',
      kind: 'job',
      source: 'jobs',
      file: '',
      rel: `${r.id}.json`,
      location: 'agent:writer',
      anchors: { agent: 'writer' },
      mtimeMs: 0,
      raw: r,
      record: { identity: r.title, at: r.startedAt, ...r },
      remarks: [],
      partial: [],
    })),
    unreadable: [],
    lastWrite: null,
    sources: {},
    truncated: [],
    problems: [],
  } as unknown as SiloReading
  const p = recordsPage(
    entry,
    reading,
    { voice: { now: NOW, nameOf: (id) => (id === 'writer' ? 'Writer' : id) }, overlayKeys: new Set(), conflictKeys: new Set() },
    q,
  )
  if ('error' in p) throw new Error(p.error)
  return p
}

const JOBS: Json[] = [
  { id: 'a1', title: 'Render thumbnails', startedAt: ago(1), lane: 'media', state: 'running', load: 41.5 },
  { id: 'a2', title: 'Transcode the intro', startedAt: ago(9), lane: 'media', state: 'running', load: 3 },
  { id: 'b1', title: 'Serve the docs preview', startedAt: ago(30), lane: 'docs', state: 'stuck', load: 0.4, size: 1240 },
  { id: 'b2', title: 'Watch the docs build', startedAt: ago(2), lane: 'docs', state: 'running' },
  { id: 'c1', title: 'Old seed script', startedAt: ago(50), lane: 'data', state: 'stuck' },
  { id: 'n1', title: 'A listener of nobody', startedAt: ago(0.5), state: 'running' },
  { id: 'n2', title: 'Another listener', startedAt: ago(3), lane: '', state: 'running' },
  { id: 'd1', title: 'Finished import', startedAt: ago(4), lane: 'media', state: 'done' },
]
const ids = (p: RecordsPage): string[] => p.records.map((r) => r.id)

describe('the list view: first, groups, order', () => {
  it('groups with a `first` record lead (newest first), then the rest by their newest, the no-value group last and named; folded last', () => {
    const p = page(manifest(), JOBS, { folded: 'include' })
    // docs (stuck, newest 2h) · data (stuck, 50h) · media (1h) · none · then the folded media
    expect(ids(p)).toEqual(['b1', 'b2', 'c1', 'a1', 'a2', 'n1', 'n2', 'd1'])
    expect(p.records.map((r) => r.group)).toEqual([
      { value: 'docs', label: 'docs', count: 2 },
      { value: 'docs', label: 'docs', count: 2 },
      { value: 'data', label: 'data', count: 1 },
      { value: 'media', label: 'media', count: 2 },
      { value: 'media', label: 'media', count: 2 },
      { value: null, label: 'No lane', count: 2 },
      { value: null, label: 'No lane', count: 2 },
      { value: 'media', label: 'media', count: 1 },
    ])
    expect(p.records.filter((r) => r.first).map((r) => r.id)).toEqual(['b1', 'c1'])
    expect(p.kind.groupBy).toEqual({ field: 'lane', label: 'lane' })
  })

  it('a group stays contiguous across pages, its count over the whole set; every record is on exactly one page', () => {
    const seen: string[] = []
    for (let offset = 0; offset < 7; offset += 3) {
      const p = page(manifest(), JOBS, { folded: 'exclude', limit: 3, offset })
      expect(p.matching).toBe(7)
      expect(p.records.every((r) => r.group!.count === JOBS.filter((j) => j.state !== 'done' && (j.lane || null) === r.group!.value).length)).toBe(true)
      seen.push(...ids(p))
    }
    expect(seen).toEqual(['b1', 'b2', 'c1', 'a1', 'a2', 'n1', 'n2'])
    const lanes = seen.map((id) => JOBS.find((j) => j.id === id)!.lane || null)
    // contiguity: once a group is left, it never comes back
    const left = new Set<string | null>()
    lanes.forEach((l, i) => {
      if (i > 0 && lanes[i - 1] !== l) {
        expect(left.has(l)).toBe(false)
        left.add(lanes[i - 1]!)
      }
    })
  })

  it('without groupBy: `first` records lead, then newest — and with neither, newest first as before', () => {
    expect(ids(page(manifest({ groupBy: undefined }), JOBS, { folded: 'exclude' }))).toEqual(['b1', 'c1', 'n1', 'a1', 'b2', 'n2', 'a2'])
    expect(ids(page(manifest({ groupBy: undefined, first: undefined }), JOBS, { folded: 'exclude' }))).toEqual(['n1', 'a1', 'b2', 'n2', 'a2', 'b1', 'c1'])
    expect(page(manifest({ groupBy: undefined }), JOBS).records.every((r) => r.group === undefined)).toBe(true)
  })

  it('the agent dimension groups by the agent, said by its name — its heading opens the agent', () => {
    const p = page(manifest({ groupBy: 'agent' }), JOBS.slice(0, 2), {})
    expect(p.records[0]!.group).toEqual({ value: 'writer', label: 'Writer', count: 2, opens: { hub: 'agent', value: 'writer' } })
  })
  it('a group by a plain field opens nothing (words only)', () => {
    expect(page(manifest(), JOBS).records.every((r) => r.group && r.group.opens === undefined)).toBe(true)
  })
})

describe('the search', () => {
  it('every term must appear (any case) in the identity, the shown cells or the group; counts stay honest', () => {
    const p = page(manifest(), JOBS, { q: 'DOCS preview' })
    expect(ids(p)).toEqual(['b1'])
    expect(p.matching).toBe(1)
    expect(p.total).toBe(8)
    expect(ids(page(manifest(), JOBS, { q: 'media' })).sort()).toEqual(['a1', 'a2', 'd1']) // the group's words
    expect(ids(page(manifest(), JOBS, { q: '41.5' }))).toEqual(['a1']) // a cell as shown
    expect(ids(page(manifest(), JOBS, { q: 'writer thumbnails' }))).toEqual(['a1']) // the agent by its name
    expect(page(manifest(), JOBS, { q: 'nothing like this' }).matching).toBe(0)
    // facets are counted over the whole set, search or not
    expect(
      page(manifest(), JOBS, { q: 'docs' })
        .kind.facets.find((f) => f.name === 'state')!
        .values.reduce((s, v) => s + v.count, 0),
    ).toBe(8)
  })
})

describe("a field's presentation", () => {
  it('a number with a unit is said with it; the header words come from the label (at by its field)', () => {
    const p = page(manifest(), JOBS, { q: 'thumbnails' })
    expect(p.records[0]!.cells.find((c) => c.column === 'load')!.text).toBe('41.5 %')
    const big = page(manifest(), JOBS, { q: 'preview' }).records[0]!
    expect(big.cells.find((c) => c.column === 'size')!.text).toBe('1240') // no unit: as it is
    expect(p.kind.columnLabels).toEqual({ load: 'load', at: 'started' })
    expect(p.kind.columnTypes.load).toBe('number')
  })
})

describe('the fold says what it folds', () => {
  it("the view's fold label is served on the kind; a fold without one is said null; no fold at all, no fold", () => {
    expect(page(manifest({ fold: { when: 'state = done', label: ' finished ' } }), JOBS).kind.fold).toEqual({ label: 'finished' })
    expect(page(manifest(), JOBS).kind.fold).toEqual({ label: null })
    expect(page(manifest({ fold: undefined }), JOBS).kind.fold).toBeNull()
  })
  it('the System manifest says what its fold holds', () => {
    expect(ref('system').spec.views[0].fold.label).toEqual(expect.any(String))
  })
})

describe('the validator', () => {
  const errorsOf = (m: unknown): Array<[number, string, string]> => validateSilo(m, ctx()).errors.map((e) => [e.check, e.where, e.message])
  it('accepts the synthetic view, and the System manifest with its fold over other-user', () => {
    expect(errorsOf(manifest())).toEqual([])
    const sys = validateSilo(ref('system'), ctx())
    expect(sys.errors).toEqual([])
    expect(ref('system').spec.views[0]).toMatchObject({
      groupBy: 'conversation',
      first: { when: 'state = left' },
      fold: { when: "state = exited or origin = 'other-user'" },
    })
  })
  it('refuses a group nobody shares, an unknown one, a board grouped by anything but state, and `first` on a board', () => {
    expect(errorsOf(manifest({ groupBy: 'startedAt' }))).toEqual([
      [6, 'spec.views[0].groupBy', 'startedAt is a timestamp — every record would sit alone in its group; group by a field records share'],
    ])
    expect(errorsOf(manifest({ groupBy: 'nope' }))).toEqual([
      [6, 'spec.views[0].groupBy', 'nope is not something job records can be grouped by — a field of it, agent, folder, project or state'],
    ])
    expect(errorsOf(manifest({ groupBy: 'identity' }))[0]![1]).toBe('spec.views[0].groupBy')
    expect(errorsOf(manifest({ archetype: 'board', groupBy: 'lane', first: undefined, columns: undefined, facets: undefined }))).toEqual([
      [6, 'spec.views[0].groupBy', "a board groups by state — its columns are the kind's states, not lane"],
    ])
    expect(errorsOf(manifest({ archetype: 'board', groupBy: 'state', columns: undefined, facets: undefined }))).toEqual([
      [6, 'spec.views[0].first', 'first orders a list — a board is ordered by its columns'],
    ])
  })
  it('refuses a `first` that does not parse or names an undeclared field', () => {
    const e = errorsOf(manifest({ first: { when: 'colour = red' } }))
    expect(e).toHaveLength(1)
    expect(e[0]!.slice(0, 2)).toEqual([6, 'spec.views[0].first.when'])
  })
  it('a fold label is a few words on one line: empty, blank, too long or two lines is refused', () => {
    expect(errorsOf(manifest({ fold: { when: 'state = done', label: 'finished' } }))).toEqual([])
    for (const label of ['', '   ', 'x'.repeat(61), 'done\nor gone', 7]) {
      const e = errorsOf(manifest({ fold: { when: 'state = done', label } }))
      expect(e.length, JSON.stringify(label)).toBeGreaterThan(0)
      expect(
        e.some(([, where, msg]) => where.includes('fold') || msg.includes('fold') || msg.includes('label')),
        JSON.stringify(e),
      ).toBe(true)
    }
  })
  it('refuses a unit on a field that is not a number, and a malformed label or unit by the schema', () => {
    const m = manifest()
    m.spec.kinds.job.fields.title.unit = 'MB'
    expect(errorsOf(m)).toEqual([[6, 'spec.kinds.job.fields.title.unit', 'title is a string — only a number field is said with a unit']])
    const l = manifest()
    l.spec.kinds.job.fields.load.label = ''
    expect(errorsOf(l)[0]![0]).toBe(1)
    const u = manifest()
    u.spec.kinds.job.fields.load.unit = ' % '
    expect(errorsOf(u)[0]![0]).toBe(1)
  })
})
