// Settings › Silos: the three groups and their words — pure,
// from GET /api/silos as the server sends it.
import { describe, expect, it } from 'vitest'
import { groupSilos, installedFacts, isEmpty, uninstalledAction, uninstalledFacts, waitingAction } from '../src/lib/silo-settings'
import type { SiloDescriptor, SiloUninstalled } from '../src/lib/types'

const d = (over: Partial<SiloDescriptor>): SiloDescriptor => ({
  id: 'invoices',
  name: 'Invoices',
  description: null,
  version: '0.1.0',
  apiVersion: 'silo-standard/v0',
  state: 'active',
  reason: 'active',
  conventions: [],
  wants: [],
  kinds: [],
  producer: { role: 'finance', sync: 'Ledgerly' },
  records: { parsed: 12, failed: 0 },
  lastWrite: null,
  freshness: null,
  slots: { requested: [], granted: [], off: [] },
  observedAt: '2026-10-30T00:00:00Z',
  ...over,
})
const u = (over: Partial<SiloUninstalled> = {}): SiloUninstalled => ({
  id: 'documents',
  name: 'Documents',
  uninstalledAt: '2026-10-28T12:00:00.000Z',
  producers: ['finance'],
  kept: { files: 4, records: null, conventions: ['project:context/documents'], overlayAndJournal: [] },
  grown: 0,
  manifest: { version: '0.1.0', keptAt: '2026-10-28T12:00:00.000Z' },
  automation: null,
  submission: null,
  ...over,
})
const NOW = Date.parse('2026-10-31T12:00:00.000Z')

describe('groupSilos', () => {
  it('within a group: installed = decided on (any state but pending), waiting = pending in the registry, uninstalled as sent', () => {
    const g = groupSilos(
      [d({ id: 'z', name: 'Zeta' }), d({ id: 'w', name: 'Waits', state: 'pending' }), d({ id: 'a', name: 'Alpha', state: 'disabled' })],
      [u()],
    )
    expect(g.yours.installed.map((x) => x.id)).toEqual(['a', 'z'])
    expect(g.yours.waiting.map((x) => x.id)).toEqual(['w'])
    expect(g.yours.uninstalled.map((x) => x.id)).toEqual(['documents'])
    expect(isEmpty(g)).toBe(false)
    expect(isEmpty(groupSilos([], undefined))).toBe(true)
  })
  it("three groups by the server's lineup — recommended, optional (with the offers), yours — whatever the state", () => {
    const g = groupSilos(
      [
        d({ id: 'f' }),
        d({ id: 'plans', name: 'Plans', lineup: 'recommended' }),
        d({ id: 'system', name: 'System', lineup: 'recommended', state: 'disabled' }),
        d({ id: 'support', name: 'Support', lineup: 'optional', provenance: 'builtin' }),
      ],
      [u({ id: 'task-mode', name: 'Task mode', lineup: 'recommended' })],
      [{ id: 'heather', name: 'Heather', description: null, version: '0.1.0' }],
    )
    expect(g.recommended.installed.map((x) => x.id)).toEqual(['plans', 'system'])
    expect(g.recommended.uninstalled.map((x) => x.id)).toEqual(['task-mode'])
    // an install that still says provenance builtin is grouped where Silos ships it now
    expect(g.optional.installed.map((x) => x.id)).toEqual(['support'])
    expect(g.optional.available.map((x) => x.id)).toEqual(['heather'])
    expect(g.yours.installed.map((x) => x.id)).toEqual(['f'])
  })
  it('an older server sends no lineup: provenance builtin reads as recommended', () => {
    expect(groupSilos([d({ id: 'p', provenance: 'builtin' })], undefined).recommended.installed.map((x) => x.id)).toEqual(['p'])
  })
})

describe('the words', () => {
  it('installed: records, the bound producers over the role, the automation; an error says its reason first', () => {
    const facts = installedFacts(
      d({ producers: ['finance', 'writer'], automation: { id: 'x', name: 'sync', paused: true }, records: { parsed: 1, failed: 2 } }),
    )
    expect(facts).toContain('finance, writer')
    expect(facts).toContain('paused')
    // nobody bound: a role is a word of the manifest, never an agent
    expect(installedFacts(d({}))).not.toContain('finance')
    expect(installedFacts(d({ producers: ['finance'] }))).toContain('finance')
    expect(installedFacts(d({ state: 'error', reason: 'silo.json is not valid JSON', producer: null }))).toMatch(/^silo\.json is not valid JSON/)
  })
  it('uninstalled: when, what stayed, who kept writing', () => {
    expect(uninstalledFacts(u(), NOW)).toContain('4 files')
    const grown = uninstalledFacts(u({ grown: 2, kept: { files: 1, records: null, conventions: [], overlayAndJournal: [] } }), NOW)
    expect(grown).toContain('finance')
    expect(grown).toContain('2 new')
    // with the parsed count recorded at uninstall, the line says records
    expect(uninstalledFacts(u({ kept: { files: 4, records: 1161, conventions: [], overlayAndJournal: [] } }), NOW)).toContain('1161 records')
  })
  it('a kernel source: kept by Silos, never «written by kernel»; uninstalled, its records stay with Silos — no files', () => {
    expect(
      installedFacts(
        d({
          producer: { role: 'kernel', sync: null },
          records: { parsed: 3, failed: 0 },
          kernel: { kind: 'process', reads: 'the processes your conversations started on this machine and the ports they listen on' },
        }),
      ),
    ).toBe('3 records · kept by Silos from the processes your conversations started on this machine and the ports they listen on')
    expect(uninstalledFacts(u({ producers: [], kept: { files: 0, records: 3, conventions: ['kernel:process'], overlayAndJournal: [] } }), NOW)).toBe(
      'Uninstalled 3d ago · 3 records stay with Silos (kernel data), with the journal',
    )
  })
  it('the uninstalled action: review a waiting reinstall, reinstall from the kept manifest, or say why not', () => {
    expect(uninstalledAction(u())).toEqual({ kind: 'reinstall', version: '0.1.0' })
    expect(uninstalledAction(u({ submission: { at: '', submittedBy: 'owner', version: '0.1.0' } }))).toEqual({
      kind: 'review',
      says: '0.1.0 waits for your approval — submitted by you',
    })
    expect(uninstalledAction(u({ manifest: null }))).toEqual({
      kind: 'none',
      says: 'No manifest was kept at the uninstall — its author has to submit it again',
    })
  })
  it('a dimension the server still serves natively (the uninstalled Plans row): its words, never Reinstall… — even with a manifest kept', () => {
    const words = 'Plans comes with Silos — it already runs natively; it becomes a silo when Silos migrates it'
    expect(uninstalledAction(u({ id: 'plans', name: 'Plans', native: words }))).toEqual({ kind: 'none', says: words })
    // a submission from before the guard can still be opened (to reject it)
    expect(uninstalledAction(u({ native: words, submission: { at: '', submittedBy: 'owner', version: '0.1.0' } }))).toMatchObject({ kind: 'review' })
    expect(waitingAction(d({ state: 'pending', native: words }))).toEqual({ kind: 'none', says: words })
    expect(waitingAction(d({ state: 'pending' }))).toEqual({ kind: 'submit' })
    expect(waitingAction(d({ state: 'pending', submission: { at: '', submittedBy: 'finance', version: '0.1.0' } }))).toEqual({ kind: 'review' })
  })
})
