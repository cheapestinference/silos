import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry } from '../src/agent-registry.js'
import type { SessionIndex } from '../src/session-index.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { CompleteService } from '../src/complete-service.js'

let svc: CompleteService, folder: string, root: string, index: SessionIndex, registry: AgentRegistry, skillsDir: string, claudeDir: string, base: string
beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'deck-'))
  folder = join(base, 'project')
  mkdirSync(join(folder, 'src'), { recursive: true })
  mkdirSync(join(folder, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(folder, 'src', 'parser.ts'), '')
  writeFileSync(join(folder, 'src', 'server.ts'), '')
  writeFileSync(join(folder, 'README.md'), '')
  writeFileSync(join(folder, 'node_modules', 'x', 'parser.js'), '')
  registry = new AgentRegistry(join(base, 'agents.json'))
  registry.load()
  registry.create({ id: 'writer', name: 'Writer', folder, skills: ['my-agent-skill'] })
  root = join(base, 'projects')
  mkdirSync(root, { recursive: true })
  index = claudeSessionIndex(root, join(base, 'cache.json'))
  await index.init()
  claudeDir = join(base, '.claude')
  skillsDir = join(claudeDir, 'skills')
  // a skill on disk is a directory WITH a SKILL.md (what Claude Code loads)
  mkdirSync(join(skillsDir, 'frontend-design'), { recursive: true })
  writeFileSync(join(skillsDir, 'frontend-design', 'SKILL.md'), 'no frontmatter here\n')
  mkdirSync(join(skillsDir, 'finance-acme'), { recursive: true })
  writeFileSync(join(skillsDir, 'finance-acme', 'SKILL.md'), '# FINANCE\n')
  svc = new CompleteService(registry, index, skillsDir)
})

describe('files', () => {
  it('matches by substring, relative, excludes node_modules', async () => {
    const r = await svc.files('writer', 'pars')
    expect(r).toContain('src/parser.ts')
    expect(r.join()).not.toContain('node_modules')
  })
  it('ranking: a basename-starts-with match wins', async () => {
    const r = await svc.files('writer', 'ser')
    expect(r[0]).toBe('src/server.ts')
  })
  it('an empty q returns something bounded (<=20)', async () => {
    const r = await svc.files('writer', '')
    expect(r.length).toBeGreaterThan(0)
    expect(r.length).toBeLessThanOrEqual(20)
  })
  it('master -> an empty list; nonexistent -> throw', async () => {
    expect(await svc.files('master', 'x')).toEqual([])
    await expect(svc.files('nobody', 'x')).rejects.toThrow('not found')
  })
})

describe('skills', () => {
  it('merges skillsDir + agent skills, filters and sorts', async () => {
    const r = await svc.skills('writer', '')
    expect(r).toEqual(['finance-acme', 'frontend-design', 'my-agent-skill'])
    expect(await svc.skills('writer', 'front')).toEqual(['frontend-design'])
  })

  // skills derived from SESSIONS can carry transcript artifacts (a "Skill"
  // tool_use with an input.skill that starts with an uppercase letter, e.g.
  // "Bash" — not a real skill, real skills are lowercase slugs). These are
  // discarded via /^[a-z]/; skillsDir and agent skills are NOT filtered.
  it('discards noise (leading uppercase) from session-derived skills, without touching skillsDir/agents', async () => {
    const projectDir = join(root, 'project')
    mkdirSync(projectDir, { recursive: true })
    const line = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Skill', input: { skill: 'Bash' } },
          { type: 'tool_use', name: 'Skill', input: { skill: 'my-skill' } },
        ],
      },
    }
    writeFileSync(join(projectDir, 's1.jsonl'), JSON.stringify(line) + '\n')
    await index.refresh('project', 's1', false)

    const r = await svc.skills('writer', '')
    expect(r).toContain('my-skill')
    expect(r).not.toContain('Bash')
  })

  // pins that the /^[a-z]/ filter applies ONLY to session-derived skills —
  // skillsDir and agent skills are never filtered even if they start with
  // an uppercase letter (the owner controls what lives there). The same
  // svc.skills() call exercises all three sources at once: uppercase
  // entries from skillsDir and from an agent survive, an uppercase one
  // derived from a session is discarded.
  it('the filter never touches skillsDir or agent skills: they survive with a leading uppercase, only session-derived ones get discarded', async () => {
    mkdirSync(join(skillsDir, 'MySkill'), { recursive: true })
    writeFileSync(join(skillsDir, 'MySkill', 'SKILL.md'), '')
    registry.create({ id: 'dev2', name: 'Dev2', folder, skills: ['CustomSkill'] })

    const projectDir = join(root, 'project')
    mkdirSync(projectDir, { recursive: true })
    const line = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'Bash' } }],
      },
    }
    writeFileSync(join(projectDir, 's1.jsonl'), JSON.stringify(line) + '\n')
    await index.refresh('project', 's1', false)

    const r = await svc.skills('writer', '')
    expect(r).toContain('MySkill')
    expect(r).toContain('CustomSkill')
    expect(r).not.toContain('Bash')
  })
})

// the skills catalog WITH a description (the Skills tab in AgentPage) —
// same universe as skills(), but with a description read from SKILL.md's
// frontmatter when the directory exists in skillsDir.
describe('skillsCatalog', () => {
  it("pulls the description from SKILL.md's frontmatter when it exists", async () => {
    writeFileSync(join(skillsDir, 'frontend-design', 'SKILL.md'), '---\nname: frontend-design\ndescription: Guidance for distinctive UI\n---\n\nBody\n')
    const r = await svc.skillsCatalog('writer')
    expect(r).toContainEqual({ name: 'frontend-design', description: 'Guidance for distinctive UI', source: 'user', state: 'active' })
  })

  it('with no SKILL.md (or no frontmatter), description stays undefined — not an error', async () => {
    const r = await svc.skillsCatalog('writer')
    const finance = r.find((s) => s.name === 'finance-acme')
    expect(finance).toEqual({ name: 'finance-acme', description: undefined, source: 'user', state: 'active' })
    const agent = r.find((s) => s.name === 'my-agent-skill') // declared on the agent, no SKILL.md anywhere — no source
    expect(agent).toEqual({ name: 'my-agent-skill', description: undefined, state: 'seen', seen: 'name-only' })
  })

  it('a nonexistent agent -> throw (same criterion as skills())', async () => {
    await expect(svc.skillsCatalog('nobody')).rejects.toThrow('not found')
  })
})

// The catalog is EVERY skill visible to the agent (never
// the autocomplete's list cut at 20, and descriptions are read from every
// source, not only ~/.claude/skills, so the agent's own folder skills do not
// come back bare). Sources: the agent's folder, the user's dir, enabled
// plugins (`plugin:skill`), plus names seen in transcripts / declared on
// agents; descriptions from each skill's own SKILL.md wherever it lives.
const skill = (dir: string, name: string, description?: string): void => {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(
    join(dir, name, 'SKILL.md'),
    description === undefined ? '# body\n' : `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}\n`,
  )
}
const seedSessionSkill = async (name: string): Promise<void> => {
  const projectDir = join(root, 'project')
  mkdirSync(projectDir, { recursive: true })
  const line = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: name } }] } }
  writeFileSync(join(projectDir, `s-${name.replace(/\W/g, '')}.jsonl`), JSON.stringify(line) + '\n')
  await index.refresh('project', `s-${name.replace(/\W/g, '')}`, false)
}
const plugin = (key: string, enabled: boolean, skills: Record<string, string>): void => {
  const installPath = join(base, 'plugin-cache', key, '1.0.0')
  for (const [n, d] of Object.entries(skills)) skill(join(installPath, 'skills'), n, d)
  const instFile = join(claudeDir, 'plugins', 'installed_plugins.json')
  mkdirSync(join(claudeDir, 'plugins'), { recursive: true })
  let inst: { version: number; plugins: Record<string, unknown[]> } = { version: 2, plugins: {} }
  try {
    inst = JSON.parse(readFileSync(instFile, 'utf8'))
  } catch {
    /* first */
  }
  inst.plugins[key] = [{ scope: 'user', installPath, version: '1.0.0' }]
  writeFileSync(instFile, JSON.stringify(inst))
  const setFile = join(claudeDir, 'settings.json')
  let set: { enabledPlugins: Record<string, boolean> } = { enabledPlugins: {} }
  try {
    set = JSON.parse(readFileSync(setFile, 'utf8'))
  } catch {
    /* first */
  }
  set.enabledPlugins[key] = enabled
  writeFileSync(setFile, JSON.stringify(set))
}

describe('skillsCatalog — every skill visible to the agent', () => {
  it('is never capped (the autocomplete keeps its cap of 20)', async () => {
    for (let i = 0; i < 30; i++) skill(skillsDir, `s${String(i).padStart(2, '0')}`, `skill ${i}`)
    const r = await svc.skillsCatalog('writer')
    expect(r.length).toBe(33) // 30 + frontend-design + finance + the agent's declared one
    expect(r.find((e) => e.name === 's29')).toEqual({ name: 's29', description: 'skill 29', source: 'user', state: 'active' })
    expect(await svc.skills('writer', '')).toHaveLength(20)
  })

  it("the agent's folder skills (<folder>/.claude/skills) are in, with their own description", async () => {
    skill(join(folder, '.claude', 'skills'), 'heartbeat', 'Use when woken for a heartbeat')
    const r = await svc.skillsCatalog('writer')
    expect(r).toContainEqual({ name: 'heartbeat', description: 'Use when woken for a heartbeat', source: 'project', state: 'active' })
    expect(await svc.skills('writer', 'heart')).toEqual(['heartbeat'])
  })

  it("another agent's folder skills are not visible to this one — but a name seen in a transcript still gets its description from there", async () => {
    const other = join(base, 'other')
    mkdirSync(other, { recursive: true })
    registry.create({ id: 'ops', name: 'Ops', folder: other })
    skill(join(other, '.claude', 'skills'), 'axiom', 'Use when querying Axiom')
    skill(join(other, '.claude', 'skills'), 'prod-db', 'Use when debugging prod')
    await seedSessionSkill('axiom')
    const r = await svc.skillsCatalog('writer')
    expect(r.find((e) => e.name === 'prod-db')).toBeUndefined()
    // described from the other folder, but NOT this agent's folder skill (no source)
    expect(r.find((e) => e.name === 'axiom')).toEqual({ name: 'axiom', description: 'Use when querying Axiom', state: 'seen', seen: 'other-folder' })
    const ops = await svc.skillsCatalog('ops')
    expect(ops.find((e) => e.name === 'prod-db')?.source).toBe('project')
  })

  it('enabled plugins bring their skills as plugin:skill — ACTIVE, they load in every conversation; a disabled plugin only lends descriptions to names seen in transcripts', async () => {
    plugin('superpowers@official', true, { brainstorming: 'Use before creative work' })
    plugin('claude-mem@thedotmack', false, { 'mem-search': 'Search memory', other: 'never listed' })
    await seedSessionSkill('claude-mem:mem-search')
    const r = await svc.skillsCatalog('writer')
    expect(r).toContainEqual({
      name: 'superpowers:brainstorming',
      description: 'Use before creative work',
      source: 'plugin',
      plugin: 'superpowers@official',
      state: 'active',
    })
    expect(r).toContainEqual({ name: 'claude-mem:mem-search', description: 'Search memory', state: 'seen', seen: 'plugin-off' })
    expect(r.find((e) => e.name === 'claude-mem:other')).toBeUndefined()
  })

  // Claude Code 2.1.316: no enabledPlugins entry anywhere = ON unless the
  // manifest says defaultEnabled:false — its skills load, so they're active
  it('an installed plugin no settings file mentions loads — its skills are active; a manifest defaultEnabled:false keeps them off', async () => {
    plugin('superpowers@official', true, { brainstorming: 'Use before creative work' })
    writeFileSync(join(claudeDir, 'settings.json'), '{}') // no entry anywhere
    let r = await svc.skillsCatalog('writer')
    expect(r).toContainEqual({
      name: 'superpowers:brainstorming',
      description: 'Use before creative work',
      source: 'plugin',
      plugin: 'superpowers@official',
      state: 'active',
    })
    const manifest = join(base, 'plugin-cache', 'superpowers@official', '1.0.0', '.claude-plugin')
    mkdirSync(manifest, { recursive: true })
    writeFileSync(join(manifest, 'plugin.json'), JSON.stringify({ name: 'superpowers', defaultEnabled: false }))
    r = await svc.skillsCatalog('writer')
    expect(r.find((e) => e.name === 'superpowers:brainstorming')).toBeUndefined()
  })

  it("the folder's own plugin switches count as the engine reads them — local over project over the machine", async () => {
    plugin('superpowers@official', true, { brainstorming: 'Use before creative work' })
    plugin('stripe@official', false, { pay: 'Payments' })
    mkdirSync(join(folder, '.claude'), { recursive: true })
    writeFileSync(join(folder, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'stripe@official': true } }))
    writeFileSync(join(folder, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'superpowers@official': false } }))
    const r = await svc.skillsCatalog('writer')
    expect(r.find((e) => e.name === 'superpowers:brainstorming')).toBeUndefined()
    expect(r).toContainEqual({ name: 'stripe:pay', description: 'Payments', source: 'plugin', plugin: 'stripe@official', state: 'active' })
  })

  it("the catalog follows the agent's ENGINE: no Claude plugins where they never load, and the roots it is handed at launch as active under their bare names", async () => {
    plugin('superpowers@official', true, { brainstorming: 'Use before creative work' })
    const roots = join(base, 'silos-skills')
    skill(roots, 'heartbeat', 'Beat')
    skill(join(folder, '.claude', 'skills'), 'team-plan', 'Folder copy')
    skill(roots, 'team-plan', 'Silos copy')
    const other = new CompleteService(registry, index, skillsDir, undefined, () => ({ claudePlugins: false, roots: [{ plugin: 'silos', dir: roots }] }))
    const r = await other.skillsCatalog('writer')
    expect(r.find((e) => e.name.startsWith('superpowers:'))).toBeUndefined()
    expect(r).toContainEqual({ name: 'heartbeat', description: 'Beat', source: 'plugin', plugin: 'silos', state: 'active' })
    expect(r.find((e) => e.name === 'team-plan')).toMatchObject({ description: 'Folder copy', source: 'project', state: 'active' })
  })

  it('a directory without SKILL.md is not a skill (e.g. ~/.claude/skills/synced)', async () => {
    mkdirSync(join(skillsDir, 'synced', 'abc'), { recursive: true })
    mkdirSync(join(folder, '.claude', 'skills', 'half'), { recursive: true })
    const names = (await svc.skillsCatalog('writer')).map((e) => e.name)
    expect(names).not.toContain('synced')
    expect(names).not.toContain('half')
  })

  it('a block-scalar description (`description: |` / `>`) is read too', async () => {
    mkdirSync(join(skillsDir, 'blocky'), { recursive: true })
    writeFileSync(join(skillsDir, 'blocky', 'SKILL.md'), '---\nname: blocky\ndescription: >\n  First line\n  second line\nother: x\n---\nbody\n')
    expect((await svc.skillsCatalog('writer')).find((e) => e.name === 'blocky')?.description).toBe('First line second line')
  })

  it("one name in ~/.claude/skills and in the folder: the personal copy is the one that runs, the folder's is shadowed", async () => {
    skill(skillsDir, 'team-plan', 'Old personal copy')
    skill(join(folder, '.claude', 'skills'), 'team-plan', 'Current Silos copy')
    const entry = (await svc.skillsCatalog('writer')).find((e) => e.name === 'team-plan')
    expect(entry).toEqual({
      name: 'team-plan',
      description: 'Old personal copy',
      source: 'user',
      shadowed: join(folder, '.claude', 'skills', 'team-plan', 'SKILL.md'),
      state: 'active',
    })
    expect((await svc.skillReadme('team-plan'))?.description).toBe('Old personal copy')
  })

  it('master (no folder) still sees user + plugin skills', async () => {
    plugin('superpowers@official', true, { brainstorming: 'Use before creative work' })
    const names = (await svc.skillsCatalog('master')).map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining(['frontend-design', 'superpowers:brainstorming']))
  })
})

describe('skillReadme — wherever the SKILL.md lives', () => {
  it('reads a user, a project-folder and a plugin skill; unknown -> null', async () => {
    skill(skillsDir, 'release', 'Ship it')
    skill(join(folder, '.claude', 'skills'), 'heartbeat', 'Beat')
    plugin('superpowers@official', true, { brainstorming: 'Ideas' })
    expect(await svc.skillReadme('release')).toEqual({ name: 'release', description: 'Ship it', body: 'Body of release' })
    expect(await svc.skillReadme('heartbeat')).toEqual({ name: 'heartbeat', description: 'Beat', body: 'Body of heartbeat' })
    expect(await svc.skillReadme('superpowers:brainstorming')).toEqual({
      name: 'superpowers:brainstorming',
      description: 'Ideas',
      body: 'Body of brainstorming',
    })
    expect(await svc.skillReadme('nope')).toBeNull()
    expect(await svc.skillReadme('..')).toBeNull()
  })

  it('a SKILL.md symlinked outside its root is refused', async () => {
    const outside = join(base, 'outside.md')
    writeFileSync(outside, 'secret')
    mkdirSync(join(skillsDir, 'evil'), { recursive: true })
    symlinkSync(outside, join(skillsDir, 'evil', 'SKILL.md'))
    expect(await svc.skillReadme('evil')).toBeNull()
  })
})

// Capability states: every catalog entry carries its state for the
// agent's primary folder, and the folder's HELD skills (skill-states.ts
// store, injected as the 4th constructor arg) are appended as 'held'.
describe('skillsCatalog — states and held entries', () => {
  it("held entries from the injected lister are appended with state held, for the agent's own folder", async () => {
    skill(join(folder, '.claude', 'skills'), 'heartbeat', 'Beat')
    const held = (f: string) => (f === folder ? [{ name: 'team-plan', description: 'Plan work' }, { name: 'odd' }] : [])
    const withHeld = new CompleteService(registry, index, skillsDir, held)
    const r = await withHeld.skillsCatalog('writer')
    expect(r.find((e) => e.name === 'heartbeat')?.state).toBe('active')
    expect(r.filter((e) => e.state === 'held')).toEqual([
      { name: 'team-plan', description: 'Plan work', state: 'held' },
      { name: 'odd', state: 'held' },
    ])
  })

  it('master (no folder) and a service without the lister get no held entries', async () => {
    const withHeld = new CompleteService(registry, index, skillsDir, () => [{ name: 'x' }])
    expect((await withHeld.skillsCatalog('master')).filter((e) => e.state === 'held')).toEqual([])
    expect((await svc.skillsCatalog('writer')).filter((e) => e.state === 'held')).toEqual([])
  })
})

// 'available' is EXACTLY what the add route can do (skill-states.ts addSkill
// copies only from Silos' plugin/skills): every available entry is one of
// those not loaded/held here, every other known name is 'seen' — and the
// route agrees by construction (it adds only an 'available' entry).
describe("skillsCatalog — 'available' = what Add can really add", () => {
  const silos = (): string => {
    const dir = join(base, 'plugin-skills')
    skill(dir, 'team-plan', 'Plan work')
    skill(dir, 'heartbeat', 'Beat')
    skill(dir, 'support-inbox', 'Support')
    return dir
  }

  it("on Claude Code: Silos' plugin skills not in the folder are available (source silos); the transcript name, another folder's copy and a disabled plugin's skill are 'seen', never available", async () => {
    const dir = silos()
    skill(join(folder, '.claude', 'skills'), 'heartbeat', 'Folder copy')
    const other = join(base, 'other')
    registry.create({ id: 'ops', name: 'Ops', folder: other })
    skill(join(other, '.claude', 'skills'), 'axiom', 'Axiom')
    await seedSessionSkill('axiom')
    plugin('claude-mem@thedotmack', false, { 'mem-search': 'Search memory' })
    await seedSessionSkill('claude-mem:mem-search')
    const withSilos = new CompleteService(registry, index, skillsDir, () => [], undefined, dir)
    const r = await withSilos.skillsCatalog('writer')
    const available = r.filter((e) => e.state === 'available')
    expect(available).toEqual([
      { name: 'support-inbox', description: 'Support', source: 'silos', state: 'available' },
      { name: 'team-plan', description: 'Plan work', source: 'silos', state: 'available' },
    ])
    expect(r.find((e) => e.name === 'heartbeat')).toMatchObject({ source: 'project', state: 'active' })
    for (const n of ['axiom', 'claude-mem:mem-search', 'my-agent-skill']) expect(r.find((e) => e.name === n)?.state).toBe('seen')
  })

  it('a held Silos skill is held, never also available; a personal twin makes it active, never available', async () => {
    const dir = silos()
    skill(skillsDir, 'support-inbox', 'Personal copy')
    const withSilos = new CompleteService(registry, index, skillsDir, () => [{ name: 'team-plan' }], undefined, dir)
    const r = await withSilos.skillsCatalog('writer')
    expect(r.filter((e) => e.name === 'team-plan')).toEqual([{ name: 'team-plan', state: 'held' }])
    expect(r.filter((e) => e.name === 'support-inbox')).toEqual([{ name: 'support-inbox', description: 'Personal copy', source: 'user', state: 'active' }])
    expect(r.filter((e) => e.state === 'available').map((e) => e.name)).toEqual(['heartbeat'])
  })

  it("a name seen in a transcript that IS a Silos skill becomes available (one entry, no 'seen' twin)", async () => {
    const dir = silos()
    await seedSessionSkill('support-inbox')
    const withSilos = new CompleteService(registry, index, skillsDir, () => [], undefined, dir)
    const r = await withSilos.skillsCatalog('writer')
    expect(r.filter((e) => e.name === 'support-inbox')).toEqual([{ name: 'support-inbox', description: 'Support', source: 'silos', state: 'available' }])
  })

  it('on OpenCode (Silos skills handed as a launch root): nothing is available — they already load — and a HELD name is held only, not active from the root', async () => {
    const dir = silos()
    skill(join(folder, '.claude', 'skills'), 'heartbeat', 'Folder copy')
    const oc = new CompleteService(
      registry,
      index,
      skillsDir,
      () => [{ name: 'team-plan', description: 'Plan work' }],
      () => ({ claudePlugins: false, roots: [{ plugin: 'silos', dir }] }),
      dir,
    )
    const r = await oc.skillsCatalog('writer')
    expect(r.filter((e) => e.state === 'available')).toEqual([])
    expect(r.filter((e) => e.name === 'team-plan')).toEqual([{ name: 'team-plan', description: 'Plan work', state: 'held' }])
    expect(r.find((e) => e.name === 'support-inbox')).toMatchObject({ source: 'plugin', plugin: 'silos', state: 'active' })
  })

  // the held row says what's true when the NAME still loads from the
  // operator's personal copy (both engines load ~/.claude/skills)
  it("a held name with a personal twin carries stillLoads 'personal' — the personal row stays active; none when the engine doesn't load personal skills", async () => {
    const dir = silos()
    skill(skillsDir, 'team-plan', 'Personal copy')
    for (const load of [undefined, () => ({ claudePlugins: false, roots: [{ plugin: 'silos', dir }] })]) {
      const c = new CompleteService(registry, index, skillsDir, () => [{ name: 'team-plan', description: 'Plan work' }], load, dir)
      const r = (await c.skillsCatalog('writer')).filter((e) => e.name === 'team-plan')
      expect(r).toEqual([
        { name: 'team-plan', description: 'Personal copy', source: 'user', state: 'active' },
        { name: 'team-plan', description: 'Plan work', state: 'held', stillLoads: 'personal' },
      ])
    }
    const off = new CompleteService(
      registry,
      index,
      skillsDir,
      () => [{ name: 'team-plan', description: 'Plan work' }],
      () => ({ claudePlugins: false, personal: false, roots: [{ plugin: 'silos', dir }] }),
      dir,
    )
    const r = (await off.skillsCatalog('writer')).filter((e) => e.name === 'team-plan')
    expect(r).toEqual([{ name: 'team-plan', description: 'Plan work', state: 'held' }])
    // a personal skill that engine doesn't load is not listed as its own
    expect((await off.skillsCatalog('writer')).find((e) => e.name === 'frontend-design' && e.state === 'active')).toBeUndefined()
  })

  // a symlinked folder and its target are ONE folder to the engine: agent l
  // on linkC → realC and agent r on realC read one held store (the reviewer's
  // repro: a hold via l was invisible to r, r could re-add, and l then read
  // active + held at once)
  it('two agents on a symlinked folder and its target agree: held for both, addable for neither, never active + held', async () => {
    const { heldSkills, holdSkill } = await import('../src/skill-states.js')
    const dataDir = join(base, 'data')
    const dir = silos()
    const linkC = join(base, 'linkC')
    symlinkSync(folder, linkC)
    registry.create({ id: 'l', name: 'L', folder: linkC })
    skill(join(folder, '.claude', 'skills'), 'team-plan', 'Folder copy')
    const c = new CompleteService(registry, index, skillsDir, (f) => heldSkills(dataDir, f), undefined, dir)
    holdSkill(dataDir, linkC, 'team-plan')
    for (const id of ['l', 'writer']) {
      const r = (await c.skillsCatalog(id)).filter((e) => e.name === 'team-plan')
      expect({ id, r }).toEqual({ id, r: [{ name: 'team-plan', description: 'Folder copy', state: 'held' }] })
    }
  })

  it('master (no folder) has nothing to add', async () => {
    const withSilos = new CompleteService(registry, index, skillsDir, () => [], undefined, silos())
    expect((await withSilos.skillsCatalog('master')).filter((e) => e.state === 'available')).toEqual([])
  })
})

// The plugin precedence is ONE resolver (plugin-enablement.ts) for the
// catalog and the project's Tools piece: they must agree on every layering.
describe('plugin enablement — the catalog and the Tools piece agree', () => {
  it('for every layering of managed / local / project / user, no entry at all, and the manifest default', async () => {
    const { mcpRowsOf } = await import('./helpers/mcp-rows.js')
    const key = 'stripe@official'
    plugin(key, true, { pay: 'Payments' })
    const settings = join(claudeDir, 'settings.json')
    const managedDir = join(base, 'managed')
    mkdirSync(managedDir, { recursive: true })
    const cat = new CompleteService(registry, index, skillsDir, undefined, undefined, undefined, managedDir)
    const manifest = join(base, 'plugin-cache', key, '1.0.0', '.claude-plugin', 'plugin.json')
    mkdirSync(join(manifest, '..'), { recursive: true })
    const values = [undefined, true, false] as const
    mkdirSync(join(folder, '.claude'), { recursive: true })
    const put = (file: string, v: boolean | undefined): void => writeFileSync(file, JSON.stringify(v === undefined ? {} : { enabledPlugins: { [key]: v } }))
    for (const managed of values)
      for (const user of values)
        for (const project of values)
          for (const local of values)
            for (const def of values) {
              put(join(managedDir, 'managed-settings.json'), managed)
              put(settings, user)
              put(join(folder, '.claude', 'settings.json'), project)
              put(join(folder, '.claude', 'settings.local.json'), local)
              writeFileSync(manifest, JSON.stringify(def === undefined ? { name: 'stripe' } : { name: 'stripe', defaultEnabled: def }))
              // Claude Code 2.1.316 hJt: explicit by precedence, else defaultEnabled, else ON
              const expected = managed ?? local ?? project ?? user ?? def ?? true
              const inCatalog = (await cat.skillsCatalog('writer')).some((e) => e.name === 'stripe:pay' && e.state === 'active')
              const row = mcpRowsOf(folder, base, managedDir).find((r) => r.kind === 'plugin' && r.name === key)
              const at = { managed, user, project, local, def }
              expect({ ...at, inCatalog }).toEqual({ ...at, inCatalog: expected })
              expect({ ...at, state: row?.state }).toEqual({ ...at, state: expected ? 'active' : 'held' })
            }
  })
})
