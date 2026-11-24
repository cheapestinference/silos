// folder-scoped-skills.test.ts — the project page asks about the FOLDER
// itself (third review round, defect 1): /api/folders/:folder/skills-catalog,
// …/skills/:name/(hold|activate|add), /api/folders/:folder/context and
// /api/memory?folder= answer for THAT folder — never through a member agent
// whose primary folder is elsewhere (a folders[]-only member, an agent
// nested inside the folder). Managed folders only (the /api/mcp/:folder
// rule), owner-only. Temp dirs only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry, mungePath } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { ContextService } from '../src/context-service.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { heldSkills } from '../src/skill-states.js'
import { buildServer } from '../src/server.js'
import { asOwner } from './helpers/owner.js'

const LOCAL = { host: '127.0.0.1:3210' }
let app: FastifyInstance, base: string, registry: AgentRegistry, tokens: AgentTokens
let F: string, P: string, nested: string, root: string, plugin: string

const skill = (dir: string, name: string): void => {
  mkdirSync(join(dir, '.claude', 'skills', name), { recursive: true })
  writeFileSync(join(dir, '.claude', 'skills', name, 'SKILL.md'), `---\ndescription: ${name}\n---\nx`)
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'deck-folder-skills-'))
  root = join(base, 'projects')
  const data = join(base, 'data')
  F = join(base, 'shared-proj')
  P = join(base, 'elsewhere')
  nested = join(base, 'mono')
  for (const d of [root, join(data, 'trash'), F, P, join(nested, 'web')]) mkdirSync(d, { recursive: true })
  skill(F, 'f-skill')
  skill(P, 'p-skill')
  skill(join(nested, 'web'), 'web-skill')
  plugin = join(base, 'plugin-src')
  mkdirSync(join(plugin, 'team-plan'), { recursive: true })
  writeFileSync(join(plugin, 'team-plan', 'SKILL.md'), '---\ndescription: Plan work\n---\nx')
  const personal = join(base, 'personal')
  mkdirSync(personal, { recursive: true })
  const index = claudeSessionIndex(root, join(data, 'cache.json'))
  await index.init()
  registry = new AgentRegistry(join(data, 'agents.json'))
  registry.load()
  // a member of F only through folders[] — its PRIMARY folder is P
  registry.create({ id: 'visitor', name: 'Visitor', folder: P, folders: [F] })
  // an agent whose folder sits INSIDE `nested` (a member of /project/<nested>)
  registry.create({ id: 'webdev', name: 'WebDev', folder: join(nested, 'web') })
  tokens = new AgentTokens(data)
  app = buildServer({
    index,
    registry,
    native: new NativeStore(join(data, 'native.json')),
    chat: new ChatService({
      registry,
      native: new NativeStore(join(data, 'native2.json')),
      queryFn: () => {
        throw new Error('no sdk')
      },
    }),
    store: new SessionStore(root, data),
    exec: new ExecService(registry),
    // the two engines' skill loads as their harness traits declare them:
    // OpenCode is handed Silos' plugin skills as a launch root
    complete: new CompleteService(
      registry,
      index,
      personal,
      (f) => heldSkills(data, f),
      (a) => (a.framework === 'opencode' ? { claudePlugins: false, roots: [{ plugin: 'silos', dir: plugin }] } : { claudePlugins: false }),
      plugin,
    ),
    prefs: new PrefsStore(data),
    memory: new MemoryService(root, data, registry),
    context: new ContextService(),
    token: 't0k',
    liveMs: 120_000,
    agentTokens: tokens,
    pluginSkillsDir: plugin,
    dataDir: data,
  })
  asOwner(app, 't0k')
})
afterEach(async () => {
  await app.close()
  rmSync(base, { recursive: true, force: true })
})

const enc = (f: string) => encodeURIComponent(f)
const get = (url: string, headers: Record<string, string> = LOCAL) => app.inject({ method: 'GET', url, headers })
const post = (url: string, headers: Record<string, string> = LOCAL) => app.inject({ method: 'POST', url, headers })
type Entry = { name: string; state?: string }

describe('folder-scoped skills — the project page asks about the folder itself', () => {
  it("a folders[]-only member never leaks its primary folder's skills into the folder's catalog", async () => {
    const r = await get(`/api/folders/${enc(F)}/skills-catalog`)
    expect(r.statusCode).toBe(200)
    const skills = r.json().skills as Entry[]
    expect(skills.find((s) => s.name === 'f-skill')?.state).toBe('active')
    expect(skills.some((s) => s.name === 'p-skill' && s.state === 'active')).toBe(false)
    // and the agent's own catalog still answers for ITS primary folder
    const own = (await get('/api/agents/visitor/skills-catalog')).json().skills as Entry[]
    expect(own.find((s) => s.name === 'p-skill')?.state).toBe('active')
  })

  it("hold / activate / add act on the folder — the member's primary folder is never touched", async () => {
    const held = await post(`/api/folders/${enc(F)}/skills/f-skill/hold`)
    expect(held.statusCode).toBe(200)
    expect(existsSync(join(F, '.claude', 'skills', 'f-skill'))).toBe(false)
    expect((held.json().skills as Entry[]).find((s) => s.name === 'f-skill')?.state).toBe('held')
    expect((await post(`/api/folders/${enc(F)}/skills/f-skill/activate`)).statusCode).toBe(200)
    expect(existsSync(join(F, '.claude', 'skills', 'f-skill', 'SKILL.md'))).toBe(true)
    // the other folder's skill is not this folder's to turn off
    const refused = await post(`/api/folders/${enc(F)}/skills/p-skill/hold`)
    expect(refused.statusCode).toBe(400)
    expect(existsSync(join(P, '.claude', 'skills', 'p-skill', 'SKILL.md'))).toBe(true)
    // add lands in F, not in P
    expect((await post(`/api/folders/${enc(F)}/skills/team-plan/add`)).statusCode).toBe(200)
    expect(existsSync(join(F, '.claude', 'skills', 'team-plan', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(P, '.claude', 'skills', 'team-plan'))).toBe(false)
  })

  it("a folder that only CONTAINS an agent's folder is not managed: 404, never the nested agent's skills", async () => {
    const r = await get(`/api/folders/${enc(nested)}/skills-catalog`)
    expect(r.statusCode).toBe(404)
    expect((await post(`/api/folders/${enc(nested)}/skills/web-skill/hold`)).statusCode).toBe(404)
    expect(existsSync(join(nested, 'web', '.claude', 'skills', 'web-skill', 'SKILL.md'))).toBe(true)
  })

  it("an arbitrary path, an archived agent's folder and an agent bearer are refused", async () => {
    expect((await get(`/api/folders/${enc(join(base, 'nowhere'))}/skills-catalog`)).statusCode).toBe(404)
    const gone = join(base, 'gone')
    skill(gone, 'g')
    registry.create({ id: 'old', name: 'Old', folder: gone })
    registry.update('old', { archived: true })
    expect((await get(`/api/folders/${enc(gone)}/skills-catalog`)).statusCode).toBe(404)
    expect((await post(`/api/folders/${enc(gone)}/skills/g/hold`)).statusCode).toBe(404)
    const bearer = { ...LOCAL, authorization: `Bearer ${tokens.tokenFor('visitor')}` }
    expect((await get(`/api/folders/${enc(F)}/skills-catalog`, bearer)).statusCode).toBe(403)
    expect((await post(`/api/folders/${enc(F)}/skills/f-skill/hold`, bearer)).statusCode).toBe(403)
    expect(existsSync(join(F, '.claude', 'skills', 'f-skill'))).toBe(true)
  })
})

describe("a folder path past 100 chars (fourth review round, defect 3: Fastify's default maxParamLength answered 414)", () => {
  it('a 150-char folder: its skills catalog, a skill gesture and its shared files all answer', async () => {
    const long = join(base, 'y'.repeat(150 - base.length - 1))
    expect(long.length).toBe(150)
    skill(long, 'long-skill')
    registry.create({ id: 'longdev', name: 'Long', folder: long })
    const cat = await get(`/api/folders/${enc(long)}/skills-catalog`)
    expect(cat.statusCode).toBe(200)
    expect((cat.json().skills as Entry[]).find((s) => s.name === 'long-skill')?.state).toBe('active')
    expect((await post(`/api/folders/${enc(long)}/skills/long-skill/hold`)).statusCode).toBe(200)
    expect((await get(`/api/folders/${enc(long)}/context`)).statusCode).toBe(200)
  })
})

describe('folder-true memory and shared files', () => {
  it("memory for a folders[]-only folder reads THAT folder's auto memory and CLAUDE.md", async () => {
    const mem = join(root, mungePath(F), 'memory')
    mkdirSync(mem, { recursive: true })
    writeFileSync(join(mem, 'note.md'), '---\nname: F note\n---\nx')
    writeFileSync(join(F, 'CLAUDE.md'), '# F')
    const other = join(root, mungePath(P), 'memory')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'p.md'), '---\nname: P note\n---\nx')
    const r = await get(`/api/memory?folder=${enc(F)}`)
    expect(r.statusCode).toBe(200)
    const body = r.json() as { project: { path: string }; autoMemory: { name: string }[] }
    expect(body.project.path).toBe(join(F, 'CLAUDE.md'))
    expect(body.autoMemory.map((n) => n.name)).toEqual(['F note'])
    // and the folder's CLAUDE.md is editable from its page
    const put = await app.inject({ method: 'PUT', url: '/api/memory/file', headers: LOCAL, payload: { path: join(F, 'CLAUDE.md'), content: '# F2' } })
    expect(put.statusCode).toBe(200)
  })

  it("shared files list, upload and remove act on the folder, never the member's primary folder", async () => {
    mkdirSync(join(P, 'context', 'shared'), { recursive: true })
    writeFileSync(join(P, 'context', 'shared', 'p.txt'), 'p')
    const up = await app.inject({
      method: 'POST',
      url: `/api/folders/${enc(F)}/context`,
      headers: LOCAL,
      payload: { name: 'f.txt', contentBase64: Buffer.from('f').toString('base64') },
    })
    expect(up.statusCode).toBe(200)
    expect(existsSync(join(F, 'context', 'shared', 'f.txt'))).toBe(true)
    const list = (await get(`/api/folders/${enc(F)}/context`)).json() as { shared: { name: string }[] }
    expect(list.shared.map((f) => f.name)).toEqual(['f.txt'])
    const del = await app.inject({ method: 'DELETE', url: `/api/folders/${enc(F)}/context?name=f.txt`, headers: LOCAL })
    expect(del.statusCode).toBe(200)
    expect(existsSync(join(F, 'context', 'shared', 'f.txt'))).toBe(false)
    expect(existsSync(join(P, 'context', 'shared', 'p.txt'))).toBe(true)
    expect((await get(`/api/folders/${enc(nested)}/context`)).statusCode).toBe(404)
  })
})

// Fourth review round, defect 2: a folder where an OpenCode agent and a
// Claude Code agent both start. OpenCode is handed Silos' skills at every
// launch; Claude Code loads only the folder's copies. The folder's rows are
// the truth of the engine that reads the folder copies (Claude Code), the
// other engine says on the row where it differs — whatever the registry
// order — and add/hold act on the folder copy.
describe("a mixed folder (OpenCode + Claude Code agents) — the folder catalog is the folder copies' truth", () => {
  const mixed = (order: 'oc-then-cc' | 'cc-then-oc'): string => {
    const M = join(base, `mixed-${order}`)
    mkdirSync(M, { recursive: true })
    const oc = () => registry.create({ id: `oc-${order}`, name: 'Oc', folder: M, framework: 'opencode' })
    const cc = () => registry.create({ id: `cc-${order}`, name: 'Cc', folder: M })
    if (order === 'oc-then-cc') {
      oc()
      cc()
    } else {
      cc()
      oc()
    }
    return M
  }
  const teamPlan = async (folder: string) =>
    ((await get(`/api/folders/${enc(folder)}/skills-catalog`)).json().skills as Array<Entry & { engines?: string[] }>).find((s) => s.name === 'team-plan')

  for (const order of ['oc-then-cc', 'cc-then-oc'] as const) {
    it(`${order}: Silos' skill is available to add (Claude doesn't load it), the row says OpenCode loads it at launch; add then hold act on the folder copy`, async () => {
      const M = mixed(order)
      expect(await teamPlan(M)).toMatchObject({ state: 'available', engines: ['OpenCode agents here load it from Silos at launch'] })
      const added = await post(`/api/folders/${enc(M)}/skills/team-plan/add`)
      expect(added.statusCode).toBe(200)
      expect(existsSync(join(M, '.claude', 'skills', 'team-plan', 'SKILL.md'))).toBe(true)
      const after = await teamPlan(M)
      expect(after?.state).toBe('active')
      expect(after?.engines).toBeUndefined() // both engines load it now
      expect((await post(`/api/folders/${enc(M)}/skills/team-plan/hold`)).statusCode).toBe(200)
      expect(existsSync(join(M, '.claude', 'skills', 'team-plan'))).toBe(false)
    })
  }

  it("a folder whose starters all run OpenCode keeps OpenCode's truth: Silos' skills load at launch, add refused in those words", async () => {
    const O = join(base, 'oc-only')
    mkdirSync(O, { recursive: true })
    registry.create({ id: 'oc-only', name: 'Oc', folder: O, framework: 'opencode' })
    const r = await post(`/api/folders/${enc(O)}/skills/team-plan/add`)
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toContain("handed Silos' skills at every launch")
  })
})
