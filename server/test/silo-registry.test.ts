import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiloRegistry, type SiloOperatorView } from '../src/silos/registry.js'
import { deriveConvention, readManifest } from '../src/silos/manifest.js'
import { siloFile, siloManifest } from './helpers/silo-manifests.js'

const refManifest = (id: string): Record<string, any> => siloManifest(id) as Record<string, any>

let dataDir: string
let registries: SiloRegistry[] = []

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'silo-registry-'))
})
afterEach(async () => {
  await Promise.all(registries.map((r) => r.close()))
  registries = []
  rmSync(dataDir, { recursive: true, force: true })
})

const regDir = (): string => join(dataDir, 'silos', 'registry')
function place(id: string, manifest: unknown, folder = id): string {
  const dir = join(regDir(), folder)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'silo.json')
  writeFileSync(file, typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2))
  return file
}
function makeRegistry(opts: { operator?: SiloOperatorView; restrictive?: string[]; schemaPath?: string } = {}): SiloRegistry {
  const r = new SiloRegistry({ dataDir, debounceMs: 20, ...opts })
  registries.push(r)
  return r
}
const statusOf = (id: string): Record<string, any> => JSON.parse(readFileSync(join(regDir(), id, 'status.json'), 'utf8'))

describe('SiloRegistry — boot', () => {
  it('loads the four reference manifests: valid, pending until the owner approves, conventions derived', () => {
    for (const id of ['support', 'plans', 'invoices', 'documents']) {
      mkdirSync(join(regDir(), id), { recursive: true })
      copyFileSync(siloFile(id), join(regDir(), id, 'silo.json'))
    }
    const r = makeRegistry()
    r.load()
    const d = r.describe()
    expect(d.map((x) => x.id)).toEqual(['documents', 'invoices', 'plans', 'support'])
    for (const x of d) {
      expect(x.state).toBe('pending')
      expect(x.reason).toBe('waiting for the owner to approve it')
      expect(x.wants).toEqual([])
      expect(x.slots.granted).toEqual([])
    }
    const by = Object.fromEntries(d.map((x) => [x.id, x]))
    expect(by.invoices!.conventions).toEqual([{ source: 'invoices', convention: 'agent-state:silos/invoices' }])
    expect(by.support!.conventions).toEqual([{ source: 'cases', convention: 'agent-state:support/cases' }])
    expect(by.plans!.conventions).toEqual([{ source: 'plans', convention: 'project:plans' }])
    expect(by.documents!.conventions).toEqual([{ source: 'documents', convention: 'project:context/documents' }])
    expect(by.invoices!.slots.requested).toEqual(['pulse', 'needs-you', 'agent-section'])
    expect(by.plans!.kinds).toEqual(['plans/plan', 'plans/plan/task'])
    expect(by.invoices!.producer).toEqual({ role: 'finance', sync: 'Invoicing' })
    expect(by.invoices!.version).toBe('0.1.0')
    // status.json is written by the kernel, next to the manifest
    const st = statusOf('invoices')
    expect(st.state).toBe('pending')
    expect(st.conventions[0]).toMatchObject({ convention: 'agent-state:silos/invoices', dir: 'agent-state%3Asilos%2Finvoices' })
    expect(st.records).toEqual({ parsed: 0, failed: 0 })
    expect(st.manifest.hash).toMatch(/^[0-9a-f]{16}$/)
    // conventions/ is reserved for overlay+journal and created by its first writer
    expect(existsSync(join(dataDir, 'silos', 'conventions'))).toBe(false)
  })

  it('an approved silo is active with its slots granted, minus the ones the operator turned off', () => {
    place('invoices', refManifest('invoices'))
    const r = makeRegistry({ operator: { decisionFor: (id) => (id === 'invoices' ? 'approved' : null), slotsOff: () => ['agent-section', 'rail'] } })
    r.load()
    const [d] = r.describe()
    expect(d!.state).toBe('active')
    expect(d!.slots).toEqual({ requested: ['pulse', 'needs-you', 'agent-section'], granted: ['pulse', 'needs-you'], off: ['agent-section'] })
  })

  it('a disabled silo says so', () => {
    place('plans', refManifest('plans'))
    const r = makeRegistry({ operator: { decisionFor: () => 'disabled', slotsOff: () => [] } })
    r.load()
    expect(r.describe()[0]).toMatchObject({ state: 'disabled', reason: 'turned off by the owner' })
  })

  it('with no injected operator, decisions come from silos/operator.json (the store Task 11 will write)', () => {
    place('invoices', refManifest('invoices'))
    place('plans', refManifest('plans'))
    writeFileSync(
      join(dataDir, 'silos', 'operator.json'),
      JSON.stringify({
        silos: { invoices: { decision: 'approved', slotsOff: ['agent-section'] }, plans: { decision: 'disabled' } },
      }),
    )
    const r = makeRegistry()
    r.load()
    const by = Object.fromEntries(r.describe().map((x) => [x.id, x]))
    expect(by.invoices).toMatchObject({
      state: 'active',
      slots: { requested: ['pulse', 'needs-you', 'agent-section'], granted: ['pulse', 'needs-you'], off: ['agent-section'] },
    })
    expect(by.plans).toMatchObject({ state: 'disabled' })
  })

  it('a corrupt or absent operator.json decides nothing — the silo stays pending', () => {
    place('invoices', refManifest('invoices'))
    writeFileSync(join(dataDir, 'silos', 'operator.json'), '{ not json')
    const r = makeRegistry()
    r.load()
    expect(r.describe()[0]).toMatchObject({ state: 'pending' })
  })

  it('creates an empty registry on a fresh install', () => {
    const r = makeRegistry()
    r.load()
    expect(r.describe()).toEqual([])
    expect(existsSync(regDir())).toBe(true)
  })

  it('a folder without silo.json is not a silo', () => {
    mkdirSync(join(regDir(), 'empty'), { recursive: true })
    const r = makeRegistry()
    r.load()
    expect(r.describe()).toEqual([])
  })
})

describe('SiloRegistry — unknown fields: additive ⇒ wants, restrictive ⇒ rejected', () => {
  it('an unknown ADDITIVE field loads what is understood and lists the rest in wants', () => {
    const m = refManifest('invoices')
    m.spec.kinds.invoice.horizon = { field: 'due' }
    m.spec.surfaces['column-block'] = { label: 'x' }
    m.metadata.convention = 'accounts' // a convention is never declared — even when written, it is derived
    place('invoices', m)
    const r = makeRegistry({ operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
    r.load()
    const e = r.get('invoices')!
    expect(e.status.state).toBe('active')
    expect(e.status.wants.sort()).toEqual(['metadata.convention', 'spec.kinds.invoice.horizon', 'spec.surfaces.column-block'])
    expect(e.status.reason).toBe('active — loaded without 3 fields this Silos does not know yet')
    expect((e.manifest!.spec as any).kinds.invoice.horizon).toBeUndefined()
    expect(e.status.conventions[0]!.convention).toBe('agent-state:silos/invoices')
    expect(e.status.slots.requested).toEqual(['pulse', 'needs-you', 'agent-section'])
  })

  it('an unknown RESTRICTIVE field rejects the silo with its reason (the class is empty in v0; the rule holds)', () => {
    const m = refManifest('invoices')
    m.spec.kinds.invoice.fields.total.sensitive = true
    place('invoices', m)
    const r = makeRegistry({ restrictive: ['sensitive'] })
    r.load()
    const s = r.get('invoices')!.status
    expect(s.state).toBe('error')
    expect(s.reason).toBe(
      "this silo needs spec.kinds.invoice.fields.total.sensitive, which this Silos does not understand and must not ignore — it can't be approved until Silos is updated",
    )
    // with the v0 class (empty) the same field is only a want
    const r2 = makeRegistry()
    r2.load()
    expect(r2.get('invoices')!.status).toMatchObject({ state: 'pending', wants: ['spec.kinds.invoice.fields.total.sensitive'] })
  })
})

describe('SiloRegistry — a broken manifest is an error with its reason, never a crash', () => {
  it.each([
    [
      'an unknown root',
      (m: any) => {
        m.spec.sources[0].root = 'cloud'
      },
      'the manifest does not follow the Silo Standard: spec.sources[0].root must be one of agent-state, project, kernel (found "cloud")',
    ],
    [
      'a missing kinds',
      (m: any) => {
        delete m.spec.kinds
      },
      'the manifest does not follow the Silo Standard: spec is missing kinds',
    ],
    [
      'a wrong apiVersion',
      (m: any) => {
        m.apiVersion = 'silo-standard/v9'
      },
      'the manifest does not follow the Silo Standard: apiVersion must be "silo-standard/v0" (found "silo-standard/v9")',
    ],
    [
      'a bad version',
      (m: any) => {
        m.metadata.version = 'one'
      },
      'metadata.version "one" does not have the expected form',
    ],
    [
      'a state with field AND computed',
      (m: any) => {
        m.spec.kinds.invoice.envelope.state.computed = 'x'
      },
      'spec.kinds.invoice.envelope.state must match exactly one of its allowed shapes',
    ],
    [
      'examples missing',
      (m: any) => {
        delete m.spec.kinds.invoice.examples
      },
      'spec.kinds.invoice is missing examples',
    ],
    [
      'a glob that climbs out',
      (m: any) => {
        m.spec.sources[0].glob = '../../secrets/*.json'
      },
      'source invoices: the glob "../../secrets/*.json" climbs out of its agent-state root with ".."',
    ],
    [
      'an agent-state glob outside silos/',
      (m: any) => {
        m.spec.sources[0].glob = 'notes/*.json'
      },
      'source invoices: under agent-state a silo\'s records live in silos/<silo>/ — "notes/*.json" is outside it',
    ],
    [
      'a glob on the root itself',
      (m: any) => {
        m.spec.sources[0].glob = '*.json'
      },
      'source invoices: the glob "*.json" names no folder of its own under agent-state',
    ],
  ])('%s', (_label, mutate, reason) => {
    const m = refManifest('invoices')
    mutate(m)
    place('invoices', m)
    const r = makeRegistry()
    r.load()
    const s = r.get('invoices')!.status
    expect(s.state).toBe('error')
    expect(s.reason).toContain(reason)
    expect(statusOf('invoices').state).toBe('error')
  })

  it('not JSON', () => {
    place('invoices', '{ "apiVersion": ')
    const r = makeRegistry()
    r.load()
    expect(r.get('invoices')!.status.reason).toMatch(/^silo\.json is not valid JSON: /)
  })

  it('the id must be the folder', () => {
    place('invoices', refManifest('invoices'), 'accounts')
    const r = makeRegistry()
    r.load()
    expect(r.get('accounts')!.status).toMatchObject({ state: 'error', reason: 'the manifest says its id is "invoices" but it lives in the folder "accounts"' })
  })

  it('a folder that is not a silo id', () => {
    place('Invoices', refManifest('invoices'), 'Invoices')
    const r = makeRegistry()
    r.load()
    expect(r.get('Invoices')!.status.reason).toBe('the folder name "Invoices" is not a valid silo id (lowercase letters, digits and -)')
  })

  it('a silo.json that is not a regular file (a FIFO would freeze a read) or too large', () => {
    mkdirSync(join(regDir(), 'fifo'), { recursive: true })
    execFileSync('mkfifo', [join(regDir(), 'fifo', 'silo.json')])
    place('big', `{"x":"${'a'.repeat(300 * 1024)}"}`)
    const r = makeRegistry()
    r.load()
    expect(r.get('fifo')!.status.reason).toBe('silo.json is not a regular file')
    expect(r.get('big')!.status.reason).toBe('silo.json is larger than 256 KB')
  })

  it('a missing schema is said, not crashed on', () => {
    place('invoices', refManifest('invoices'))
    const r = makeRegistry({ schemaPath: join(dataDir, 'nope.schema.json') })
    r.load()
    expect(r.get('invoices')!.status.reason).toMatch(/^the Silo Standard schema could not be read/)
  })

  it('a corrupt status.json is kept aside and rebuilt', () => {
    place('plans', refManifest('plans'))
    writeFileSync(join(regDir(), 'plans', 'status.json'), '{oops')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRegistry()
    r.load()
    expect(statusOf('plans').state).toBe('pending')
    expect(readdirSync(join(regDir(), 'plans')).some((f) => f.startsWith('status.json.corrupt-'))).toBe(true)
    warn.mockRestore()
  })
})

describe("SiloRegistry — status is the kernel's, written only when it changes", () => {
  it('a reload that finds the same silo leaves status.json untouched', async () => {
    place('plans', refManifest('plans'))
    let t = Date.parse('2026-10-30T10:00:00Z')
    const r = new SiloRegistry({ dataDir, now: () => new Date(t) })
    registries.push(r)
    r.load()
    const first = statusOf('plans')
    const mtime = statSync(join(regDir(), 'plans', 'status.json')).mtimeMs
    t += 60_000
    await new Promise((res) => setTimeout(res, 20))
    r.load()
    expect(statusOf('plans')).toEqual(first)
    expect(statSync(join(regDir(), 'plans', 'status.json')).mtimeMs).toBe(mtime)
  })

  it("the reader's counts survive a reload", () => {
    place('invoices', refManifest('invoices'))
    const r = makeRegistry()
    r.load()
    r.noteRecords('invoices', { parsed: 924, failed: 2, lastWrite: '2026-10-30T08:00:00Z' })
    r.noteRecords('nope', { parsed: 1, failed: 0, lastWrite: null })
    const r2 = makeRegistry()
    r2.load()
    expect(r2.describe()[0]).toMatchObject({ records: { parsed: 924, failed: 2 }, lastWrite: '2026-10-30T08:00:00Z' })
  })
})

describe('SiloRegistry — hot reload', () => {
  it('a manifest added, changed or removed after boot is picked up', async () => {
    const r = makeRegistry()
    r.load()
    r.watch()
    const changes: string[] = []
    r.on('change', (id: string) => changes.push(id))
    await new Promise((res) => setTimeout(res, 150)) // chokidar ready
    const file = place('plans', refManifest('plans'))
    await vi.waitFor(() => expect(r.get('plans')?.status.state).toBe('pending'), { timeout: 4000, interval: 25 })
    const broken = refManifest('plans')
    broken.spec.sources[0].parser = 'yaml'
    writeFileSync(file, JSON.stringify(broken))
    await vi.waitFor(() => expect(r.get('plans')?.status.state).toBe('error'), { timeout: 4000, interval: 25 })
    expect(r.get('plans')!.status.reason).toContain('spec.sources[0].parser must be one of json, md-frontmatter (found "yaml")')
    rmSync(join(regDir(), 'plans'), { recursive: true })
    await vi.waitFor(() => expect(r.get('plans')).toBeNull(), { timeout: 4000, interval: 25 })
    expect(changes.filter((c) => c === 'plans').length).toBeGreaterThanOrEqual(3)
  })
})

describe('deriveConvention / readManifest', () => {
  it.each([
    [{ id: 's', root: 'agent-state', glob: 'silos/invoices/*.json' }, 'agent-state:silos/invoices'],
    [{ id: 's', root: 'project', glob: 'plans/*.plan.json' }, 'project:plans'],
    [{ id: 's', root: 'project', glob: './context/documents/*.json' }, 'project:context/documents'],
    [{ id: 's', root: 'project', glob: 'context/*/documents/*.json' }, 'project:context'],
    [{ id: 's', root: 'agent-state', glob: 'silos/x/**/*.md' }, 'agent-state:silos/x'],
  ])('%j → %s', (src, conv) => {
    const c = deriveConvention(src)
    expect('error' in c ? c.error : c.convention).toBe(conv)
  })
  it.each([
    [{ id: 's', root: 'project', glob: '/etc/*.json' }, 'must be relative'],
    [{ id: 's', root: 'project', glob: 'a/../../b/*.json' }, 'climbs out'],
    [{ id: 's', root: 'project', glob: '**/*.json' }, 'names no folder of its own'],
  ])('%j is refused', (src, msg) => {
    const c = deriveConvention(src)
    expect('error' in c ? c.error : '').toContain(msg)
  })
  it('never throws on garbage', () => {
    expect(readManifest(null)).toMatchObject({ ok: false, reason: 'silo.json must hold a JSON object' })
    expect(readManifest([1])).toMatchObject({ ok: false })
    expect(readManifest('x')).toMatchObject({ ok: false })
  })
})

// GATE (step 1): loading a silo never touches the session parser, the
// session index or CACHE_VERSION — server/src/silos imports none of them.
describe('silos/ stays outside the transcripts cache', () => {
  it('no import of the session index, the parser or a harness', () => {
    const dir = join(import.meta.dirname, '..', 'src', 'silos')
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8')
      const specs = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!)
      for (const s of specs) expect(s, `${f} imports ${s}`).not.toMatch(/session-index|parser|harnesses\/|transcript|cache/)
      const code = src
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('//'))
        .join('\n')
      expect(code, f).not.toMatch(/CACHE_VERSION/)
    }
  })
})

describe('SiloRegistry — the look a silo brings (spec.theme)', () => {
  it('the descriptor carries it only while the silo is active, resolved (accent-soft derived), and only if it holds the contrast rule', () => {
    const m = refManifest('heather')
    place('heather', m)
    const pending = makeRegistry()
    pending.load()
    expect(pending.describe()[0]).toMatchObject({ state: 'pending', theme: null })
    const r = makeRegistry({ operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
    r.load()
    expect(r.describe()[0]!.theme).toEqual({
      name: 'Heather',
      light: { ...m.spec.theme.light },
      dark: { ...m.spec.theme.dark, 'accent-soft': 'rgba(229, 154, 201, 0.12)' },
    })
    // a manifest edited on disk under the rule is read, but its look is not offered
    const weak = refManifest('heather')
    weak.spec.theme.light.text = '#9a9a9a'
    place('heather', weak)
    r.load()
    expect(r.describe()[0]).toMatchObject({ state: 'active', theme: null })
  })
})
