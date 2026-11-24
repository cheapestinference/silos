// routes/skills.ts — the skills surface: the catalog with descriptions,
// one skill's README, the per-agent and per-folder capability-state
// gestures (add/hold/activate) and the Silos-skills offer, moved VERBATIM
// out of server.ts (the monoliths split by domain, behavior unchanged).
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { AgentRegistry } from '../agent-registry.js'
import type { Agent } from '../types.js'
import type { SessionIndex } from '../session-index.js'
import { notAddableWhy, notHoldableWhy, parseSkillMd, type CompleteService, type SkillCatalogEntry, type SkillsConversation } from '../complete-service.js'
import { PURE_DOTS } from '../segments.js'
import { activateSkill, addSkill, holdSkill, silosSkillNames } from '../skill-states.js'
import { managedFolderOf as managedFolder } from '../managed-folder.js'
import { syncSkillCopies } from '../skill-install.js'
import { LoadsSwitchError, type LoadsSkillTarget } from '../harnesses/contract.js'

export interface SkillRoutesCtx {
  complete: CompleteService
  registry: AgentRegistry
  index: SessionIndex
  pluginSkillsDir: string | undefined
  dataDir: string | undefined
  /** one skill's position or the account origin, through the folder's
   *  engine's one writer (folder-loads.ts switchFolderSkill) */
  switchSkill?: (
    folder: string,
    harnessId: string,
    target: LoadsSkillTarget,
    to: string,
    at?: { scope: 'project' | 'machine' } | { scope: 'agent'; agent: string } | { scope: 'conversation'; conversation: SkillsConversation },
  ) => void
  // ONE conversation's place (spec scopes §6): the session the web holds,
  // resolved by the SERVER to its cwd, thread, agent and the thread's
  // sessions (server.ts, conversation-places.ts); null: none the index knows
  conversationOf?: (sessionId: string) => { cwd: string | null; thread: string; agent: string | null; sessions: string[] } | null
  /** the logins that follow the machine's own settings file, asked now —
   *  what a skill's «This machine» line answers (who did, who didn't) */
  followMachine?: () => { name: string; followed: boolean; why?: string; file?: string }[]
}

export function skillRoutes(app: FastifyInstance, ctx: SkillRoutesCtx): void {
  const { complete, registry, pluginSkillsDir, dataDir } = ctx
  // Skills catalog WITH description (Skills tab of AgentPage) — distinct
  // from /complete?kind=skills (names only, used by the `@`/`/` autocomplete
  // and the creation modal; left intact so as not to break that contract).
  // `?conversation=<session id>`: with that ONE conversation's line on each
  // skill (its column's Knows › Skills) — a session that is no
  // conversation of this agent's folder is 404
  const conversationIn = (folder: string | null | undefined, sessionId: unknown): SkillsConversation | null => {
    if (!folder || typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !ctx.conversationOf) return null
    const c = ctx.conversationOf(sessionId)
    return c && c.cwd === folder ? { thread: c.thread, agent: c.agent, sessions: c.sessions } : null
  }
  app.get<{ Params: { id: string }; Querystring: { conversation?: string } }>('/api/agents/:id/skills-catalog', async (req, reply) => {
    try {
      if (req.query.conversation !== undefined) {
        const conv = conversationIn(registry.get(req.params.id)?.folder, req.query.conversation)
        if (!conv) return reply.code(404).send({ error: 'no conversation of this agent’s project' })
        return { skills: await complete.skillsCatalog(req.params.id, conv), conversation: { thread: conv.thread, agent: conv.agent } }
      }
      return { skills: await complete.skillsCatalog(req.params.id) }
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err)
      return reply.code(message.includes('not found') ? 404 : 400).send({ error: message })
    }
  })

  // Skills dimension — full readme (SKILL.md without frontmatter) of a
  // skill from the disk catalog. Name validated by regex (never lets '/'
  // or '..' through); complete.skillReadme also checks by REALPATH that
  // the resolved file stays inside skillsDir (defense in depth against
  // symlinks, same criterion as the subagents endpoint above).
  const SKILL_NAME = /^[\w.:-]+$/
  app.get<{ Params: { name: string } }>('/api/skills/:name', async (req, reply) => {
    // The regex alone let dots-only segments through ('..' etc, every
    // character is valid in \w.:-) — the regex must close this case on
    // its own, not rely solely on the downstream realpath.
    if (!SKILL_NAME.test(req.params.name) || PURE_DOTS.test(req.params.name)) {
      return reply.code(400).send({ error: 'invalid skill name' })
    }
    const readme = await complete.skillReadme(req.params.name)
    if (!readme) return reply.code(404).send({ error: 'skill not found in the catalog' })
    return readme
  })

  // Skill states (capability states) — hold (turn off: move the
  // folder copy to <dataDir>/skills-held), activate (turn on: move it
  // back), add (a real copy of a plugin skill into the folder). All three
  // act on the agent's PRIMARY folder — the unit the engine respects — and
  // return the refreshed catalog so the UI repaints from one response.
  // Owner-only (agent bearers' write allow-list never includes these);
  // same unknown/archived → 404 criterion as the sibling agent routes.
  {
    const skillsDataDir = dataDir ?? join(homedir(), '.silos')
    // one gesture, two doors: the agent page acts on the agent's primary
    // folder, the project page on the folder itself — both run THIS body
    // with the folder they resolved and the catalog of that same folder
    const actOnSkill = async (
      reply: FastifyReply,
      action: 'hold' | 'activate' | 'add',
      folder: string,
      name: string,
      catalogOf: () => Promise<SkillCatalogEntry[]>,
    ) => {
      if (!SKILL_NAME.test(name) || PURE_DOTS.test(name)) return reply.code(400).send({ error: 'invalid skill name' })
      try {
        if (action === 'hold') {
          // a copy whose personal twin loads changes nothing when held —
          // refused in plain words (complete-service.ts notHoldableWhy)
          const catalog = await catalogOf()
          const why = notHoldableWhy(
            name,
            catalog.find((s) => s.name === name && s.state === 'active'),
          )
          if (why !== null) return reply.code(400).send({ error: why })
          holdSkill(skillsDataDir, folder, name)
        } else if (action === 'activate') {
          activateSkill(skillsDataDir, folder, name)
          // an untouched older release turned back on comes back current
          // (an edited copy stays the operator's — skill-install.ts)
          if (pluginSkillsDir) {
            try {
              syncSkillCopies(pluginSkillsDir, folder)
            } catch {
              /* the follower's next pass */
            }
          }
        } else {
          if (!pluginSkillsDir) return reply.code(501).send({ error: 'plugin skills are unavailable in this deployment (plugin/skills missing)' })
          // the catalog's 'available' IS what add can do (Silos' plugin
          // skills the folder neither loads nor holds) — one rule for the
          // offer and the gesture, so nothing offered can fail as "not
          // addable", and nothing refused here was ever offered
          // (a held copy wins over a personal twin of the same name)
          const catalog = await catalogOf()
          const entry = catalog.find((s) => s.name === name && s.state === 'held') ?? catalog.find((s) => s.name === name)
          const why = notAddableWhy(name, entry)
          if (why !== null) return reply.code(400).send({ error: why })
          addSkill(pluginSkillsDir, skillsDataDir, folder, name)
        }
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
      }
      return { skills: await catalogOf() }
    }
    const skillStateRoute = (action: 'hold' | 'activate' | 'add') => {
      app.post<{ Params: { id: string; name: string } }>(`/api/agents/:id/skills/:name/${action}`, async (req, reply) => {
        const agent = registry.list().find((a) => a.id === req.params.id && !a.archived)
        if (!agent) return reply.code(404).send({ error: 'unknown agent' })
        if (!agent.folder) return reply.code(400).send({ error: 'agent has no folder' })
        return actOnSkill(reply, action, agent.folder, req.params.name, () => complete.skillsCatalog(agent.id))
      })
      // the project page's door (the folder is the house of
      // its skills): the :folder segment is the folder's exact path,
      // URI-encoded, resolved ONLY onto a managed folder (managed-folder.ts,
      // the /api/folders/:folder/loads rule) — never an arbitrary path, never through
      // an agent whose primary folder is elsewhere. Owner-only: no agent
      // allow-list names /api/folders (agent-authz.ts), refused here too.
      app.post<{ Params: { folder: string; name: string } }>(`/api/folders/:folder/skills/:name/${action}`, async (req, reply) => {
        if (req.agentId !== undefined) return reply.code(403).send({ error: `agent ${req.agentId} may not switch a folder's skills` })
        const folder = managedFolder(registry, req.params.folder)
        if (folder === null) return reply.code(404).send({ error: 'unknown folder' })
        return actOnSkill(reply, action, folder, req.params.name, () => complete.folderCatalog(folder))
      })
    }
    skillStateRoute('hold')
    skillStateRoute('activate')
    skillStateRoute('add')
    // The three positions of an account or personal skill (on · name only ·
    // off) and the head of the Claude account's skills (on/off) — Project ›
    // Skills, the folder's house. Written only in the folder's local
    // settings file by the engine's one writer; never the personal skills
    // folder, never ~/.claude. Owner-only, managed folders only.
    //
    // `scope` (spec scopes T9): absent or 'project' — as above; 'machine'
    // — the user's own settings file, on this click only, and the answer
    // names any login that did not follow it; 'agent' (+ `agent`) — only
    // that agent's launches, kept by Silos (loads-scopes.ts): nothing under
    // the folder or ~/.claude is written. A skill of the project (`from`
    // 'project') has agent lines only — its project line is its hold.
    const skillSwitch = async (
      reply: FastifyReply,
      folder: string,
      target: LoadsSkillTarget,
      to: string,
      at?: { scope: 'project' | 'machine' } | { scope: 'agent'; agent: string } | { scope: 'conversation'; conversation: SkillsConversation },
    ) => {
      if (!ctx.switchSkill) return reply.code(409).send({ error: 'no skill switches here' })
      try {
        if (at) ctx.switchSkill(folder, complete.folderEngine(folder), target, to, at)
        else ctx.switchSkill(folder, complete.folderEngine(folder), target, to)
      } catch (err) {
        if (err instanceof LoadsSwitchError) return reply.code(err.status).send({ error: err.message })
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
      }
      if (at?.scope === 'machine') {
        let follow: { name: string; followed: boolean; why?: string; file?: string }[] = []
        try {
          follow = ctx.followMachine?.() ?? []
        } catch (err) {
          console.warn('skills: the logins did not follow the machine:', err instanceof Error ? err.message : String(err))
        }
        return {
          skills: await complete.folderCatalog(folder),
          logins: {
            followed: follow.filter((f) => f.followed).map((f) => f.name),
            missed: follow.filter((f) => !f.followed).map((f) => ({ name: f.name, why: f.why ?? 'error', ...(f.file ? { file: f.file } : {}) })),
          },
        }
      }
      return { skills: await complete.folderCatalog(folder) }
    }
    app.post<{
      Params: { folder: string; name: string }
      Body: { to?: unknown; from?: unknown; scope?: unknown; agent?: unknown; conversation?: unknown } | null
    }>('/api/folders/:folder/skills/:name/position', async (req, reply) => {
      if (req.agentId !== undefined) return reply.code(403).send({ error: `agent ${req.agentId} may not switch a folder's skills` })
      const folder = managedFolder(registry, req.params.folder)
      if (folder === null) return reply.code(404).send({ error: 'unknown folder' })
      const name = req.params.name
      if (!SKILL_NAME.test(name) || PURE_DOTS.test(name)) return reply.code(400).send({ error: 'invalid skill name' })
      const to = req.body?.to,
        from = req.body?.from,
        scope = req.body?.scope,
        agent = req.body?.agent,
        conversation = req.body?.conversation
      if (to !== 'on' && to !== 'name-only' && to !== 'off') return reply.code(400).send({ error: "to must be 'on', 'name-only' or 'off'" })
      if (from !== 'account' && from !== 'personal' && from !== 'project')
        return reply.code(400).send({ error: "from must be 'account', 'personal' or 'project'" })
      if (scope !== undefined && scope !== 'project' && scope !== 'machine' && scope !== 'agent' && scope !== 'conversation')
        return reply.code(400).send({ error: "scope must be 'project', 'machine', 'agent' or 'conversation'" })
      // 'conversation' (+ `conversation`, a session id): only that
      // conversation's launches, kept under the thread the server resolves
      let conv: SkillsConversation | null = null
      if (scope === 'conversation') {
        if (typeof conversation !== 'string' || conversation === '') return reply.code(400).send({ error: 'conversation required with scope conversation' })
        conv = conversationIn(folder, conversation)
        if (!conv) return reply.code(404).send({ error: 'no conversation of this project' })
      } else if (conversation !== undefined) return reply.code(400).send({ error: 'a conversation goes with scope conversation' })
      if (scope === 'agent') {
        if (typeof agent !== 'string' || agent === '' || agent.length > 128) return reply.code(400).send({ error: 'agent required with scope agent' })
      } else if (agent !== undefined) return reply.code(400).send({ error: 'an agent goes with scope agent' })
      const at =
        scope === 'agent'
          ? { scope: 'agent' as const, agent: agent as string }
          : scope === 'machine'
            ? { scope: 'machine' as const }
            : conv
              ? { scope: 'conversation' as const, conversation: conv }
              : undefined
      return skillSwitch(reply, folder, { kind: 'skill', name, from }, to, at)
    })
    app.post<{ Params: { folder: string }; Body: { to?: unknown } | null }>('/api/folders/:folder/skills-origin', async (req, reply) => {
      if (req.agentId !== undefined) return reply.code(403).send({ error: `agent ${req.agentId} may not switch a folder's skills` })
      const folder = managedFolder(registry, req.params.folder)
      if (folder === null) return reply.code(404).send({ error: 'unknown folder' })
      const to = req.body?.to
      if (to !== 'on' && to !== 'off') return reply.code(400).send({ error: "to must be 'on' or 'off'" })
      return skillSwitch(reply, folder, { kind: 'origin' }, to)
    })
    app.get<{ Params: { folder: string } }>('/api/folders/:folder/skills-catalog', async (req, reply) => {
      if (req.agentId !== undefined) return reply.code(403).send({ error: `agent ${req.agentId} may not read a folder's skills` })
      const folder = managedFolder(registry, req.params.folder)
      if (folder === null) return reply.code(404).send({ error: 'unknown folder' })
      return { folder, skills: await complete.folderCatalog(folder) }
    })
    // Silos' plugin skills. Bare: the inventory (Settings › Skills). With
    // `framework` (+ `folder`, the draft agent's): what the create modal may
    // offer — exactly what "add" will accept for THAT agent, from the same
    // catalog rule (complete-service.ts silosSkillOffer), plus the plain
    // reason for each it won't (on OpenCode every Silos skill already loads
    // from the launch root; on Claude Code a folder copy or a personal twin)
    app.get<{ Querystring: { framework?: string; folder?: string } }>('/api/silos-skills', async (req, reply) => {
      if (req.query.framework !== undefined) {
        const folder = req.query.folder?.trim() ?? ''
        if (folder !== '' && !isAbsolute(folder)) return reply.code(400).send({ error: 'folder must be an absolute path' })
        return complete.silosSkillOffer({ folder: folder === '' ? null : folder, framework: req.query.framework as Agent['framework'] })
      }
      return {
        skills: pluginSkillsDir
          ? silosSkillNames(pluginSkillsDir).map((name) => {
              let description: string | undefined
              try {
                description = parseSkillMd(readFileSync(join(pluginSkillsDir, name, 'SKILL.md'), 'utf8').slice(0, 8000)).description
              } catch {
                /* listed by name */
              }
              return { name, ...(description !== undefined ? { description } : {}) }
            })
          : [],
      }
    })
  }
}
