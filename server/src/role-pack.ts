// role-pack.ts — a role as a unit that copies.
//
// A pack is `role.json` plus the folder's files: skills/<name>/**,
// automations/<id>.json (silos.automation-template v1) and, optionally,
// silos/<id>.silo.json. Phase 1 transport (my call, plan role-pack t1): ONE
// JSON file — the role.json fields plus `files: { "<path>": "<text>" }` —
// the same folder, without a tar dependency or a browser folder upload.
//
// The spec's rules, as code:
// - the pack grants nothing: no fence, no secret values, no slots.
//   `territory.needs` is shown, `engine.prefer` is a hint;
// - template ≠ instance: installing makes a NEW agent carrying
//   `pack: {id, packVersion}`; one pack, N agents;
// - skills land through role skills (agent-state/<id>/plugin), with a
//   lockfile (plugin/.pack.json) of what was installed;
// - knowledge age lives in agent-state/<id>/pack-state.json, never in a
//   SKILL.md frontmatter (Claude Code is sacred);
// - secrets: names and why only; export refuses a body holding a value;
// - every effect goes through the path that already exists: the agent
//   registry + autonomy, the template catalog + the automations create
//   path, the silo installer (bind a producer, or submit as pending), the Vault.
import { slugify } from './slug.js'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { Agent } from './types.js'
import type { Automation } from './automations-types.js'
import { redactor } from './command-run.js'
import { argvLine } from './automation-words.js'
import { checkTemplate, fromAutomation, TemplateError, type AutomationTemplate, type Secret } from './automation-templates.js'
import { ensureRolePluginManifest, rolePluginDir, roleSkillsDir } from './role-plugin.js'
import { sealHooks } from './seal-hooks.js'
import { parseMission } from './mission.js'

export const PACK_KIND = 'silos.role-pack'
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/
const SKILL = /^[a-z0-9][a-z0-9_-]{0,62}$/
const ENV = /^[A-Z_][A-Z0-9_]{0,63}$/
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const MAX_FILE_BYTES = 256 * 1024
const MAX_PACK_BYTES = 4 * 1024 * 1024

export interface PackMission {
  text: string
  never: string[]
}
export interface PackSkill {
  name: string
  verified?: string
  sources?: string[]
  reviewEvery?: string
}
export interface RolePack {
  kind: typeof PACK_KIND
  version: 1
  id: string
  packVersion: string
  name: string
  emoji: string
  // the role's mission: the one field that replaced
  // role, charter and instructions — absent when the source had none
  mission?: PackMission
  produces: { silo: string; version?: string }[]
  skills: PackSkill[]
  automations: { template: string }[]
  secrets: { name: string; why: string }[]
  territory: { needs: string[] }
  engine: { prefer?: string }
  files: Record<string, string>
}

export class PackError extends Error {
  // a refused export names the Vault variable whose value the role holds and
  // WHERE — never the value; `id` is its entry, the door to mark it public
  constructor(
    message: string,
    readonly secret?: { name: string; where: string[]; id?: string },
  ) {
    super(message)
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const str = (x: unknown, what: string, max = 2000): string => {
  if (typeof x !== 'string') throw new PackError(`${what} must be text`)
  if (x.length > max) throw new PackError(`${what} is too long`)
  return x
}

// a file path inside the pack: one of the three folders, no escape
function checkPath(p: string): void {
  if (p.includes('\\') || p.startsWith('/') || p.split('/').some((s) => s === '' || s === '.' || s === '..'))
    throw new PackError(`files: ${p} is not a path inside the pack`)
  const ok =
    /^skills\/[a-z0-9][a-z0-9_-]*\/.+$/.test(p) || /^automations\/[a-z0-9][a-z0-9-]*\.json$/.test(p) || /^silos\/[a-z0-9][a-z0-9-]*\.silo\.json$/.test(p)
  if (!ok) throw new PackError(`files: ${p} — a pack holds skills/<name>/…, automations/<id>.json and silos/<id>.silo.json only`)
}

export function checkPack(raw: unknown): RolePack {
  if (!isObj(raw) || raw.kind !== PACK_KIND || raw.version !== 1) throw new PackError(`not a role pack (kind must be ${PACK_KIND}, version 1)`)
  // a pack made before missions carried role/charter/instructions: no
  // reading of it into a mission is honest (no compatibility — spec header)
  if ('role' in raw || 'charter' in raw || 'instructions' in raw) throw new PackError('this pack predates missions')
  if (JSON.stringify(raw).length > MAX_PACK_BYTES) throw new PackError('the pack is too large')
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) throw new PackError('id: lowercase letters, digits and dashes')
  if (typeof raw.packVersion !== 'string' || !SEMVER.test(raw.packVersion)) throw new PackError('packVersion: a version like 0.1.0')
  const name = str(raw.name, 'name', 80).trim()
  if (!name) throw new PackError('name required')
  const files: Record<string, string> = {}
  if (raw.files !== undefined) {
    if (!isObj(raw.files)) throw new PackError('files must be an object of path → text')
    for (const [p, v] of Object.entries(raw.files)) {
      checkPath(p)
      if (typeof v !== 'string') throw new PackError(`files: ${p} must be text`)
      if (Buffer.byteLength(v) > MAX_FILE_BYTES) throw new PackError(`files: ${p} is over 256 KB`)
      files[p] = v
    }
  }
  const list = <T>(x: unknown, what: string, each: (o: Record<string, unknown>, i: number) => T): T[] => {
    if (x === undefined) return []
    if (!Array.isArray(x)) throw new PackError(`${what} must be a list`)
    return x.map((o, i) => {
      if (!isObj(o)) throw new PackError(`${what}[${i}] must be an object`)
      return each(o, i)
    })
  }
  const skills = list(raw.skills, 'skills', (o, i) => {
    if (typeof o.name !== 'string' || !SKILL.test(o.name)) throw new PackError(`skills[${i}].name: a skill folder name`)
    if (files[`skills/${o.name}/SKILL.md`] === undefined) throw new PackError(`skills: ${o.name} has no skills/${o.name}/SKILL.md in files`)
    return {
      name: o.name,
      ...(typeof o.verified === 'string' ? { verified: o.verified } : {}),
      ...(Array.isArray(o.sources) ? { sources: o.sources.filter((s): s is string => typeof s === 'string').slice(0, 20) } : {}),
      ...(typeof o.reviewEvery === 'string' ? { reviewEvery: o.reviewEvery } : {}),
    }
  })
  const declared = new Set(skills.map((s) => s.name))
  for (const p of Object.keys(files)) {
    const m = /^skills\/([^/]+)\//.exec(p)
    if (m && !declared.has(m[1]!)) throw new PackError(`files: ${p} belongs to a skill the pack does not declare (${m[1]})`)
  }
  const automations = list(raw.automations, 'automations', (o, i) => {
    if (typeof o.template !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(o.template)) throw new PackError(`automations[${i}].template: a template id`)
    const text = files[`automations/${o.template}.json`]
    if (text === undefined) throw new PackError(`automations: ${o.template} has no automations/${o.template}.json in files`)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new PackError(`automations/${o.template}.json is not JSON`)
    }
    try {
      checkTemplate(parsed)
    } catch (e) {
      throw new PackError(`automations/${o.template}.json: ${e instanceof Error ? e.message : String(e)}`)
    }
    return { template: o.template }
  })
  const produces = list(raw.produces, 'produces', (o, i) => {
    if (typeof o.silo !== 'string' || !ID.test(o.silo)) throw new PackError(`produces[${i}].silo: a silo id`)
    return { silo: o.silo, ...(typeof o.version === 'string' ? { version: o.version } : {}) }
  })
  for (const p of Object.keys(files)) {
    const m = /^silos\/(.+)\.silo\.json$/.exec(p)
    if (m && !produces.some((x) => x.silo === m[1])) throw new PackError(`files: ${p} is a silo the pack does not produce`)
  }
  const secrets = list(raw.secrets, 'secrets', (o, i) => {
    if (typeof o.name !== 'string' || !ENV.test(o.name)) throw new PackError(`secrets[${i}].name: an env var name like INVOICING_API_KEY`)
    if ('value' in o) throw new PackError(`secrets[${i}]: a pack names a secret, it never carries its value`)
    return { name: o.name, why: typeof o.why === 'string' ? o.why.slice(0, 200) : '' }
  })
  const territory =
    isObj(raw.territory) && Array.isArray(raw.territory.needs)
      ? { needs: raw.territory.needs.filter((s): s is string => typeof s === 'string').slice(0, 20) }
      : { needs: [] }
  const engine = isObj(raw.engine) && typeof raw.engine.prefer === 'string' ? { prefer: raw.engine.prefer } : {}
  let mission: PackMission | undefined
  if (raw.mission !== undefined) {
    try {
      const m = parseMission(raw.mission)
      if (m) mission = { text: m.text, never: m.never }
    } catch (e) {
      throw new PackError(e instanceof Error ? e.message : String(e))
    }
  }
  return {
    kind: PACK_KIND,
    version: 1,
    id: raw.id,
    packVersion: raw.packVersion,
    name,
    emoji: typeof raw.emoji === 'string' ? raw.emoji.slice(0, 16) : '🤖',
    ...(mission ? { mission } : {}),
    produces,
    skills,
    automations,
    secrets,
    territory,
    engine,
    files,
  }
}

export function templateOf(pack: RolePack, id: string): AutomationTemplate {
  return checkTemplate(JSON.parse(pack.files[`automations/${id}.json`]!))
}

// ---- export ---------------------------------------------------------------------

export interface ExportDeps {
  stateDir: string // agent-state/<id>
  automations: Automation[] // the agent's own
  produced: { silo: string; version?: string; manifest?: unknown }[] // manifest only when not a built-in
  secretNames: string[]
  secrets: Secret[] // values a pack must never hold
  // skills from the agent's FOLDER the owner chose to carry (a
  // role's own skill may live in its project folder) — they install as the
  // new agent's role skills
  folderSkills?: { name: string; dir: string }[]
}

function readTree(dir: string, base: string, out: Record<string, string>, skipped: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      readTree(full, base, out, skipped)
      continue
    }
    if (!e.isFile()) continue
    const rel = relative(base, full)
    if (statSync(full).size > MAX_FILE_BYTES) {
      skipped.push(`${rel}: over 256 KB`)
      continue
    }
    const buf = readFileSync(full)
    const text = buf.toString('utf8')
    if (text.includes('�')) {
      skipped.push(`${rel}: not a text file`)
      continue
    }
    out[rel] = text
  }
}

const slug = (s: string): string => slugify(s, 40) || 'x'

export function exportPack(agent: Agent, deps: ExportDeps, opts: { id?: string; packVersion?: string } = {}): { pack: RolePack; skipped: string[] } {
  const files: Record<string, string> = {}
  const skipped: string[] = []
  const skills: PackSkill[] = []
  const skillsDir = roleSkillsDir(deps.stateDir)
  if (existsSync(skillsDir)) {
    for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!e.isDirectory() || !SKILL.test(e.name) || !existsSync(join(skillsDir, e.name, 'SKILL.md'))) continue
      const tree: Record<string, string> = {}
      readTree(join(skillsDir, e.name), skillsDir, tree, skipped)
      for (const [rel, text] of Object.entries(tree)) files[`skills/${rel}`] = text
      skills.push({ name: e.name })
    }
  }
  for (const f of deps.folderSkills ?? []) {
    if (!SKILL.test(f.name) || skills.some((s) => s.name === f.name) || !existsSync(join(f.dir, 'SKILL.md'))) continue
    const tree: Record<string, string> = {}
    readTree(f.dir, dirname(f.dir), tree, skipped)
    for (const [rel, text] of Object.entries(tree)) files[`skills/${rel}`] = text
    skills.push({ name: f.name })
  }
  // the knowledge age the install recorded, carried on
  try {
    const state = JSON.parse(readFileSync(join(deps.stateDir, 'pack-state.json'), 'utf8')) as { skills?: Record<string, PackSkill> }
    for (const s of skills) Object.assign(s, state.skills?.[s.name] ?? {}, { name: s.name })
  } catch {
    /* never installed from a pack */
  }

  const automations: { template: string }[] = []
  const taken = new Set<string>()
  for (const a of deps.automations) {
    // the old beat is never a template (it was derived from a duty); a webhook carries its own secret
    if (a.id.startsWith('auto-resp-')) continue
    if (a.trigger.kind === 'webhook') {
      skipped.push(`automation «${a.name}»: a webhook carries its own secret`)
      continue
    }
    let id = slug(a.name)
    for (let n = 2; taken.has(id); n++) id = `${slug(a.name)}-${n}`
    try {
      // the owner's «not secret» holds for the automations too
      const t = fromAutomation(a, { id }, deps.secrets)
      taken.add(id)
      files[`automations/${id}.json`] = JSON.stringify(t, null, 2)
      automations.push({ template: id })
    } catch (e) {
      skipped.push(`automation «${a.name}»: ${e instanceof TemplateError ? e.message : String(e)}`)
    }
  }
  const produces = deps.produced.map((p) => {
    if (p.manifest !== undefined) files[`silos/${p.silo}.silo.json`] = JSON.stringify(p.manifest, null, 2)
    return { silo: p.silo, ...(p.version ? { version: p.version } : {}) }
  })
  const pack = checkPack({
    kind: PACK_KIND,
    version: 1,
    id: opts.id ?? slug(agent.name),
    packVersion: opts.packVersion ?? '0.1.0',
    name: agent.name,
    emoji: agent.emoji,
    ...(agent.mission ? { mission: { text: agent.mission.text, never: agent.mission.never } } : {}),
    produces,
    skills,
    automations,
    secrets: deps.secretNames.filter((n) => ENV.test(n)).map((name) => ({ name, why: '' })),
    territory: { needs: [] },
    ...(agent.framework ? { engine: { prefer: agent.framework } } : {}),
    files,
  })
  // a secret's value anywhere in the pack refuses the export, naming the
  // variable and where it sits. Plain configuration in the Vault (a project
  // id) is the owner's to mark public there — `deps.secrets` leaves those
  // out; Silos never guesses it from the value's shape.
  const text = JSON.stringify(pack)
  for (const s of deps.secrets) {
    const holds = (x: string): boolean => redactor([s.value])(x) !== x
    if (!holds(text)) continue
    const where = [
      ...(pack.mission && holds(JSON.stringify(pack.mission)) ? ['its mission'] : []),
      ...(holds(pack.name) ? ['its name'] : []),
      ...Object.entries(pack.files)
        .filter(([, t]) => holds(t))
        .map(([p, t]) => {
          if (!p.startsWith('automations/')) return p
          try {
            return `automation «${String((JSON.parse(t) as { name?: unknown }).name)}»`
          } catch {
            return p
          }
        }),
    ]
    throw new PackError(
      `it holds the value of ${s.name} (in ${where.join(', ') || 'the pack'}) — name the variable ($${s.name}) there instead, or, if that value is not secret, mark it public in the Vault`,
      { name: s.name, where, ...(s.id ? { id: s.id } : {}) },
    )
  }
  return { pack, skipped }
}

// the skills in an agent's folder(s) the export can offer — never the ones
// Silos itself ships (they come with any Silos), never a name the role
// already has as its own
// sources: each folder's `.claude/skills` and the machine's personal
// `~/.claude/skills` (a role's skill may live there) — each offered with
// where it comes from; the owner ticks, nothing is pre-ticked
export function folderSkillsOf(
  sources: readonly { base: string; from: 'folder' | 'personal' }[],
  silosSkillNames: ReadonlySet<string>,
  roleSkills: ReadonlySet<string>,
): { name: string; dir: string; description: string; from: 'folder' | 'personal' }[] {
  const out: { name: string; dir: string; description: string; from: 'folder' | 'personal' }[] = []
  for (const { base, from } of sources) {
    let names: string[] = []
    try {
      names = readdirSync(base)
    } catch {
      continue
    }
    for (const name of names.sort()) {
      const dir = join(base, name)
      if (!SKILL.test(name) || silosSkillNames.has(name) || roleSkills.has(name) || out.some((o) => o.name === name)) continue
      let md = ''
      try {
        md = readFileSync(join(dir, 'SKILL.md'), 'utf8')
      } catch {
        continue
      }
      const description =
        /^description:\s*(.+)$/m
          .exec(md)?.[1]
          ?.trim()
          .replace(/^["']|["']$/g, '')
          .slice(0, 200) ?? ''
      out.push({ name, dir, description, from })
    }
  }
  return out
}

// ---- what installing would do ---------------------------------------------------

export interface InstallTarget {
  id: string
  name?: string
  folder: string
  framework?: string
}

export interface InstallDeps {
  agentExists: (id: string) => boolean
  siloState: (id: string) => { installed: boolean; version: string | null; producers: string[] } | null
  secretVisible: (name: string, agentId: string, folder: string) => boolean
}

export type SiloPlan = { silo: string; action: 'bind' | 'submit' | 'missing'; version: string | null; wanted?: string }
// command: the literal thing it would exec (argv, or a watch's shell check) —
// shown whole, never summarised, because installing it runs it
export type AutomationPlan = { template: string; name: string; sentence: string; ready: boolean; ownerOnly: boolean; command?: string; blanks: string[] }

export interface Consequences {
  agent: { id: string; name: string; emoji: string; folder: string; mission: PackMission | null; framework?: string }
  skills: { name: string; files: number; verified?: string; reviewEvery?: string }[]
  silos: SiloPlan[]
  automations: AutomationPlan[]
  secrets: { name: string; why: string; present: boolean }[]
  territory: string[]
  engine: { prefer?: string; note?: string }
  problems: string[]
}

export function consequences(pack: RolePack, target: InstallTarget, deps: InstallDeps): Consequences {
  const problems: string[] = []
  if (!ID.test(target.id)) problems.push('the agent id: lowercase letters, digits and dashes')
  else if (deps.agentExists(target.id)) problems.push(`an agent ${target.id} already exists — pick another id (one pack makes many agents)`)
  if (typeof target.folder !== 'string' || !target.folder.startsWith('/')) problems.push('the folder must be an absolute path')
  const silos: SiloPlan[] = pack.produces.map((p) => {
    const s = deps.siloState(p.silo)
    if (s?.installed) return { silo: p.silo, action: 'bind', version: s.version, ...(p.version ? { wanted: p.version } : {}) }
    if (pack.files[`silos/${p.silo}.silo.json`] !== undefined)
      return { silo: p.silo, action: 'submit', version: null, ...(p.version ? { wanted: p.version } : {}) }
    return { silo: p.silo, action: 'missing', version: null, ...(p.version ? { wanted: p.version } : {}) }
  })
  const automations: AutomationPlan[] = pack.automations.map((a) => {
    const t = templateOf(pack, a.template)
    const blanks = t.params.filter((p) => p.key !== 'agent' && p.default === undefined).map((p) => p.label)
    const run = t.automation.run as { kind?: string; argv?: unknown; cwd?: unknown } | undefined
    const trig = t.automation.trigger as { kind?: string; check?: { type?: string; command?: unknown } } | undefined
    // whether it execs is decided by its KIND; the words shown never decide
    // it — an unexpected shape is dumped raw (fail closed)
    const execs = run?.kind === 'command' || (trig?.kind === 'watch' && trig.check?.type === 'command')
    const command = !execs
      ? undefined
      : run?.kind === 'command' && Array.isArray(run.argv)
        ? `${argvLine(run.argv.map(String))}${typeof run.cwd === 'string' ? `  (in ${run.cwd})` : ''}`
        : trig?.kind === 'watch' && typeof trig.check?.command === 'string'
          ? trig.check.command
          : JSON.stringify(run?.kind === 'command' ? run : trig?.check)
    return {
      template: a.template,
      name: t.name,
      sentence: t.sentence,
      ready: blanks.length === 0 && t.params.some((p) => p.key === 'agent' && p.kind === 'agent'),
      ownerOnly: execs,
      ...(command !== undefined ? { command } : {}),
      blanks,
    }
  })
  const framework = target.framework ?? pack.engine.prefer
  return {
    agent: {
      id: target.id,
      name: target.name?.trim() || pack.name,
      emoji: pack.emoji,
      folder: target.folder,
      mission: pack.mission ?? null,
      ...(target.framework ? { framework: target.framework } : {}),
    },
    skills: pack.skills.map((s) => ({
      name: s.name,
      files: Object.keys(pack.files).filter((p) => p.startsWith(`skills/${s.name}/`)).length,
      ...(s.verified ? { verified: s.verified } : {}),
      ...(s.reviewEvery ? { reviewEvery: s.reviewEvery } : {}),
    })),
    silos,
    automations,
    secrets: pack.secrets.map((s) => ({ ...s, present: deps.secretVisible(s.name, target.id, target.folder) })),
    territory: pack.territory.needs,
    // engine-neutral (harness boundary): the pack names a preference; when
    // this install runs it elsewhere, the dialog says so
    engine: {
      ...(pack.engine.prefer ? { prefer: pack.engine.prefer } : {}),
      ...(framework && pack.engine.prefer && framework !== pack.engine.prefer
        ? { note: `Made on ${pack.engine.prefer}, it runs here on ${framework}: its skills cross; anything that engine does not support, it skips.` }
        : {}),
    },
    problems,
  }
}

// ---- writing the skills -------------------------------------------------------

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

// the role's skills into agent-state/<id>/plugin, the lockfile beside them,
// the knowledge age in pack-state.json
export function writeSkills(pack: RolePack, stateDir: string, agentId: string, agentName: string, now: Date): number {
  const skillsDir = roleSkillsDir(stateDir)
  const lock: Record<string, string> = {}
  let n = 0
  for (const [p, text] of Object.entries(pack.files)) {
    if (!p.startsWith('skills/')) continue
    const dest = join(skillsDir, p.slice('skills/'.length))
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, text)
    lock[p.slice('skills/'.length)] = sha(text)
    n++
  }
  if (n > 0) {
    const plugin = rolePluginDir(stateDir)
    ensureRolePluginManifest(plugin, agentId, agentName)
    writeFileSync(join(plugin, '.pack.json'), JSON.stringify({ pack: { id: pack.id, packVersion: pack.packVersion }, files: lock }, null, 2) + '\n')
    // Silos' own write: the plugin's tree seal follows (seals.ts)
    sealHooks().pluginWritten?.(plugin)
  }
  writeFileSync(
    join(stateDir, 'pack-state.json'),
    JSON.stringify(
      {
        pack: { id: pack.id, packVersion: pack.packVersion },
        installedAt: now.toISOString(),
        skills: Object.fromEntries(
          pack.skills.map((s) => [
            s.name,
            {
              ...(s.verified ? { verified: s.verified } : {}),
              ...(s.sources ? { sources: s.sources } : {}),
              ...(s.reviewEvery ? { reviewEvery: s.reviewEvery } : {}),
            },
          ]),
        ),
      },
      null,
      2,
    ) + '\n',
  )
  return n
}
