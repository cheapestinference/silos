// routes/role-packs.ts — a role as a unit that copies (role-pack.ts).
// All three routes are the
// owner's: exporting reads an agent's skills and automations, installing
// creates an agent and binds silos — an agent bearer gets 403 on each.
//
//   GET  /api/agents/:id/role-pack   «Save as role pack»: { pack, skipped }
//   POST /api/role-packs/preview      { pack, target } → { consequences }
//   POST /api/role-packs/install      { pack, target, automations?: [ids], secrets?: {NAME: value} }
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { applyStartingSet, type StartingSetDeps } from '../starting-set.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AgentRegistry } from '../agent-registry.js'
import type { AgentStateStore } from '../agent-state.js'
import type { AutomationsStore } from '../automations-store.js'
import type { AutomationTemplates, Secret } from '../automation-templates.js'
import { fillTemplate, TemplateError } from '../automation-templates.js'
import type { SiloRegistry } from '../silos/registry.js'
import type { SiloOperatorStore } from '../silos/operator.js'
import type { SiloInstaller } from '../silos/installer.js'
import type { VaultStore } from '../vault-store.js'
import { isHarnessId } from '../harnesses/registry.js'
import type { AutomationCreateApi } from './automations.js'
import { checkPack, consequences, exportPack, folderSkillsOf, PackError, templateOf, writeSkills, type InstallTarget, type RolePack } from '../role-pack.js'
import { roleSkillNames } from '../role-plugin.js'
import { silosSkillNames } from '../skill-states.js'
import type { TerritoryStore } from '../territory-store.js'

export interface RolePackRoutesCtx {
  registry: AgentRegistry
  agentState: AgentStateStore
  automations: AutomationsStore
  createAutomation: AutomationCreateApi
  templates: AutomationTemplates
  siloRegistry: SiloRegistry | undefined
  siloOperator: SiloOperatorStore | undefined
  siloInstaller: SiloInstaller | undefined
  vault: VaultStore | undefined
  secrets: () => Secret[]
  // Silos' own skills (plugin/skills) — never offered as the role's
  pluginSkillsDir?: string
  // the machine's home: personal skills live in <home>/.claude/skills
  home?: string
  // fence at birth: the installed agent is born fenced
  territoryStore?: Pick<TerritoryStore, 'enableAtBirth'>
  // what the folder starts with when it is born with this agent (starting-set.ts)
  startingSettings?: StartingSetDeps['settings']
}

const ownerOnly = (req: FastifyRequest, reply: FastifyReply): boolean => {
  if (req.agentId === undefined) return false
  void reply.code(403).send({ error: `agent ${req.agentId} may not do this — role packs are the owner's` })
  return true
}

export function rolePackRoutes(app: FastifyInstance, ctx: RolePackRoutesCtx): void {
  const { registry, agentState, siloRegistry, siloOperator, siloInstaller, vault } = ctx

  const siloState = (id: string) => {
    const op = siloOperator?.get(id)
    const entry = siloRegistry?.get(id)
    if (!op || op.decision === 'uninstalled' || !entry) return null
    return { installed: true, version: entry.status.manifest.version, producers: [...op.producers] }
  }
  const deps = {
    agentExists: (id: string) => registry.get(id) !== null,
    siloState,
    secretVisible: (name: string, agentId: string, folder: string) => (vault?.viewFor(agentId, [folder]) ?? []).some((e) => e.name === name),
  }
  const readBody = (b: unknown): { pack: RolePack; target: InstallTarget } => {
    const o = (b ?? {}) as { pack?: unknown; target?: unknown }
    const pack = checkPack(o.pack)
    const t = (o.target ?? {}) as Record<string, unknown>
    const target: InstallTarget = {
      id: typeof t.id === 'string' ? t.id.trim() : '',
      folder: typeof t.folder === 'string' ? t.folder.trim() : '',
      ...(typeof t.name === 'string' && t.name.trim() ? { name: t.name.trim() } : {}),
      ...(typeof t.framework === 'string' && t.framework ? { framework: t.framework } : {}),
    }
    if (target.framework !== undefined && !isHarnessId(target.framework)) throw new PackError(`${target.framework} is not an engine Silos runs`)
    return { pack, target }
  }
  const fail = (reply: FastifyReply, err: unknown) =>
    reply.code(err instanceof PackError || err instanceof TemplateError ? 400 : 500).send({
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof PackError && err.secret ? { secret: err.secret } : {}),
    })

  const folderSkillsFor = (agentId: string) => {
    const agent = registry.get(agentId)
    if (!agent) return null
    let silosOwn: string[] = []
    try {
      silosOwn = ctx.pluginSkillsDir ? silosSkillNames(ctx.pluginSkillsDir) : []
    } catch {
      /* none */
    }
    const folders = [agent.folder, ...(agent.folders ?? [])].filter((f): f is string => typeof f === 'string' && f.startsWith('/'))
    const sources = [
      ...folders.map((f) => ({ base: join(f, '.claude', 'skills'), from: 'folder' as const })),
      ...(ctx.home ? [{ base: join(ctx.home, '.claude', 'skills'), from: 'personal' as const }] : []),
    ]
    return folderSkillsOf(sources, new Set(silosOwn), new Set(roleSkillNames(agentState.dirFor(agentId))))
  }

  // what the export can offer from the agent's folder: the owner ticks which travel
  app.get<{ Params: { id: string } }>('/api/agents/:id/role-pack/folder-skills', async (req, reply) => {
    if (ownerOnly(req, reply)) return
    const list = folderSkillsFor(req.params.id)
    if (!list) return reply.code(404).send({ error: 'agent not found' })
    return { skills: list.map(({ name, description, from }) => ({ name, description, from })) }
  })

  app.get<{ Params: { id: string }; Querystring: { folderSkills?: string } }>('/api/agents/:id/role-pack', async (req, reply) => {
    if (ownerOnly(req, reply)) return
    const agent = registry.get(req.params.id)
    if (!agent) return reply.code(404).send({ error: 'agent not found' })
    const produced = (siloOperator?.list() ?? [])
      .filter((s) => s.decision !== 'uninstalled' && s.producers.includes(agent.id))
      .map((s) => {
        const version = siloRegistry?.get(s.id)?.status.manifest.version ?? undefined
        // a built-in travels by id; an operator's own silo travels inside the pack
        const file = siloRegistry ? join(siloRegistry.registryDir, s.id, 'silo.json') : null
        const manifest = s.provenance !== 'builtin' && file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : undefined
        return { silo: s.id, ...(version ? { version } : {}), ...(manifest !== undefined ? { manifest } : {}) }
      })
    const secretNames = [
      ...new Set((vault?.list() ?? []).filter((e) => e.scope.type === 'agents' && e.scope.agentIds.includes(agent.id)).map((e) => e.name)),
    ].sort()
    try {
      return exportPack(agent, {
        stateDir: agentState.dirFor(agent.id),
        automations: ctx.automations.list().filter((a) => a.agentId === agent.id),
        produced,
        secretNames,
        secrets: ctx.secrets(),
        // only names the lister offers — never a path from the query
        folderSkills: (() => {
          const wanted = new Set(
            (req.query.folderSkills ?? '')
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean),
          )
          return wanted.size ? (folderSkillsFor(agent.id) ?? []).filter((s) => wanted.has(s.name)) : []
        })(),
      })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.post<{ Body: unknown }>('/api/role-packs/preview', async (req, reply) => {
    if (ownerOnly(req, reply)) return
    try {
      const { pack, target } = readBody(req.body)
      return { consequences: consequences(pack, target, deps) }
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.post<{ Body: unknown }>('/api/role-packs/install', async (req, reply) => {
    if (ownerOnly(req, reply)) return
    let pack: RolePack, target: InstallTarget
    try {
      ;({ pack, target } = readBody(req.body))
    } catch (err) {
      return fail(reply, err)
    }
    const c = consequences(pack, target, deps)
    if (c.problems.length > 0) return reply.code(400).send({ error: c.problems.join('; '), consequences: c })
    const b = (req.body ?? {}) as { automations?: unknown; secrets?: unknown }
    const ids = (x: unknown): Set<string> => new Set(Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : [])
    const chosen = ids(b.automations)
    // a template that execs is made only when the owner confirmed THAT command
    // in its own list — never from the plain opt-in (security review:
    // one Install of a foreign pack could schedule an arbitrary command)
    const confirmed = ids((req.body as { confirmCommands?: unknown } | null)?.confirmCommands)
    const values = (typeof b.secrets === 'object' && b.secrets !== null ? b.secrets : {}) as Record<string, unknown>

    // 1. the agent — template ≠ instance: a new agent that remembers its pack
    let agent
    let fenceWarn: string | undefined
    let startWarn: string | undefined
    try {
      agent = registry.create({
        id: target.id,
        name: c.agent.name,
        emoji: pack.emoji,
        folder: target.folder,
        ...(target.framework ? { framework: target.framework as never } : {}),
        ...(pack.mission ? { mission: pack.mission } : {}),
      })
      // born fenced, first thing after the create (never throws): nothing
      // below can leave the agent created-but-unfenced
      fenceWarn = ctx.territoryStore?.enableAtBirth(agent)
      // the folder's first agent of this engine: what the project starts with
      if (ctx.startingSettings) startWarn = applyStartingSet({ registry, home: ctx.home ?? homedir(), settings: ctx.startingSettings }, agent, null)
      registry.update(agent.id, { pack: { id: pack.id, packVersion: pack.packVersion } })
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }

    // 2. its skills, through role skills
    const skillFiles = writeSkills(pack, agentState.dirFor(agent.id), agent.id, agent.name, new Date())

    // 3. its automations: every template into the catalog; the chosen, ready ones made
    const automations: { template: string; saved?: string; automationId?: string; error?: string }[] = []
    for (const a of c.automations) {
      const t = templateOf(pack, a.template)
      const catalogId = `${pack.id}-${t.id}`.slice(0, 63).replace(/-+$/, '')
      let saved: string | undefined
      try {
        saved = ctx.templates.save({ ...t, id: catalogId }, { replace: true }).id
      } catch {
        /* an id clash with a built-in: the automation can still be made */
      }
      if (!chosen.has(a.template)) {
        automations.push({ template: a.template, ...(saved ? { saved } : {}) })
        continue
      }
      if (a.ownerOnly && !confirmed.has(a.template)) {
        automations.push({
          template: a.template,
          ...(saved ? { saved } : {}),
          error: 'runs a command — not made; confirm its command, or make it from Automations › New',
        })
        continue
      }
      if (!a.ready) {
        automations.push({ template: a.template, ...(saved ? { saved } : {}), error: `fill in ${a.blanks.join(', ')} from Automations › New` })
        continue
      }
      try {
        const made = ctx.createAutomation.create(undefined, fillTemplate(t, { agent: agent.id }, registry))
        automations.push(
          'error' in made
            ? { template: a.template, ...(saved ? { saved } : {}), error: made.error }
            : { template: a.template, ...(saved ? { saved } : {}), automationId: made.id },
        )
      } catch (err) {
        automations.push({ template: a.template, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // 4. the silos it produces: bind the producer, or submit the pack's own as pending
    const silos: { silo: string; done: 'bound' | 'submitted' | 'missing' | 'failed'; error?: string }[] = []
    for (const s of c.silos) {
      if (s.action === 'bind' && siloInstaller) {
        const r = siloInstaller.operatorPatch(s.silo, { producers: [...(siloState(s.silo)?.producers ?? []), agent.id] })
        silos.push(
          r.code === 200 ? { silo: s.silo, done: 'bound' } : { silo: s.silo, done: 'failed', error: String((r.body as { error?: unknown }).error ?? r.code) },
        )
      } else if (s.action === 'submit' && siloInstaller) {
        const r = siloInstaller.submit({ manifest: JSON.parse(pack.files[`silos/${s.silo}.silo.json`]!) }, 'owner', {
          from: `the role pack ${pack.id}`,
          producers: [agent.id],
        })
        silos.push(
          r.code < 300 ? { silo: s.silo, done: 'submitted' } : { silo: s.silo, done: 'failed', error: String((r.body as { error?: unknown }).error ?? r.code) },
        )
      } else silos.push({ silo: s.silo, done: 'missing' })
    }

    // 5. the secrets it needs: a value given goes to the Vault, scoped to this agent
    const secrets: { name: string; state: 'stored' | 'present' | 'missing'; error?: string }[] = []
    for (const s of c.secrets) {
      const v = values[s.name]
      if (typeof v === 'string' && v !== '' && vault) {
        try {
          vault.create({ name: s.name, value: v, scope: { type: 'agents', agentIds: [agent.id] } })
          secrets.push({ name: s.name, state: 'stored' })
        } catch (err) {
          secrets.push({ name: s.name, state: 'missing', error: err instanceof Error ? err.message : String(err) })
        }
      } else secrets.push({ name: s.name, state: deps.secretVisible(s.name, agent.id, target.folder) ? 'present' : 'missing' })
    }

    return reply.code(201).send({
      agent: registry.get(agent.id),
      report: { skillFiles, automations, silos, secrets },
      ...(fenceWarn ? { warn: fenceWarn } : {}),
      ...(startWarn ? { startWarn } : {}),
    })
  })
}
