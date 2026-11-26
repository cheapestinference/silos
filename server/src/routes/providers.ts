// routes/providers.ts — accounts and providers (Providers v1): the
// subscription-load and plan-usage lines, the provider CRUD/export/verify/
// connect, gateway model listings and the Claude accounts service, moved
// VERBATIM out of server.ts (split the monoliths by
// domain, behavior unchanged). The old `if (providers && accounts)` guard
// moved inside; account-load and plan-usage register always, as before.
import type { FastifyInstance, FastifyReply } from 'fastify'
import { maskProvider, type ProvidersStore } from '../providers-store.js'
import type { AccountsService } from '../harnesses/claude-code/accounts.js'
import { validateProviderCreate, validateProviderPatch } from '../providers-validate.js'
import { fetchGatewayModels, gatewayAutoLabel, isBareGatewayLabel, type GatewayModelLimits } from '../provider-models.js'
import type { GatewayModelsRefresher } from '../gateway-models.js'
import type { ChatService } from '../chat-service.js'
import type { HarnessId, HarnessServerHooks } from '../harnesses/contract.js'
import { articleFor, engineProviderLabel, harnessById, nonFallbackFirst, providerOwners, quotedIds, registeredHarnesses } from '../harnesses/registry.js'
import type { AccountLoad } from '../harnesses/claude-code/account-load.js'
import type { PlanUsage } from '../harnesses/claude-code/plan-usage.js'
import type { TerminalService } from '../terminal-service.js'
import { enginesKeepingOwn, startingClassesOf, startingSetError, unattendedProviderError, type PlatformSettingsStore } from '../platform-settings.js'
import { projectsFolderOf, type FolderVerdict } from '../project-folder.js'

export interface ProviderRoutesCtx {
  providers: ProvidersStore | undefined
  accounts: AccountsService | undefined
  chat: ChatService
  gatewayModels: GatewayModelsRefresher | undefined
  accountLoad: { snapshot(): AccountLoad } | undefined
  planUsage: { get(providerId: string): Promise<PlanUsage | null>; peek?(providerId: string): PlanUsage | null } | undefined
  verifyFetch: typeof fetch | undefined
  hooks: (id: HarnessId) => HarnessServerHooks
  terminals: TerminalService
  // the install's settings (platform-settings.ts) — absent: no
  // /api/settings (Settings hides the switch on 404)
  settings?: PlatformSettingsStore
  // the engines the roster runs on (every agent in play) — what the switch's
  // «runs on none of your agents' engines» and «keep their own account» read
  enginesInUse?: () => HarnessId[]
  // the Projects folder (`projectsDir`): the machine's home (where it is
  // now: projectsFolderOf) and the check a new one passes (checkProjectsDir,
  // against every registered project)
  projectsFolder?: { home: string; check: (path: string) => FolderVerdict }
}

/** A path as the owner reads it: `~/…` under the home. */
const tilde = (home: string, p: string): string => {
  const h = home.replace(/(.)\/+$/, '$1')
  return p === h ? '~' : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p
}

export function providerRoutes(app: FastifyInstance, ctx: ProviderRoutesCtx): void {
  const { providers, accounts, chat, gatewayModels, accountLoad, planUsage, hooks, terminals } = ctx
  // Home's "on your Claude subscription now" line. The OWNER's: an agent
  // bearer never reads the machine's process table (it is not on any
  // agent allow-list — agent-authz.ts; refused here too, belt and braces).
  app.get('/api/account-load', async (req, reply) => {
    if (req.agentId !== undefined) return reply.code(403).send({ error: `agent ${req.agentId} may not read /api/account-load` })
    return accountLoad ? accountLoad.snapshot() : { supported: false }
  })

  // the install's unattended provider: GET says it and the
  // engines that keep their own account under it; PATCH sets it — the
  // owner's (an agent bearer never chooses what unattended turns spend on)
  const settings = ctx.settings
  if (settings) {
    const inUse = (): HarnessId[] => {
      const engines = ctx.enginesInUse?.() ?? []
      return engines.length > 0 ? engines : registeredHarnesses().map((h) => h.id)
    }
    const view = () => {
      const id = settings.unattendedProvider()
      // the starting set: per engine that declares classes, each class with
      // Silos' recommendation and what this install picked (absent: Recommended)
      const startingSet = Object.fromEntries(
        registeredHarnesses()
          .filter((h) => startingClassesOf(h.id).length > 0)
          .map((h) => [
            h.id,
            startingClassesOf(h.id).map((c) => ({
              ...c,
              ...(Object.prototype.hasOwnProperty.call(settings.startingSet(h.id), c.id) ? { chosen: settings.startingSet(h.id)[c.id] } : {}),
            })),
          ]),
      )
      // the Projects folder: where the next new project is born — `chosen`
      // false is the default (<home>/Silos)
      const pf = ctx.projectsFolder
      const now = pf ? projectsFolderOf(pf.home, settings) : null
      const projectsDir = pf && now !== null ? { path: now, shown: tilde(pf.home, now), chosen: settings.projectsDir() !== null } : undefined
      return { unattendedProvider: id, keepOwnAccount: enginesKeepingOwn(id, inUse(), providers), startingSet, ...(projectsDir ? { projectsDir } : {}) }
    }
    app.get('/api/settings', async (req, reply) => {
      if (req.agentId !== undefined) return reply.code(403).send({ error: `agent ${req.agentId} may not read /api/settings` })
      return view()
    })
    app.patch<{ Body: { unattendedProvider?: unknown; startingSet?: unknown; projectsDir?: unknown } }>('/api/settings', async (req, reply) => {
      if (req.agentId !== undefined) return reply.code(403).send({ error: `agent ${req.agentId} may not change /api/settings — only the owner can` })
      const body = req.body
      const has = (k: string): boolean => body !== null && typeof body === 'object' && k in body
      if (!has('unattendedProvider') && !has('startingSet') && !has('projectsDir'))
        return reply.code(400).send({ error: "unattendedProvider (a provider id, or null for each agent's own account), startingSet or projectsDir required" })
      // the Projects folder: null back to the default, or a folder that
      // passes checkProjectsDir — stored by its real path; it moves nothing
      let projectsDir: string | null | undefined
      if (has('projectsDir')) {
        const raw = body.projectsDir
        if (raw !== null && typeof raw !== 'string') return reply.code(400).send({ error: "projectsDir must be a folder's absolute path, or null for ~/Silos" })
        if (raw === null) projectsDir = null
        else {
          if (!ctx.projectsFolder) return reply.code(400).send({ error: 'this server cannot judge a Projects folder' })
          const v = ctx.projectsFolder.check(raw)
          if (!v.ok) return reply.code(v.conflict ? 409 : 400).send({ error: v.reason })
          projectsDir = v.path
        }
      }
      // both checked before either is written: one PATCH, all or nothing
      const raw = body.unattendedProvider
      if (has('unattendedProvider')) {
        const err = unattendedProviderError(raw, inUse(), providers)
        if (err) return reply.code(400).send({ error: err })
      }
      if (has('startingSet')) {
        const err = startingSetError(body.startingSet)
        if (err) return reply.code(400).send({ error: err })
      }
      if (has('unattendedProvider')) settings.setUnattendedProvider(raw === null ? null : (raw as string).trim())
      if (has('startingSet')) settings.setStartingSet(body.startingSet as Record<string, Record<string, boolean | null>>)
      if (projectsDir !== undefined) settings.setProjectsDir(projectsDir)
      return view()
    })
  }

  // null = not a Claude account (a key has no subscription windows)
  app.get<{ Querystring: { provider?: string } }>('/api/plan-usage', async (req, reply) => {
    if (req.agentId !== undefined) return reply.code(403).send({ error: `agent ${req.agentId} may not read /api/plan-usage` })
    const provider = req.query.provider
    if (typeof provider !== 'string' || provider === '') return reply.code(400).send({ error: 'provider required' })
    return planUsage ? await planUsage.get(provider) : null
  })

  // Providers v1: the provider and Claude account routes — only if
  // both deps were injected (same criterion as automations/resident). ALL
  // behind the global token (the onRequest hook above covers /api/*), and
  // every response with providers goes through maskProvider: the full key
  // only ever comes IN (POST/PATCH), never goes OUT.
  if (providers && accounts) {
    const verifyFetch = ctx.verifyFetch ?? fetch
    // Per-provider 5h window: the last thing ChatService saw on a real
    // turn for that provider; null = an honest "unknown" (an optional
    // call: tests with ChatService fakes don't carry rateLimitOf).
    const windowOf = (providerId: string) => chat.rateLimitOf?.(providerId) ?? null

    app.get('/api/providers', async () => ({
      providers: [
        // Claude accounts derived from disk (default + claude-accounts/) —
        // they don't live in providers.json, see providers-store.ts's header.
        ...(await accounts.list()).map((a) => ({
          id: a.providerId,
          kind: 'claude-account' as const,
          label: a.name === 'default' ? 'Claude (this machine)' : `Claude · ${a.name}`,
          account: a,
          window: windowOf(a.providerId),
        })),
        ...providers.listMasked().map((p) => ({ ...p, window: windowOf(p.id) })),
      ],
    }))

    app.post<{ Body: unknown }>('/api/providers', async (req, reply) => {
      try {
        const input = validateProviderCreate(req.body)
        const before = new Set(providers.list().map((x) => x.id))
        const p = providers.create(input)
        // the same key for the same endpoint comes back as the existing row (200, not a twin)
        return reply.code(before.has(p.id) ? 200 : 201).send({ provider: maskProvider(p) })
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
      }
    })

    app.patch<{ Params: { id: string }; Body: unknown }>('/api/providers/:id', async (req, reply) => {
      if (!providers.get(req.params.id)) return reply.code(404).send({ error: 'provider not found' })
      try {
        const patch = validateProviderPatch(req.body)
        const p = providers.update(req.params.id, patch)
        return { provider: maskProvider(p) }
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
      }
    })

    app.delete<{ Params: { id: string } }>('/api/providers/:id', async (req, reply) => {
      try {
        providers.delete(req.params.id)
        return { ok: true }
      } catch {
        return reply.code(404).send({ error: 'provider not found' })
      }
    })

    // ---- harness logins / export ------------------------
    // Owner-only, explicitly (the agent-bearer allowlist already refuses
    // these paths — belt and braces for routes that touch keys).
    const ownerOnly = (req: { agentId?: string }, reply: FastifyReply): boolean => {
      if (req.agentId === undefined) return true
      void reply.code(403).send({ error: 'only the owner manages providers' })
      return false
    }

    // each harness's own provider routes (Harness.server routes — OpenCode's
    // login list and import: /api/providers/opencode/auth, /api/providers/import-opencode)
    for (const h of registeredHarnesses()) hooks(h.id).routes?.(app, ownerOnly)

    // "Copy config": a provider as an opencode.json fragment, or as the env
    // block a Claude agent would take — NEVER with the key (a placeholder
    // the operator fills in by hand).
    app.get<{ Params: { id: string }; Querystring: { target?: string } }>('/api/providers/:id/export', async (req, reply) => {
      if (!ownerOnly(req, reply)) return reply
      const p = providers.get(req.params.id)
      if (!p) return reply.code(404).send({ error: 'provider not found' })
      // each engine declares its own target (HarnessProviderRules.export),
      // listed non-fallback engines first (registry nonFallbackFirst)
      const targets = nonFallbackFirst(registeredHarnesses()).flatMap((h) => h.providers.export ?? [])
      const target = targets.find((t) => t.target === req.query.target)
      if (!target) return reply.code(400).send({ error: `target must be ${quotedIds(targets.map((t) => t.target))}` })
      const snippet = target.snippet(p)
      // only an engine-owned provider has no form for another engine's target
      if (snippet === null)
        return reply
          .code(400)
          .send({
            error: `this provider is for ${(p.kind === 'harness-provider' || p.kind === 'harness-native' ? [p.harness] : providerOwners(p.kind)).map((id) => harnessById(id).label).join(' or ')} agents`,
          })
      return { snippet }
    })

    // One probe for a gateway key, shared by verify and connect: list the
    // models the key reaches at <root>/v1/models (a pool key only runs its
    // pool's models — a fixed Claude id answered 404 on a
    // gateway), then ONE minimal /v1/messages call (max_tokens 1) with
    // the first listed model, else the caller's, else the long-standing
    // default. Injectable fetch: tests never touch the network. The key is
    // the server's own copy — it never passes through the browser whole.
    type Probe = { ok: true; models: string[]; limits: GatewayModelLimits } | { ok: false; error: string; models: string[]; limits: GatewayModelLimits }
    async function probeGateway(baseUrl: string, apiKey: string, wanted: string | null): Promise<Probe> {
      const listing = wanted === null ? await fetchGatewayModels(verifyFetch, baseUrl, apiKey) : null
      const models = listing?.ids ?? []
      const limits = listing?.limits ?? {}
      const model = wanted ?? models[0] ?? 'claude-3-5-haiku-latest'
      try {
        const res = await verifyFetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            // Bearer — same convention as the injected env (see env.ts:
            // ANTHROPIC_AUTH_TOKEN); compatible proxies expect this.
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
          signal: AbortSignal.timeout(10_000),
        })
        if (res.ok) return { ok: true, models, limits }
        if (res.status === 401 || res.status === 403) return { ok: false, error: `the provider rejected the key (HTTP ${res.status})`, models, limits }
        const body = (await res.text().catch(() => '')).slice(0, 200)
        return { ok: false, error: `the provider responded HTTP ${res.status}${body ? `: ${body}` : ''}`, models, limits }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: `could not contact the provider: ${msg}`, models, limits }
      }
    }

    // What a successful probe leaves on the row: the models, and a name for
    // a row still wearing its bare one (the partner's or the host) — ONE
    // place names rows, so a paste and a Verify agree; a typed name stays.
    const recordProbe = (id: string, baseUrl: string, label: string, models: string[], limits: GatewayModelLimits): void => {
      if (models.length === 0) return
      const named = isBareGatewayLabel(label, baseUrl) ? gatewayAutoLabel(baseUrl, models) : undefined
      providers.update(id, { models, modelLimits: limits, modelsAt: new Date().toISOString(), ...(named !== undefined ? { label: named } : {}) })
    }

    // Server-side verification of a STORED provider (Settings › Verify).
    app.post<{ Params: { id: string }; Body: { model?: unknown } | null }>('/api/providers/:id/verify', async (req, reply) => {
      const p = providers.get(req.params.id)
      if (!p) return reply.code(404).send({ error: 'provider not found' })
      // an engine-owned provider has no endpoint of Silos's to call (its
      // engine knows its catalogue's) — nothing to verify from here
      if (p.kind !== 'anthropic-compatible') {
        const engine = engineProviderLabel(p.harness)
        return reply.code(400).send({ error: `${articleFor(engine)} ${engine} provider is verified by ${engine} itself, not from here` })
      }
      // A baseUrl PATCH invalidates the stored key (see
      // ProvidersStore.update) — verifying with no key makes no sense and
      // must never send anything to the new endpoint.
      if (p.apiKey === '') {
        return reply.code(400).send({ error: 'the provider has no key — baseUrl changed, paste the key again' })
      }
      const wanted = typeof req.body?.model === 'string' && req.body.model !== '' ? req.body.model : null
      const probe = await probeGateway(p.baseUrl, p.apiKey, wanted)
      if (!probe.ok) return { ok: false, error: probe.error }
      recordProbe(p.id, p.baseUrl, p.label, probe.models, probe.limits)
      return { ok: true, ...(probe.models.length > 0 ? { models: probe.models } : {}) }
    })

    // "Connect": verify FIRST, store only what works (if it
    // doesn't work, why keep it?). The same key for the same endpoint is
    // the same row (ProvidersStore.create dedupes) — 200 then, 201 when new.
    // A failure stores nothing and answers with the provider's own words.
    app.post<{ Body: unknown }>('/api/providers/connect', async (req, reply) => {
      if (!ownerOnly(req, reply)) return reply
      let input: ReturnType<typeof validateProviderCreate>
      try {
        input = validateProviderCreate(req.body)
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
      }
      if ((input.kind ?? 'anthropic-compatible') !== 'anthropic-compatible' || input.baseUrl === undefined || input.apiKey === undefined) {
        return reply
          .code(400)
          .send({
            error: `connect takes an Anthropic-compatible endpoint and its key — ${engineProviderLabel(input.harness)} providers are imported or added, not connected`,
          })
      }
      const probe = await probeGateway(input.baseUrl, input.apiKey, null)
      if (!probe.ok) return reply.code(400).send({ error: probe.error })
      const before = new Set(providers.list().map((x) => x.id))
      let p = providers.create(input)
      recordProbe(p.id, input.baseUrl, p.label, probe.models, probe.limits)
      p = providers.get(p.id) ?? p
      return reply.code(before.has(p.id) ? 200 : 201).send({ provider: maskProvider(p), models: probe.models })
    })

    // "Which models does this key reach?" — one GET to the gateway's
    // `<root>/v1/models` with the stored key (never the browser's), the ids
    // persisted on the provider so the model picker lists them for both
    // engines. Best-effort: a gateway without a listing leaves the provider
    // as it was (ok:false + the list it already had), the key still works.
    app.post<{ Params: { id: string } }>('/api/providers/:id/models', async (req, reply) => {
      if (!ownerOnly(req, reply)) return reply
      const p = providers.get(req.params.id)
      if (!p) return reply.code(404).send({ error: 'provider not found' })
      if (p.kind !== 'anthropic-compatible') {
        const engine = engineProviderLabel(p.harness)
        return reply
          .code(400)
          .send({ error: `${articleFor(engine)} ${engine} provider lists its models through ${engine} (GET /api/models?harness=${p.harness})` })
      }
      if (p.apiKey === '') return reply.code(400).send({ error: 'the provider has no key — baseUrl changed, paste the key again' })
      const had = p.models ?? []
      const listing = await fetchGatewayModels(verifyFetch, p.baseUrl, p.apiKey)
      if (listing === null) return { ok: false, models: had, error: 'the provider listed no models at /v1/models' }
      recordProbe(p.id, p.baseUrl, p.label, listing.ids, listing.limits)
      return { ok: true, models: listing.ids }
    })

    // Re-read every key's listing now (the refresher does it at boot and on
    // a timer — this is the owner's "refresh" in Settings).
    app.post('/api/providers/refresh-models', async (req, reply) => {
      if (!ownerOnly(req, reply)) return reply
      if (!gatewayModels) return { refreshed: [] }
      const outcomes = await gatewayModels.refreshAll()
      return { refreshed: outcomes.map((o) => ({ id: o.id, label: o.label, changed: o.changed, models: o.models })) }
    })

    app.get('/api/accounts', async () => ({
      accounts: (await accounts.list()).map((a) => ({ ...a, window: windowOf(a.providerId) })),
    }))

    // "Connect another account": creates the directory and returns the
    // command to log in with — run in the owner's terminal, or in the
    // sign-in terminal below. Never a claude.ai login of Silos's own
    // (Anthropic policy): the sign-in is always the claude binary's.
    app.post<{ Body: { name?: unknown } | null }>('/api/accounts', async (req, reply) => {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
      if (name === '') return reply.code(400).send({ error: 'name required' })
      try {
        return reply.code(201).send(accounts.create(name))
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
      }
    })

    // Sign in to an account from the UI: Claude's own `claude auth login`
    // in a terminal (TerminalService.openAccountLogin), streamed on the
    // usual /ws/terminal/:id. The owner clicks Claude's link and pastes
    // Claude's code INTO THAT TERMINAL; the browser then polls verify.
    // The machine's account signs in here only while it is signed OUT —
    // the first run's «Sign in to Claude ›» on a
    // machine that never logged in; a login it already has is never
    // replaced from the UI (that stays its own terminal's act).
    app.post<{ Params: { name: string } }>('/api/accounts/:name/login', async (req, reply) => {
      try {
        const account = await accounts.verify(req.params.name)
        if (account.configDir === null && account.loggedIn)
          return reply.code(409).send({ error: "this machine's account is signed in already — to change it, sign in again from its own terminal" })
        return reply.code(201).send({ terminal: terminals.openAccountLogin({ account: account.name, configDir: account.configDir }), account })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.code(/not found/.test(msg) ? 404 : 400).send({ error: msg })
      }
    })

    app.post<{ Params: { name: string } }>('/api/accounts/:name/verify', async (req, reply) => {
      try {
        const account = await accounts.verify(req.params.name)
        return { account: { ...account, window: windowOf(account.providerId) } }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.code(msg.includes('not found') ? 404 : 400).send({ error: msg })
      }
    })
  }
}
