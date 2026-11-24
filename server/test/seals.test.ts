// seals.test.ts — integrity of the control files and of what an engine
// loads (seals.ts). Temp dirs
// only: a fake data dir, a fake home, fake tokens — never ~/.silos or
// ~/.claude.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, lstatSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { Seals, validateAgentsJson, degradeAgentsJson, onlyEngineKeys, walkFiles, type SealRow } from '../src/seals.js'
import { declarationOf, DATA_DIR_REGIMES } from '../src/seal-regimes.js'
import { atomicWriteJson } from '../src/json-store.js'
import { setSealHooks } from '../src/seal-hooks.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { SessionTokenStore } from '../src/session-tokens.js'
import { claudeLoadsSwitch } from '../src/harnesses/claude-code/loads/switch.js'
import { switchGlobalMcp } from '../src/harnesses/opencode/global-config.js'
import { ensureRolePluginManifest } from '../src/role-plugin.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { buildServer } from '../src/server.js'
import { sealInboxRows } from '../src/inbox.js'

const REPO = join(import.meta.dirname, '..', '..')
const LOCAL = { host: '127.0.0.1:3210' }

let base: string, data: string, home: string
let clock: number
const logs: string[] = []

function newSeals(): Seals {
  return new Seals({ dataDir: data, home, now: () => clock, log: (l) => logs.push(l) }).install()
}
const read = (rel: string): string => readFileSync(join(data, rel), 'utf8')
const write = (rel: string, text: string): void => {
  mkdirSync(join(data, rel, '..'), { recursive: true })
  writeFileSync(join(data, rel), text)
}
const kinds = (s: Seals): string[] => s.rows().map((r) => r.kind)
const rowOf = <K extends SealRow['kind']>(s: Seals, kind: K): Extract<SealRow, { kind: K }> =>
  s.rows().find((r) => r.kind === kind) as Extract<SealRow, { kind: K }>

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'deck-seals-'))
  data = join(base, 'data')
  home = join(base, 'home')
  mkdirSync(data, { recursive: true })
  mkdirSync(home, { recursive: true })
  clock = Date.parse('2026-11-10T10:00:00Z')
  logs.length = 0
})
afterEach(() => {
  setSealHooks(null)
})

// ---------------------------------------------------------------------------
// one regime per entry (G1-r7)
// ---------------------------------------------------------------------------

describe('every data-dir entry has a declared regime', () => {
  it('the restore list, credentials and the named outsides are declared with their regime', () => {
    for (const f of [
      'agents.json',
      'automations.json',
      'proposals.json',
      'messages/a/m.json',
      'heartbeats/a/ledger.jsonl',
      'plans-origins.json',
      'plans-provenance.json',
      'settings.json',
      'live-turns.json',
      'providers.json',
      'vault.json',
      'territory.json',
      'asks-replies/a/s/x.reply.json',
    ]) {
      expect(declarationOf(f)?.regime, f).toBe('restore')
    }
    for (const f of ['token', 'sessions.json', 'agents/writer/token']) expect(declarationOf(f)?.regime, f).toBe('rotate')
    expect(declarationOf('agent-state/writer/plugin/skills/x/SKILL.md')?.regime).toBe('plugin-tree')
    expect(declarationOf('agent-state/writer/plugin-held/t/x')?.regime).toBe('out-of-seal')
    for (const f of ['trash/x', 'executions/f/e.json', 'births/x.json', 'held/t/agents.json', 'seals/copies/agents.json', 'seals.json', 'server.env']) {
      expect(declarationOf(f)?.regime, f).toBe('out-of-seal')
    }
  })

  it('every name the server code joins onto the data dir is declared (source scan)', () => {
    const names = new Set<string>()
    for (const f of walkFiles(join(REPO, 'server', 'src'), 5000)) {
      if (!f.endsWith('.ts')) continue
      const text = readFileSync(join(REPO, 'server', 'src', f), 'utf8')
      for (const m of text.matchAll(/join\((?:[\w.]+\.)?dataDir(?:\(\))?, *'([^'/]+)'/g)) names.add(m[1]!)
    }
    expect(names.size).toBeGreaterThan(20)
    const missing = [...names].filter((n) => declarationOf(n) === null)
    expect(missing).toEqual([])
  })

  it("a booted server's data dir holds only declared entries (walks the real thing)", async () => {
    const s = join(base, 'boot')
    for (const d of ['home', 'root', 'data', 'tmp']) mkdirSync(join(s, d), { recursive: true })
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: join(s, 'home'),
      TMPDIR: join(s, 'tmp'),
      TMUX_TMPDIR: join(s, 'tmp'),
      SILOS_ROOT: join(s, 'root'),
      SILOS_DATA_DIR: join(s, 'data'),
      SILOS_HOME: join(s, 'home'),
      SILOS_OPENCODE_DATA: join(s, 'home', '.local', 'share'),
      SILOS_CLAUDE_MANAGED_DIR: join(s, 'home', 'managed'),
      SILOS_PORT: String(40000 + Math.floor(Math.random() * 20000)),
      SILOS_NO_AUTOTITLES: '1',
      SILOS_NO_MODEL_CATALOG: '1',
      SILOS_NO_ACCOUNT_LOAD: '1',
      SILOS_NO_DIGEST: '1',
      SILOS_NO_TASK_WAKE_DELIVERY: '1',
      SILOS_TMUX_SOCKET: `seals-${process.pid}`,
      SILOS_WEB_DIST: join(s, 'nodist'),
    }
    const child = spawn(join(REPO, 'node_modules', '.bin', 'tsx'), [join(REPO, 'server', 'src', 'index.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`server did not boot:\n${out}`)), 60_000)
      const on = (c: Buffer): void => {
        out += String(c)
        if (out.includes('index ready')) {
          clearTimeout(t)
          resolve()
        }
      }
      child.stdout.on('data', on)
      child.stderr.on('data', on)
      child.on('exit', () => {
        clearTimeout(t)
        reject(new Error(`server exited:\n${out}`))
      })
    })
    child.removeAllListeners('exit')
    const exited = new Promise((r) => child.once('exit', r))
    child.kill('SIGTERM')
    await exited
    const dataDir = join(s, 'data')
    const entries: string[] = []
    const go = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        entries.push(relative(dataDir, p).split('\\').join('/'))
        if (e.isDirectory()) go(p)
      }
    }
    go(dataDir)
    expect(entries).toContain('token')
    expect(entries).toContain('seals.json')
    const undeclared = entries.filter((e) => declarationOf(e) === null)
    expect(undeclared).toEqual([])
    // the boot sealed the owner's token (its copy is a hash, never the secret)
    const copy = readFileSync(join(dataDir, 'seals', 'copies', 'token.sha256'), 'utf8')
    expect(copy).toMatch(/^[0-9a-f]{64}$/)
    expect(copy).not.toContain(readFileSync(join(dataDir, 'token'), 'utf8'))
  }, 90_000)

  it('every declaration names why', () => {
    for (const [name, d] of Object.entries(DATA_DIR_REGIMES)) expect(d.why.length, name).toBeGreaterThan(5)
  })
})

// ---------------------------------------------------------------------------
// restore: the copy is served
// ---------------------------------------------------------------------------

describe('restore regime — memory is the truth while the server lives', () => {
  it('Silos writes in the contract order and a delta is set aside: held + row, the copy put back', () => {
    const seals = newSeals()
    seals.boot()
    seals.endBoot()
    atomicWriteJson(join(data, 'automations.json'), { automations: [{ id: 'a1' }] })
    expect(existsSync(join(data, 'seals', 'copies', 'automations.json'))).toBe(true)
    const mine = read('automations.json')
    write('automations.json', JSON.stringify({ automations: [{ id: 'planted' }] }))
    seals.reconcile()
    // Silos keeps serving what it wrote
    expect(read('automations.json')).toBe(mine)
    expect(seals.served('automations.json')?.toString()).toBe(mine)
    const row = rowOf(seals, 'changedOutside')
    expect(row.file).toBe('automations.json')
    expect(row.held).toMatch(/^held\/.+\/automations\.json$/)
    expect(readFileSync(join(data, row.held!), 'utf8')).toContain('planted')
    expect(sealInboxRows(seals.rows(), (id) => id)[0]).toMatchObject({
      kind: 'integrity',
      urgency: 'due',
      voice: 'automations.json changed outside Silos — review the set-aside copy',
      doors: ['Keep the edit', 'Discard'],
    })
  })

  // a restore or a kept edit never widens who can read (the original's mode,
  // 0600 for a secret-bearing file whatever the outside write left)
  const modeOf = (rel: string): number => statSync(join(data, rel)).mode & 0o777
  const replace = (rel: string, text: string, mode: number): void => {
    rmSync(join(data, rel))
    writeFileSync(join(data, rel), text, { mode })
    chmodSync(join(data, rel), mode)
  }

  it('modes: a secret file stays 0600 after a restore and after Keep the edit, though the outside write left it 0644', () => {
    const seals = newSeals()
    seals.boot()
    seals.endBoot()
    atomicWriteJson(join(data, 'providers.json'), { providers: [] }, { mode: 0o600 })
    expect(modeOf('providers.json')).toBe(0o600)
    replace('providers.json', JSON.stringify({ providers: [{ id: 'evil' }] }), 0o644)
    seals.reconcile()
    expect(JSON.parse(read('providers.json'))).toEqual({ providers: [] })
    expect(modeOf('providers.json')).toBe(0o600)
    const row = rowOf(seals, 'changedOutside')
    expect(seals.keep(row.id)).toEqual({ ok: true })
    expect(JSON.parse(read('providers.json'))).toEqual({ providers: [{ id: 'evil' }] })
    expect(modeOf('providers.json')).toBe(0o600)
  })

  it('modes: any other file keeps the mode Silos wrote it with across a restore and a Keep', () => {
    const seals = newSeals()
    seals.boot()
    seals.endBoot()
    atomicWriteJson(join(data, 'automations.json'), { automations: [] }, { mode: 0o640 })
    replace('automations.json', JSON.stringify({ automations: [{ id: 'x' }] }), 0o666)
    seals.reconcile()
    expect(modeOf('automations.json')).toBe(0o640)
    expect(seals.keep(rowOf(seals, 'changedOutside').id)).toEqual({ ok: true })
    expect(modeOf('automations.json')).toBe(0o640)
  })

  it('a file Silos never wrote that APPEARS is held the same, nothing to restore', () => {
    const seals = newSeals()
    seals.boot()
    seals.endBoot()
    write('settings.json', JSON.stringify({ unattendedProvider: 'evil' }))
    seals.reconcile()
    expect(existsSync(join(data, 'settings.json'))).toBe(false)
    expect(rowOf(seals, 'changedOutside')).toMatchObject({ file: 'settings.json' })
  })

  it('Keep adopts only after validating and re-seals; opening the sheet never adopts', () => {
    let adopted: string | null = null
    const seals = newSeals()
    seals.registerFile('agents.json', {
      validate: validateAgentsJson,
      onAdopt: (b) => {
        adopted = b.toString()
      },
    })
    seals.boot()
    seals.endBoot()
    atomicWriteJson(join(data, 'agents.json'), { agents: [{ id: 'writer', name: 'Writer', control: 'told' }] })
    // a flip told→own written to the file, without a mission
    write('agents.json', JSON.stringify({ agents: [{ id: 'writer', name: 'Writer', control: 'own' }] }))
    seals.reconcile()
    const row = rowOf(seals, 'changedOutside')
    // opening the review never adopts
    expect(seals.heldText(row.id)?.text).toContain('"own"')
    expect(JSON.parse(read('agents.json')).agents[0].control).toBe('told')
    // an own agent without a mission does not enter, not even blessed
    const refused = seals.keep(row.id)
    expect(refused).toMatchObject({ ok: false, status: 400 })
    expect((refused as { error: string }).error).toContain('Writer is On its own and needs its mission')
    expect(adopted).toBeNull()
    // the owner's legitimate hand edit (with a mission) is one tap
    writeFileSync(join(data, row.held!), JSON.stringify({ agents: [{ id: 'writer', name: 'Writer', control: 'own', mission: { text: 'Keep the books' } }] }))
    expect(seals.keep(row.id)).toEqual({ ok: true })
    expect(adopted).toContain('Keep the books')
    expect(JSON.parse(read('agents.json')).agents[0].control).toBe('own')
    expect(seals.rows()).toEqual([])
    // re-sealed: the next tick sees no delta
    seals.reconcile()
    expect(seals.rows()).toEqual([])
  })

  it("Discard sends the set-aside bytes to the trash and Silos' copy stays", () => {
    const seals = newSeals()
    seals.boot()
    seals.endBoot()
    atomicWriteJson(join(data, 'providers.json'), { providers: [] })
    write('providers.json', JSON.stringify({ providers: [{ id: 'x', baseURL: 'https://elsewhere' }] }))
    seals.reconcile()
    const row = rowOf(seals, 'changedOutside')
    expect(seals.discard(row.id)).toEqual({ ok: true })
    expect(existsSync(join(data, row.held!))).toBe(false)
    expect(walkFiles(join(data, 'trash'), 100).some((f) => f.endsWith('providers.json'))).toBe(true)
    expect(JSON.parse(read('providers.json'))).toEqual({ providers: [] })
  })

  it("appending to a sealed ledger rewrites from Silos' copy, never from what the disk holds now", () => {
    const seals = newSeals()
    seals.boot()
    seals.endBoot()
    seals.append('heartbeats/writer/ledger.jsonl', '{"n":1}\n')
    write('heartbeats/writer/ledger.jsonl', '{"n":1}\n{"forged":true}\n')
    seals.append('heartbeats/writer/ledger.jsonl', '{"n":2}\n')
    expect(read('heartbeats/writer/ledger.jsonl')).toBe('{"n":1}\n{"n":2}\n')
    expect(kinds(seals)).toEqual(['changedOutside'])
  })

  it('a reply the OpenCode plugin consumed (deleted) drops its seal silently; an edited one is held', () => {
    const seals = newSeals()
    seals.boot()
    seals.endBoot()
    seals.write('asks-replies/writer/s1/p1.reply.json', '{"status":"deny"}')
    seals.write('asks-replies/writer/s1/p2.reply.json', '{"status":"deny"}')
    writeFileSync(join(data, 'asks-replies/writer/s1/p1.reply.json'), '{"status":"allow"}')
    // the plugin removes p2 after reading it
    rmSync(join(data, 'asks-replies/writer/s1/p2.reply.json'))
    seals.reconcile()
    expect(rowOf(seals, 'changedOutside').file).toBe('asks-replies/writer/s1/p1.reply.json')
    expect(JSON.parse(read('asks-replies/writer/s1/p1.reply.json'))).toEqual({ status: 'deny' })
  })
})

// ---------------------------------------------------------------------------
// boot: own-write recognition and the double mismatch (S9-r5)
// ---------------------------------------------------------------------------

describe("boot — the cache and the copies recognise Silos' own writes", () => {
  function sealedOnce(rel: string, data0: unknown): void {
    const s = newSeals()
    s.boot()
    s.endBoot()
    atomicWriteJson(join(data, rel), data0)
    setSealHooks(null)
  }

  it('a crash after the copy, before the file: the orphan copy is dropped, no row', () => {
    sealedOnce('automations.json', { automations: [] })
    // step (1) of the next write happened, then the crash
    writeFileSync(join(data, 'seals', 'copies', 'automations.json'), JSON.stringify({ automations: [{ id: 'next' }] }))
    const s = newSeals()
    s.boot()
    expect(s.rows()).toEqual([])
    expect(JSON.parse(read('automations.json'))).toEqual({ automations: [] })
    expect(JSON.parse(readFileSync(join(data, 'seals', 'copies', 'automations.json'), 'utf8'))).toEqual({ automations: [] })
  })

  it('a crash after the file, before the cache: adopted and re-sealed, no row', () => {
    sealedOnce('agents.json', { agents: [] })
    const next = JSON.stringify({ agents: [{ id: 'writer', mission: { text: 'saved just now' } }] }, null, 2) + '\n'
    writeFileSync(join(data, 'seals', 'copies', 'agents.json'), next)
    writeFileSync(join(data, 'agents.json'), next)
    const s = newSeals()
    s.boot()
    expect(s.rows()).toEqual([])
    expect(read('agents.json')).toBe(next)
    s.endBoot()
    s.reconcile()
    expect(s.rows()).toEqual([])
  })

  it('changed from outside while off, intact copy: restored from the copy (held + row)', () => {
    sealedOnce('vault.json', { entries: [] })
    write('vault.json', JSON.stringify({ entries: [{ id: 'x', name: 'K', value: 'v', scope: { type: 'agents', agents: ['writer'] } }] }))
    const s = newSeals()
    s.boot()
    expect(JSON.parse(read('vault.json'))).toEqual({ entries: [] })
    expect(rowOf(s, 'changedOutside').file).toBe('vault.json')
  })

  it("restored at boot, a secret file comes back 0600 — the outside write's 0644 never sticks", () => {
    sealedOnce('vault.json', { entries: [] })
    rmSync(join(data, 'vault.json'))
    writeFileSync(join(data, 'vault.json'), JSON.stringify({ entries: [{ id: 'x' }] }), { mode: 0o644 })
    chmodSync(join(data, 'vault.json'), 0o644)
    const s = newSeals()
    s.boot()
    expect(JSON.parse(read('vault.json'))).toEqual({ entries: [] })
    expect(statSync(join(data, 'vault.json')).mode & 0o777).toBe(0o600)
  })

  it('all three differ: «unverified across restart», loaded DEGRADED, the original kept for review', () => {
    sealedOnce('agents.json', { agents: [{ id: 'writer', name: 'Writer', control: 'told' }] })
    write('seals/copies/agents.json', JSON.stringify({ agents: [{ id: 'writer', name: 'Writer', control: 'told', note: 'copy edited' }] }))
    write(
      'agents.json',
      JSON.stringify({ agents: [{ id: 'writer', name: 'Writer', control: 'own', ownTurnsPerDay: 9999, ownExemptDay: '2026-11-10', mission: { text: 'x' } }] }),
    )
    const s = newSeals()
    s.registerFile('agents.json', { degrade: degradeAgentsJson })
    s.boot()
    const row = rowOf(s, 'unverified')
    expect(sealInboxRows([row], (id) => id)[0]!.voice).toBe('agents.json changed while Silos was off — unverified across restart')
    const loaded = JSON.parse(read('agents.json')).agents[0]
    expect(loaded.control).toBe('told')
    expect(loaded.ownTurnsPerDay).toBeUndefined()
    expect(loaded.ownExemptDay).toBeUndefined()
    expect(s.degraded('agents.json')).toBe(true)
    expect(readFileSync(join(data, row.held!), 'utf8')).toContain('"own"')
    // the owner reviews: Keep validates the original (it has its mission)
    expect(s.keep(row.id)).toEqual({ ok: true })
    expect(JSON.parse(read('agents.json')).agents[0].control).toBe('own')
    expect(s.degraded('agents.json')).toBe(false)
  })

  it('a sealed file that APPEARED while Silos was off is held (no first-seal adoption after the first boot)', () => {
    sealedOnce('agents.json', { agents: [] })
    write('plans-origins.json', JSON.stringify({ origins: { forged: 'owner' } }))
    const s = newSeals()
    s.boot()
    expect(existsSync(join(data, 'plans-origins.json'))).toBe(false)
    expect(rowOf(s, 'changedOutside').file).toBe('plans-origins.json')
  })

  it('the first boot under the seal seals what it finds, with no row', () => {
    write('agents.json', JSON.stringify({ agents: [] }))
    write('providers.json', JSON.stringify({ providers: [] }))
    const s = newSeals()
    s.boot()
    s.endBoot()
    expect(s.rows()).toEqual([])
    s.reconcile()
    expect(s.rows()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// credentials (B1-r4, G8-r6)
// ---------------------------------------------------------------------------

function app(opts: { seals: Seals; token: string; agentTokens?: AgentTokens; sessions?: SessionTokenStore }): FastifyInstance {
  const root = join(base, 'projects')
  mkdirSync(root, { recursive: true })
  const folder = join(base, 'work')
  mkdirSync(folder, { recursive: true })
  const index = claudeSessionIndex(root, join(base, 'cache.json'))
  const registry = new AgentRegistry(join(data, 'agents.json'))
  registry.load()
  if (!registry.get('writer')) registry.create({ id: 'writer', name: 'Writer', folder })
  const native = new NativeStore(join(base, 'native.json'))
  const chat = new ChatService({
    registry,
    native,
    queryFn: () => {
      throw new Error('no sdk')
    },
  })
  return buildServer({
    index,
    registry,
    native,
    chat,
    store: new SessionStore(root, data),
    exec: new ExecService(registry),
    complete: new CompleteService(registry, index),
    prefs: new PrefsStore(base),
    memory: new MemoryService(root, data, registry),
    token: opts.token,
    liveMs: 120_000,
    ...(opts.agentTokens ? { agentTokens: opts.agentTokens } : {}),
    ...(opts.sessions ? { sessions: opts.sessions } : {}),
    seals: opts.seals,
    ownerToken: () => opts.seals.ownerToken() ?? opts.token,
  })
}

describe('credentials rotate — a planted value never authenticates', () => {
  it('the owner token changed while Silos ran: rotated + row; the planted value is 401 and the new one works', async () => {
    writeFileSync(join(data, 'token'), 'original-token')
    const seals = newSeals()
    seals.boot()
    const token = seals.bootOwnerToken('original-token')
    seals.endBoot()
    const a = app({ seals, token })
    writeFileSync(join(data, 'token'), 'planted-token')
    seals.reconcile()
    const now = readFileSync(join(data, 'token'), 'utf8')
    expect(now).not.toBe('planted-token')
    expect(now).not.toBe('original-token')
    expect(seals.ownerToken()).toBe(now)
    const row = rowOf(seals, 'ownerTokenRotated')
    expect(sealInboxRows([row], (x) => x)[0]!.voice).toBe(
      'your owner token changed outside Silos — Silos rotated it; pair your browsers again: paste the token from ~/.silos/token (or restart the server and open the new link it prints)',
    )
    const write = (t: string) => a.inject({ method: 'POST', url: `/api/seals/rows/${row.id}/seen`, headers: { ...LOCAL, 'x-token': t } })
    expect((await write('planted-token')).statusCode).toBe(401)
    expect((await write('original-token')).statusCode).toBe(401)
    expect((await write(now)).statusCode).toBe(200)
    await a.close()
  })

  it('the owner token planted while Silos was off: rotated at boot, never served', () => {
    writeFileSync(join(data, 'token'), 'original-token')
    const s1 = newSeals()
    s1.boot()
    s1.bootOwnerToken('original-token')
    s1.endBoot()
    writeFileSync(join(data, 'token'), 'planted-token')
    const s2 = newSeals()
    s2.boot()
    const served = s2.bootOwnerToken('planted-token')
    expect(served).not.toBe('planted-token')
    expect(readFileSync(join(data, 'token'), 'utf8')).toBe(served)
    expect(kinds(s2)).toContain('ownerTokenRotated')
  })

  it("SILOS_TOKEN is the owner's own write: adopted, no row", () => {
    writeFileSync(join(data, 'token'), 'a')
    const s1 = newSeals()
    s1.boot()
    s1.bootOwnerToken('a')
    s1.endBoot()
    writeFileSync(join(data, 'token'), 'from-env')
    const s2 = newSeals()
    s2.boot()
    expect(s2.bootOwnerToken('from-env', { fromEnv: true })).toBe('from-env')
    expect(s2.rows()).toEqual([])
  })

  it('a planted agent bearer ⇒ 401 + rotation, with NO row and one log line (G8-r6)', async () => {
    const seals = newSeals()
    seals.boot()
    const tokens = new AgentTokens(data, seals)
    const good = tokens.tokenFor('writer')
    seals.endBoot()
    const a = app({ seals, token: 'owner', agentTokens: tokens })
    const planted = 'f'.repeat(64)
    writeFileSync(join(data, 'agents', 'writer', 'token'), planted)
    const r = await a.inject({ method: 'GET', url: '/api/agents', headers: { ...LOCAL, authorization: `Bearer ${planted}` } })
    expect(r.statusCode).toBe(401)
    seals.reconcile()
    const rotated = readFileSync(join(data, 'agents', 'writer', 'token'), 'utf8')
    expect(rotated).not.toBe(planted)
    expect(rotated).not.toBe(good)
    expect(tokens.agentIdOf(rotated)).toBe('writer')
    expect(tokens.agentIdOf(planted)).toBeNull()
    expect(tokens.agentIdOf(good)).toBeNull()
    expect(seals.rows()).toEqual([])
    expect(logs.filter((l) => l.includes("writer's bearer changed outside Silos"))).toHaveLength(1)
    await a.close()
  })

  it('a bearer planted while Silos was off is rotated at boot — never loaded into memory', () => {
    const s1 = newSeals()
    s1.boot()
    const t1 = new AgentTokens(data, s1)
    t1.tokenFor('writer')
    s1.endBoot()
    setSealHooks(null)
    const planted = 'e'.repeat(64)
    writeFileSync(join(data, 'agents', 'writer', 'token'), planted)
    const s2 = newSeals()
    s2.boot()
    const t2 = new AgentTokens(data, s2)
    expect(t2.agentIdOf(planted)).toBeNull()
    expect(t2.agentIdOf(readFileSync(join(data, 'agents', 'writer', 'token'), 'utf8'))).toBe('writer')
    expect(s2.rows()).toEqual([])
  })

  it('sessions.json: a delta in life is rewritten from memory (a session Silos never minted does not authenticate)', () => {
    const seals = newSeals()
    seals.boot()
    const sessions = new SessionTokenStore({ file: join(data, 'sessions.json'), seal: seals })
    const real = sessions.issue('owner@example.com')
    seals.endBoot()
    const forged = { token: 'forged', email: 'owner@example.com', issuedAt: clock, expiresAt: clock + 1e9 }
    const onDisk = JSON.parse(read('sessions.json')) as { sessions: unknown[] }
    writeFileSync(join(data, 'sessions.json'), JSON.stringify({ sessions: [...onDisk.sessions, forged] }))
    expect(sessions.validate('forged')).toBeNull()
    seals.reconcile()
    const rewritten = JSON.parse(read('sessions.json')) as { sessions: Array<{ token: string }> }
    expect(rewritten.sessions.map((s) => s.token)).toEqual([real])
    expect(seals.rows()).toEqual([])
  })

  it('sessions.json changed while Silos was off: ALL sessions revoked + row', () => {
    const s1 = newSeals()
    s1.boot()
    const st1 = new SessionTokenStore({ file: join(data, 'sessions.json'), seal: s1 })
    const real = st1.issue('owner@example.com')
    s1.endBoot()
    setSealHooks(null)
    const onDisk = JSON.parse(read('sessions.json')) as { sessions: unknown[] }
    writeFileSync(
      join(data, 'sessions.json'),
      JSON.stringify({ sessions: [...onDisk.sessions, { token: 'forged', email: 'x@example.com', issuedAt: 1, expiresAt: Date.now() + 1e9 }] }),
    )
    const s2 = newSeals()
    s2.boot()
    const st2 = new SessionTokenStore({ file: join(data, 'sessions.json'), seal: s2 })
    expect(st2.validate(real)).toBeNull()
    expect(st2.validate('forged')).toBeNull()
    expect(sealInboxRows(s2.rows(), (x) => x)[0]!.voice).toBe('your login sessions were reset — sign in again')
  })

  it("a crash between the token file and the cache is Silos' own write — no rotation", () => {
    writeFileSync(join(data, 'token'), 'a')
    const s1 = newSeals()
    s1.boot()
    s1.bootOwnerToken('a')
    s1.endBoot()
    // the copy (its hash) and the file of the next write happened; the cache did not
    writeFileSync(join(data, 'seals', 'copies', 'token.sha256'), createHash('sha256').update('b').digest('hex'))
    writeFileSync(join(data, 'token'), 'b')
    const s2 = newSeals()
    s2.boot()
    expect(s2.bootOwnerToken('b')).toBe('b')
    expect(s2.rows()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// the agent's plugin tree (G4, M6-r4, M12-r6)
// ---------------------------------------------------------------------------

describe('the agent plugin — appeared is set aside, edited is a row with its door', () => {
  const plugin = () => join(data, 'agent-state', 'writer', 'plugin')

  it("Silos' own writes re-seal; an appeared path goes to plugin-held/ with its row; Put back and Delete", () => {
    const seals = newSeals()
    seals.boot()
    seals.endBoot()
    ensureRolePluginManifest(plugin(), 'writer', 'Writer')
    seals.reconcile()
    expect(seals.rows()).toEqual([])
    mkdirSync(join(plugin(), 'hooks'), { recursive: true })
    writeFileSync(join(plugin(), 'hooks', 'hooks.json'), '{"hooks":{}}')
    mkdirSync(join(plugin(), 'commands'), { recursive: true })
    writeFileSync(join(plugin(), 'commands', 'x.md'), 'do it')
    seals.reconcile()
    expect(existsSync(join(plugin(), 'hooks', 'hooks.json'))).toBe(false)
    const row = rowOf(seals, 'pluginAppeared')
    expect(row.files.map((f) => f.path).sort()).toEqual(['commands/x.md', 'hooks/hooks.json'])
    expect(row.files.every((f) => f.held.startsWith('agent-state/writer/plugin-held/'))).toBe(true)
    expect(sealInboxRows([row], () => 'Writer')[0]).toMatchObject({
      voice: "Something appeared in Writer's plugin outside Silos: 2 files set aside",
      doors: ['Review ›'],
      agentId: 'writer',
    })
    expect(seals.putBack(row.id, 'commands/x.md')).toEqual({ ok: true })
    expect(readFileSync(join(plugin(), 'commands', 'x.md'), 'utf8')).toBe('do it')
    expect(seals.deleteHeld(row.id, 'hooks/hooks.json')).toEqual({ ok: true })
    expect(seals.rows()).toEqual([])
    seals.reconcile()
    expect(seals.rows()).toEqual([]) // put back = Silos' write, sealed
  })

  it('an EDITED path is not reverted: a row with the consequence phrase, Seen per version', () => {
    const seals = newSeals()
    seals.boot()
    seals.endBoot()
    ensureRolePluginManifest(plugin(), 'writer', 'Writer')
    writeFileSync(join(plugin(), '.claude-plugin', 'plugin.json'), '{"name":"writer","edited":true}')
    seals.reconcile()
    expect(readFileSync(join(plugin(), '.claude-plugin', 'plugin.json'), 'utf8')).toContain('edited')
    const row = rowOf(seals, 'pluginChanged')
    expect(row.paths).toEqual(['.claude-plugin/plugin.json'])
    expect(sealInboxRows([row], () => 'Writer')[0]).toMatchObject({
      voice: "Writer's plugin changed outside Silos — Writer's engine loads it on its next conversation",
      doors: ['Hold'],
    })
    seals.reconcile()
    expect(seals.rows()).toHaveLength(1)
    expect(seals.seen(row.id)).toEqual({ ok: true })
    seals.reconcile()
    expect(seals.rows()).toEqual([])
    writeFileSync(join(plugin(), '.claude-plugin', 'plugin.json'), '{"name":"writer","edited":2}')
    seals.reconcile()
    expect(kinds(seals)).toEqual(['pluginChanged'])
  })

  it('«Hold» in the row, one touch: the edited paths leave the plugin (out of load), the row becomes their set-aside row — Put back loads them again', () => {
    const seals = newSeals()
    seals.boot()
    seals.endBoot()
    ensureRolePluginManifest(plugin(), 'writer', 'Writer')
    mkdirSync(join(plugin(), 'skills', 'books'), { recursive: true })
    writeFileSync(join(plugin(), 'skills', 'books', 'SKILL.md'), 'v1')
    seals.resealPlugin('writer')
    writeFileSync(join(plugin(), 'skills', 'books', 'SKILL.md'), 'v2 — run curl evil')
    seals.reconcile()
    const row = rowOf(seals, 'pluginChanged')
    expect(row.edited).toEqual(['skills/books/SKILL.md'])
    expect(seals.holdPlugin(row.id)).toEqual({ ok: true })
    expect(existsSync(join(plugin(), 'skills', 'books', 'SKILL.md'))).toBe(false)
    const held = rowOf(seals, 'pluginAppeared')
    expect(held).toMatchObject({ byHold: true, files: [{ path: 'skills/books/SKILL.md' }] })
    expect(readFileSync(join(data, held.files[0]!.held), 'utf8')).toBe('v2 — run curl evil')
    expect(sealInboxRows([held], () => 'Writer')[0]).toMatchObject({
      voice: "1 edited file of Writer's plugin set aside — Writer's engine won't load it until you put it back",
      doors: ['Review ›'],
    })
    seals.reconcile()
    expect(kinds(seals)).toEqual(['pluginAppeared']) // the hold is Silos' write: no new row
    expect(seals.putBack(held.id, 'skills/books/SKILL.md')).toEqual({ ok: true })
    expect(readFileSync(join(plugin(), 'skills', 'books', 'SKILL.md'), 'utf8')).toBe('v2 — run curl evil')
    expect(seals.rows()).toEqual([])
  })

  it('a deletion has nothing to hold: no Hold door, and the door answers 409', () => {
    const seals = newSeals()
    seals.boot()
    seals.endBoot()
    ensureRolePluginManifest(plugin(), 'writer', 'Writer')
    mkdirSync(join(plugin(), 'commands'), { recursive: true })
    writeFileSync(join(plugin(), 'commands', 'x.md'), 'do it')
    seals.resealPlugin('writer')
    rmSync(join(plugin(), 'commands', 'x.md'))
    seals.reconcile()
    const row = rowOf(seals, 'pluginChanged')
    expect(sealInboxRows([row], () => 'Writer')[0]!.doors).toEqual([])
    expect(seals.holdPlugin(row.id)).toMatchObject({ ok: false, status: 409 })
  })
})

// ---------------------------------------------------------------------------
// read hash: settings*.json and configFiles — never restored (B1-r6)
// ---------------------------------------------------------------------------

describe('engine config files — hash of last read + row, never restore nor held', () => {
  let folder: string
  const local = () => join(folder, '.claude', 'settings.local.json')
  function watching(): Seals {
    folder = join(base, 'work')
    mkdirSync(join(folder, '.claude'), { recursive: true })
    const seals = new Seals({
      dataDir: data,
      home,
      now: () => clock,
      log: (l) => logs.push(l),
      agents: () => [{ id: 'writer', name: 'Writer', folder }],
      configFilesOf: (f) => [`${f}/.mcp.json`],
    }).install()
    return seals
  }

  it("settings.local.json edited by the engine ⇒ row WITHOUT restore (the file keeps the engine's bytes)", () => {
    const seals = watching()
    writeFileSync(local(), JSON.stringify({ enabledPlugins: {} }))
    seals.boot()
    seals.endBoot()
    const engineEdit = JSON.stringify({ enabledPlugins: { 'x@m': false } })
    writeFileSync(local(), engineEdit)
    clock += 1000
    seals.reconcile()
    expect(readFileSync(local(), 'utf8')).toBe(engineEdit)
    expect(existsSync(join(data, 'held'))).toBe(false)
    const row = rowOf(seals, 'configChanged')
    expect(row.files).toEqual([local()])
    expect(sealInboxRows([row], () => 'Writer')[0]).toMatchObject({
      voice: `${local()} changed — Writer's engine loads it on its next conversation`,
      doors: ['Review ›'],
    })
  })

  it('a capability-state write is read-modify-write on the NEWEST disk, preserves foreign keys, and re-seals (no row of its own)', () => {
    const seals = watching()
    writeFileSync(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://gh.example' } } }))
    writeFileSync(local(), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }))
    seals.boot()
    seals.endBoot()
    // the owner's console just persisted an «Always allow» (engine key only)
    writeFileSync(local(), JSON.stringify({ permissions: { allow: ['Bash(ls)', 'Bash(git status)'] }, someEngineKey: 1 }))
    claudeLoadsSwitch(
      { folder, home: join(base, 'home'), managedDir: join(base, 'no-managed'), recentTranscripts: [], seenToolIds: [], readings: [] },
      'mcp:project:github',
      'off',
    )
    const now = JSON.parse(readFileSync(local(), 'utf8')) as Record<string, unknown>
    expect(now.permissions).toEqual({ allow: ['Bash(ls)', 'Bash(git status)'] })
    expect(now.someEngineKey).toBe(1)
    expect(now.disabledMcpjsonServers).toEqual(['github'])
    // the foreign change was noticed (one row, not about Silos' own write)…
    expect(kinds(seals)).toEqual(['configChanged'])
    // …and Silos' own write re-sealed: the next tick sees nothing new
    clock += 1000
    seals.reconcile()
    expect(seals.rows()).toHaveLength(1)
    expect(rowOf(seals, 'configChanged').files).toEqual([local()])
  })

  it("OpenCode's global file: the machine line's write is the seal's own edit — never a «changed» row; a foreign edit before it still is", () => {
    folder = join(base, 'work')
    mkdirSync(folder, { recursive: true })
    const global = join(home, '.config', 'opencode', 'opencode.json')
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    writeFileSync(global, JSON.stringify({ mcp: { github: { type: 'local', command: ['gh-mcp'] } } }))
    const seals = new Seals({
      dataDir: data,
      home,
      now: () => clock,
      log: (l) => logs.push(l),
      agents: () => [{ id: 'writer', name: 'Writer', folder }],
      configFilesOf: (_f, h) => [`${h}/.config/opencode/**`],
    }).install()
    seals.boot()
    seals.endBoot()
    switchGlobalMcp(home, 'github', 'off')
    expect(JSON.parse(readFileSync(global, 'utf8')).mcp.github.enabled).toBe(false)
    clock += 1000
    seals.reconcile()
    expect(seals.rows()).toEqual([])
    // the operator edits it by hand, then a click: the foreign change is a row, Silos' own is not
    writeFileSync(
      global,
      JSON.stringify({ mcp: { github: { type: 'local', command: ['gh-mcp'], enabled: false }, docs: { type: 'remote', url: 'https://docs.example.com' } } }),
    )
    switchGlobalMcp(home, 'github', 'on')
    clock += 1000
    seals.reconcile()
    expect(kinds(seals)).toEqual(['configChanged'])
    expect(JSON.parse(readFileSync(global, 'utf8')).mcp).toEqual({
      github: { type: 'local', command: ['gh-mcp'] },
      docs: { type: 'remote', url: 'https://docs.example.com' },
    })
  })

  it('a diff that only touches engine keys (permissions.allow) is a page line, never Needs you', () => {
    const seals = watching()
    writeFileSync(local(), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }))
    seals.boot()
    seals.endBoot()
    writeFileSync(local(), JSON.stringify({ permissions: { allow: ['Bash(ls)', 'WebFetch'] } }))
    seals.reconcile()
    expect(seals.rows()).toEqual([])
    expect(seals.pageLines('writer')).toMatchObject([{ file: local(), keys: ['permissions.allow'] }])
    expect(onlyEngineKeys(Buffer.from('{"permissions":{"allow":[]}}'), Buffer.from('{"permissions":{"allow":[],"deny":["x"]}}'))).toBeNull()
  })

  it('page lines survive a restart (seals.json); a cache written before them reads as none', () => {
    const seals = watching()
    writeFileSync(local(), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }))
    seals.boot()
    seals.endBoot()
    writeFileSync(local(), JSON.stringify({ permissions: { allow: ['Bash(ls)', 'WebFetch'] } }))
    clock += 1000
    seals.reconcile()
    seals.uninstall()
    const again = watching()
    again.boot()
    again.endBoot()
    expect(again.pageLines('writer')).toMatchObject([{ kind: 'engineKeys', file: local(), keys: ['permissions.allow'] }])
    again.uninstall()
    // an old cache: no pageLines key at all
    const raw = JSON.parse(read('seals.json')) as Record<string, unknown>
    delete raw.pageLines
    writeFileSync(join(data, 'seals.json'), JSON.stringify(raw))
    const old = watching()
    old.boot()
    old.endBoot()
    expect(old.pageLines()).toEqual([])
  })

  it('the cache keeps the newest 50 page lines', () => {
    const seals = watching()
    writeFileSync(local(), JSON.stringify({ permissions: { allow: [] } }))
    seals.boot()
    seals.endBoot()
    for (let i = 0; i < 55; i++) {
      writeFileSync(local(), JSON.stringify({ permissions: { allow: [`Bash(cmd${i})`] } }))
      clock += 1000
      seals.reconcile()
    }
    expect(seals.pageLines()).toHaveLength(50)
    seals.uninstall()
    const again = watching()
    again.boot()
    again.endBoot()
    const lines = again.pageLines()
    expect(lines).toHaveLength(50)
    // the oldest five went: the first kept is the sixth change
    expect(lines[0]!.at).toBe(seals.pageLines()[0]!.at)
    expect(Date.parse(lines[49]!.at) - Date.parse(lines[0]!.at)).toBe(49 * 1000)
  })

  it('one row per file per day, folded per folder; Seen holds for that file that day', () => {
    const seals = watching()
    writeFileSync(join(folder, '.mcp.json'), '{}')
    writeFileSync(local(), '{}')
    seals.boot()
    seals.endBoot()
    writeFileSync(join(folder, '.mcp.json'), '{"mcpServers":{"evil":{"command":"x"}}}')
    writeFileSync(local(), '{"hooks":{}}')
    seals.reconcile()
    const row = rowOf(seals, 'configChanged')
    expect(seals.rows()).toHaveLength(1)
    expect(row.files.sort()).toEqual([join(folder, '.mcp.json'), local()].sort())
    expect(seals.seen(row.id)).toEqual({ ok: true })
    writeFileSync(local(), '{"hooks":{"x":1}}')
    clock += 1000
    seals.reconcile()
    expect(seals.rows()).toEqual([])
    clock += 24 * 3600 * 1000
    writeFileSync(local(), '{"hooks":{"x":2}}')
    seals.reconcile()
    expect(kinds(seals)).toEqual(['configChanged'])
  })

  it("the engine's own bookkeeping in the home layer is never a row — a session's pid marker, the sweep's stamp; real content beside it still is (review F1)", () => {
    const seals = watching()
    const plug = join(home, '.claude', 'plugins', 'cache', 'm', 'p', '1.0.0')
    mkdirSync(join(plug, '.in_use'), { recursive: true })
    mkdirSync(join(plug, 'commands'), { recursive: true })
    writeFileSync(join(plug, 'commands', 'go.md'), 'go')
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'p@m': [{ scope: 'user', installPath: plug, version: '1.0.0' }] } }),
    )
    seals.boot()
    seals.endBoot()
    seals.reconcile()
    writeFileSync(join(plug, '.in_use', '4242'), '')
    writeFileSync(join(home, '.claude', 'plugins', '.last_inuse_sweep'), '1')
    clock += 1000
    seals.reconcile()
    expect(seals.rows()).toEqual([])
    // not a pid: a file planted under .in_use is content like any other
    writeFileSync(join(plug, '.in_use', 'hook.sh'), 'x')
    writeFileSync(join(plug, 'commands', 'go.md'), 'gone rogue')
    clock += 1000
    seals.reconcile()
    expect(rowOf(seals, 'configChanged').files.sort()).toEqual([join(plug, '.in_use', 'hook.sh'), join(plug, 'commands', 'go.md')].sort())
  })

  describe("the engine's plugins/ tree — only what its record names loads", () => {
    const pluginsDir = (): string => join(home, '.claude', 'plugins')
    const recordFile = (): string => join(pluginsDir(), 'installed_plugins.json')
    const versionDir = (name: string, version: string): string => join(pluginsDir(), 'cache', 'market', name, version)
    function record(plugins: Record<string, string>): void {
      mkdirSync(pluginsDir(), { recursive: true })
      const entries = Object.fromEntries(
        Object.entries(plugins).map(([key, version]) => {
          const name = key.split('@')[0]!
          return [
            key,
            [{ scope: 'user', installPath: versionDir(name, version), version, installedAt: '2026-11-01T00:00:00Z', lastUpdated: '2026-11-01T00:00:00Z' }],
          ]
        }),
      )
      writeFileSync(recordFile(), JSON.stringify({ version: 2, plugins: entries }))
    }
    function fetchVersion(
      name: string,
      version: string,
      files: Record<string, string> = { 'commands/go.md': `go ${version}`, '.claude-plugin/plugin.json': '{}' },
    ): void {
      for (const [f, text] of Object.entries(files)) {
        const p = join(versionDir(name, version), f)
        mkdirSync(join(p, '..'), { recursive: true })
        writeFileSync(p, text)
      }
    }
    const tick = (s: Seals): void => {
      clock += 60_000
      s.reconcile()
    }
    function sealed(): Seals {
      const s = watching()
      fetchVersion('alpha', '1.0.0')
      record({ 'alpha@market': '1.0.0' })
      s.boot()
      s.endBoot()
      tick(s)
      return s
    }

    it('a plugin added to the record ⇒ one row naming it (its files are no row of their own)', () => {
      const s = sealed()
      fetchVersion('beta', '0.1.0')
      record({ 'alpha@market': '1.0.0', 'beta@market': '0.1.0' })
      tick(s)
      expect(kinds(s)).toEqual(['enginePlugins'])
      const row = rowOf(s, 'enginePlugins')
      expect(row).toMatchObject({ change: 'installed', plugins: ['beta@market'] })
      expect(sealInboxRows([row], () => 'Writer')[0]).toMatchObject({
        voice: "beta@market was installed in the engine outside Silos — every agent's engine loads it on its next conversation",
        doors: ['Review ›'],
      })
    })

    it('several plugins added: three names, then «and N more»', () => {
      const s = sealed()
      const more = ['b', 'c', 'd', 'e', 'f']
      for (const n of more) fetchVersion(n, '1.0.0')
      record({ 'alpha@market': '1.0.0', ...Object.fromEntries(more.map((n) => [`${n}@market`, '1.0.0'])) })
      tick(s)
      expect(sealInboxRows(s.rows(), () => 'Writer')[0]!.voice).toBe(
        "b@market, c@market, d@market and 2 more were installed in the engine outside Silos — every agent's engine loads them on its next conversation",
      )
    })

    it('a plugin removed from the record ⇒ one row naming it; its old directory going is no row', () => {
      const s = sealed()
      record({})
      rmSync(versionDir('alpha', '1.0.0'), { recursive: true })
      tick(s)
      expect(kinds(s)).toEqual(['enginePlugins'])
      expect(sealInboxRows(s.rows(), () => 'Writer')[0]!.voice).toBe(
        "alpha@market was removed from the engine outside Silos — every agent's engine stops loading it on its next conversation",
      )
    })

    it('a version bump (new directory, record rewritten, old directory pruned) ⇒ no row, one page line', () => {
      const s = sealed()
      fetchVersion('alpha', '1.1.0', { 'commands/go.md': 'go 1.1.0', 'commands/new.md': 'new', 'skills/x/SKILL.md': 'x' })
      record({ 'alpha@market': '1.1.0' })
      rmSync(versionDir('alpha', '1.0.0'), { recursive: true })
      tick(s)
      tick(s)
      expect(s.rows()).toEqual([])
      expect(s.pageLines()).toEqual([
        expect.objectContaining({ kind: 'pluginVersion', plugin: 'alpha@market', from: '1.0.0', to: '1.1.0', text: 'alpha 1.0.0 → 1.1.0' }),
      ])
      expect(s.pageLines('writer')).toHaveLength(1)
    })

    it('an in-place edit, addition or deletion under a version directory the record already named ⇒ the configChanged row', () => {
      const s = sealed()
      fetchVersion('alpha', '1.0.0', { 'commands/go.md': 'go rogue', 'hooks/hooks.json': '{"hooks":{}}' })
      rmSync(join(versionDir('alpha', '1.0.0'), '.claude-plugin', 'plugin.json'))
      tick(s)
      const row = rowOf(s, 'configChanged')
      expect(row.folder).toBeNull()
      const dir = versionDir('alpha', '1.0.0')
      expect(row.files.sort()).toEqual([join(dir, '.claude-plugin', 'plugin.json'), join(dir, 'commands', 'go.md'), join(dir, 'hooks', 'hooks.json')].sort())
    })

    it('the marketplace catalog, caches, store and synced state change ⇒ nothing', () => {
      const s = sealed()
      const files = [
        'marketplaces/market/plugins/alpha/commands/go.md',
        'known_marketplaces.json',
        'plugin-catalog-cache.json',
        'store/state.json',
        'synced/acct/.marketplaces.json',
        'cache/market/alpha/.last-complete-round',
        'x.meta.json',
      ]
      for (const f of files) {
        mkdirSync(join(pluginsDir(), f, '..'), { recursive: true })
        writeFileSync(join(pluginsDir(), f), 'one')
      }
      tick(s)
      for (const f of files) writeFileSync(join(pluginsDir(), f), 'two')
      tick(s)
      for (const f of files) rmSync(join(pluginsDir(), f))
      tick(s)
      expect(s.rows()).toEqual([])
      expect(s.pageLines()).toEqual([])
    })

    it('a new version directory seen one tick BEFORE the record names it ⇒ nothing, then only the page line', () => {
      const s = sealed()
      fetchVersion('alpha', '1.1.0')
      tick(s)
      expect(s.rows()).toEqual([])
      fetchVersion('alpha', '1.1.0', { 'commands/late.md': 'still fetching' })
      tick(s)
      expect(s.rows()).toEqual([])
      record({ 'alpha@market': '1.1.0' })
      tick(s)
      expect(s.rows()).toEqual([])
      expect(s.pageLines().map((l) => l.kind === 'pluginVersion' && l.text)).toEqual(['alpha 1.0.0 → 1.1.0'])
      // from now on the new directory IS what the engine loads
      fetchVersion('alpha', '1.1.0', { 'commands/go.md': 'edited in place' })
      tick(s)
      expect(rowOf(s, 'configChanged').files).toEqual([join(versionDir('alpha', '1.1.0'), 'commands', 'go.md')])
    })

    it('a restart between reads diffs against the persisted record: same answers', () => {
      const s1 = sealed()
      s1.uninstall()
      // while Silos is off: alpha bumps, beta arrives
      fetchVersion('alpha', '1.1.0')
      fetchVersion('beta', '0.1.0')
      record({ 'alpha@market': '1.1.0', 'beta@market': '0.1.0' })
      rmSync(versionDir('alpha', '1.0.0'), { recursive: true })
      const s2 = watching()
      s2.boot()
      s2.endBoot()
      expect(kinds(s2)).toEqual(['enginePlugins'])
      expect(rowOf(s2, 'enginePlugins').plugins).toEqual(['beta@market'])
      expect(s2.pageLines().map((l) => l.kind === 'pluginVersion' && l.text)).toEqual(['alpha 1.0.0 → 1.1.0'])
      // and an in-place edit after another restart is still a row
      s2.uninstall()
      const s3 = watching()
      s3.boot()
      s3.endBoot()
      fetchVersion('beta', '0.1.0', { 'commands/go.md': 'rogue' })
      tick(s3)
      expect(rowOf(s3, 'configChanged').files).toEqual([join(versionDir('beta', '0.1.0'), 'commands', 'go.md')])
    })

    it('the first read of the record is the seal: no row, no line', () => {
      fetchVersion('alpha', '1.0.0')
      record({ 'alpha@market': '1.0.0' })
      const s = watching()
      s.boot()
      s.endBoot()
      tick(s)
      expect(s.rows()).toEqual([])
      expect(s.pageLines()).toEqual([])
    })

    it('a stored configChanged row keeps only files under a recorded version directory or outside plugins/', () => {
      fetchVersion('alpha', '1.0.0')
      record({ 'alpha@market': '1.0.0' })
      const s0 = watching()
      s0.boot()
      s0.endBoot()
      s0.uninstall()
      const cache = JSON.parse(read('seals.json')) as { rows: SealRow[] }
      const kept = join(versionDir('alpha', '1.0.0'), 'commands', 'go.md')
      const agentFile = join(home, '.claude', 'agents', 'helper.md')
      cache.rows.push(
        {
          id: 'old1',
          at: '2026-11-09T10:00:00Z',
          kind: 'configChanged',
          folder: null,
          agentIds: [],
          day: '2026-11-09',
          files: [
            join(pluginsDir(), 'marketplaces', 'market', 'README.md'),
            join(versionDir('alpha', '0.9.0'), 'x.md'),
            recordFile(),
            kept,
            agentFile,
            join(versionDir('alpha', '1.0.0'), '.in_use', '42'),
          ],
        },
        {
          id: 'old2',
          at: '2026-11-09T10:00:00Z',
          kind: 'configChanged',
          folder: null,
          agentIds: [],
          day: '2026-11-09',
          files: [join(pluginsDir(), 'known_marketplaces.json'), recordFile()],
        },
      )
      writeFileSync(join(data, 'seals.json'), JSON.stringify(cache))
      const s = watching()
      s.boot()
      s.endBoot()
      expect(s.rows()).toEqual([expect.objectContaining({ id: 'old1', files: [kept, agentFile] })])
    })

    it('the record unparseable (and readable again) ⇒ the configChanged row on that file', () => {
      const s = sealed()
      writeFileSync(recordFile(), '{"version":2,"plugins":')
      tick(s)
      const row = rowOf(s, 'configChanged')
      expect(row.files).toEqual([recordFile()])
      expect(sealInboxRows([row], () => 'Writer')[0]!.voice).toBe(`${recordFile()} changed — every agent's engine loads it on its next conversation`)
      // while it cannot be read, edits under the last recorded directory still count
      fetchVersion('alpha', '1.0.0', { 'commands/go.md': 'rogue' })
      tick(s)
      expect(s.rows().flatMap((r) => (r.kind === 'configChanged' ? r.files : []))).toContain(join(versionDir('alpha', '1.0.0'), 'commands', 'go.md'))
      expect(s.seen(row.id)).toEqual({ ok: true })
      clock += 24 * 3600 * 1000
      record({ 'alpha@market': '1.0.0' })
      s.reconcile()
      expect(s.rows().filter((r) => r.kind === 'configChanged' && r.record)).toHaveLength(1)
    })
  })

  it('the ~/.claude home layer (a planted user subagent) is watched: row, file untouched', () => {
    const seals = watching()
    mkdirSync(join(home, '.claude', 'agents'), { recursive: true })
    seals.boot()
    seals.endBoot()
    seals.reconcile()
    writeFileSync(join(home, '.claude', 'agents', 'helper.md'), 'catch every delegation')
    clock += 1000
    seals.reconcile()
    const row = rowOf(seals, 'configChanged')
    expect(row.files).toEqual([join(home, '.claude', 'agents', 'helper.md')])
    expect(sealInboxRows([row], () => 'Writer')[0]!.voice).toBe(
      `${join(home, '.claude', 'agents', 'helper.md')} changed — every agent's engine loads it on its next conversation`,
    )
    expect(row.folder).toBeNull()
    expect(existsSync(join(home, '.claude', 'agents', 'helper.md'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// the doors are the owner's
// ---------------------------------------------------------------------------

describe("the seal's doors are owner-only", () => {
  it('an agent bearer reads none and writes none (403); the owner keeps the edit through the route', async () => {
    const seals = newSeals()
    seals.boot()
    const tokens = new AgentTokens(data, seals)
    seals.endBoot()
    const a = app({ seals, token: 'owner', agentTokens: tokens })
    atomicWriteJson(join(data, 'automations.json'), { automations: [] })
    write('automations.json', JSON.stringify({ automations: [{ id: 'kept' }] }))
    seals.reconcile()
    const row = rowOf(seals, 'changedOutside')
    const bearer = { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('writer')}` }
    expect((await a.inject({ method: 'GET', url: '/api/seals', headers: bearer })).statusCode).toBe(403)
    expect((await a.inject({ method: 'POST', url: `/api/seals/rows/${row.id}/keep`, headers: bearer })).statusCode).toBe(403)
    expect((await a.inject({ method: 'POST', url: `/api/seals/rows/${row.id}/keep`, headers: LOCAL })).statusCode).toBe(401)
    const listed = await a.inject({ method: 'GET', url: '/api/seals', headers: { ...LOCAL, 'x-token': 'owner' } })
    expect(listed.json().rows).toHaveLength(1)
    const before = await a.inject({ method: 'GET', url: '/api/board', headers: { ...LOCAL, 'x-token': 'owner' } })
    expect((before.json().inbox as Array<{ kind: string; voice: string }>).find((r) => r.kind === 'integrity')?.voice).toBe(
      'automations.json changed outside Silos — review the set-aside copy',
    )
    // opening the set-aside copy never adopts
    expect((await a.inject({ method: 'GET', url: `/api/seals/rows/${row.id}/held`, headers: { ...LOCAL, 'x-token': 'owner' } })).json().text).toContain('kept')
    expect(JSON.parse(read('automations.json'))).toEqual({ automations: [] })
    const kept = await a.inject({ method: 'POST', url: `/api/seals/rows/${row.id}/keep`, headers: { ...LOCAL, 'x-token': 'owner' } })
    expect(kept.statusCode).toBe(200)
    expect(JSON.parse(read('automations.json'))).toEqual({ automations: [{ id: 'kept' }] })
    // the board carries the row while it lives (and not after)
    const board = await a.inject({ method: 'GET', url: '/api/board', headers: { ...LOCAL, 'x-token': 'owner' } })
    expect((board.json().inbox as Array<{ kind: string }>).some((r) => r.kind === 'integrity')).toBe(false)
    await a.close()
  })
})

describe('validators', () => {
  it('validateAgentsJson / degradeAgentsJson', () => {
    expect(validateAgentsJson(Buffer.from('nope'))).toBe('it is not valid JSON')
    expect(validateAgentsJson(Buffer.from('{"agents":[{"id":"a","control":"own","mission":{"text":"x"}}]}'))).toBeNull()
    const d = JSON.parse(degradeAgentsJson(Buffer.from('{"agents":[{"id":"a","control":"own","unattendedSpendPerDay":5,"ownTurnsPerDay":0}]}')).toString())
    expect(d.agents[0]).toEqual({ id: 'a', control: 'told', unattendedSpendPerDay: 5 })
  })
  it('symlinks in a plugin are entries of the tree (never followed)', () => {
    const dir = join(base, 'p')
    mkdirSync(dir)
    writeFileSync(join(base, 'outside'), 'x')
    symlinkSync(join(base, 'outside'), join(dir, 'link'))
    expect(walkFiles(dir, 10, { links: true })).toEqual(['link'])
    expect(lstatSync(join(dir, 'link')).isSymbolicLink()).toBe(true)
  })
})
