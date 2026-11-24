// harnesses/opencode/server-hooks.ts — OpenCode's branches of the server's
// routes (Harness.server), moved verbatim from server.ts: the console open
// (the registrar sweep, reattach/relaunch of a session, the waiting console
// of a new conversation), the TUI's own HTTP way in for send-to-console,
// the permission-ask answer, the live model push, the models narrowing and
// the two login routes. server.ts keeps the shared preamble of each route
// and calls these through harnessForId / harnessOf.

import { randomBytes, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { Agent } from '../../types.js'
import type { HarnessServerHooks, LaunchSpec, RouteResult, ServerHookContext, ConsoleOpenInput } from '../contract.js'
import { harnesses, harnessOf } from '../registry.js'
import { mungePath } from '../../agent-registry.js'
import { maskProvider } from '../../providers-store.js'
import { validateLoginImport } from '../../providers-validate.js'
import { filterByProviders } from '../../model-catalog.js'
import { PROVIDER_ID_RE } from '../../providers-store.js'
import { OpencodeSignIns } from './sign-in.js'
import { readAuthIds, readAuthKey } from './auth-file.js'
import { allocatePort } from './ports.js'
import { appendAndSubmit, openModelPicker, settleModelOnScreen, splitModelRef, TuiSendError, waitForSession } from './tui-client.js'
import { modeArgs } from './auto-mode.js'
import { assembleOpencode } from './assemble.js'
import { providerLaunch } from './launch.js'
import { consoleSkinFor, writeSilosTuiConfig } from './console-theme.js'
import type { AskReply, PendingAsk } from '../../asks-store.js'
import { defaultSilosApi } from '../../agent-env.js'

/** ServerDeps.engines.opencode: what the server's OpenCode routes read. */
export interface OpenCodeServerOptions {
  agentOfDb(sessionId: string): string | null
  isContested(sessionId: string): boolean
  /** A session's asks that still wait (reader.ts pendingAsks). */
  pendingAsks(sessionId: string): PendingAsk[]
  registrar: { sweep(): Promise<number> }
}

/** What the hooks read from ctx.options: the runtime's server options, each
 *  optional (a test hands only what it exercises — no `agentOfDb`: no
 *  session is resumed in a console), plus two test seams:
 *  `tuiFetch`, the HTTP client the hooks reach a TUI with (default global
 *  fetch), and `tuiSettleDelayMs`, how long the launch waits for the TUI's
 *  own restore before settling the model on screen (production: 1.5 s). */
export type OpenCodeServerHookOptions = Partial<OpenCodeServerOptions> & { tuiFetch?: typeof fetch; tuiSettleDelayMs?: number }

export function opencodeServerHooks(ctx: ServerHookContext): HarnessServerHooks {
  const deps = ctx.deps
  const oc = ctx.options as OpenCodeServerHookOptions | undefined
  const { index, registry, chat, prefs, vault, agentState, territory, asks, providers, convPrefs } = deps
  const { terminals, freshConsoles, classifyAgentId } = ctx.helpers

  // An OpenCode agent's console (harnesses/opencode): the TUI on a fixed
  // loopback port, in the same tmux and through the same env-file
  // launcher as Claude's. Its context file (briefing + fleet roster — what
  // Claude gets at SessionStart) and role prompt (the same append as
  // Claude's console) are written as files and listed in `instructions`;
  // the fence becomes OpenCode permissions relative to the worktree
  // OpenCode itself computes. Everything per process rides the env FILE:
  // OPENCODE_CONFIG_CONTENT can be large and the Vault is secret — never
  // argv, never `-e`. The operator's opencode.json and global DB are
  // never touched (own OPENCODE_DB per agent). Provider: the same cascade
  // as a Claude console (an explicit pick › the conversation's pin › the
  // agent's own, fallback applied — ChatService.consoleProviderFor); model:
  // the conversation's › the agent's. Both become config, the key
  // SILOS_PROVIDER_KEY in the env file (assemble.ts).
  // `recordPick`: a NEW console's explicit account pick — its session id
  // is OpenCode's to mint, so the pick waits in the console record until
  // the registrar seals the id and pins it on the conversation.
  const openOpencodeConsole = async (
    input: ConsoleOpenInput,
    agent: Agent,
    cwd: string,
    key: string,
    resumeId?: string,
    recordPick?: string,
    recordModel?: string,
  ): Promise<{ key: string; theme: 'light' | 'dark' }> => {
    const { theme, pick } = input
    if (!agentState || !deps.dataDir) throw new Error('an OpenCode console needs the agent-state and data dirs')
    const provider = chat.consoleProviderFor?.(agent.id, cwd, resumeId, pick || undefined) ?? null
    const convModel = resumeId && convPrefs ? convPrefs.get(mungePath(cwd), resumeId)?.model : undefined
    // the cockpit's permission mode (conversation › agent default: bypass),
    // the same cascade a Claude console honours
    const permissionMode = chat.consolePermissionMode?.(cwd, resumeId)
    // the cockpit's permission mode in OpenCode's argv (auto-mode.ts
    // modeArgs): bypass is `--auto`, plan is the plan agent; acceptEdits
    // passes nothing (OpenCode's defaults stand)
    const mode = modeArgs(permissionMode)
    const assembled = assembleOpencode(
      {
        agents: () => registry.list(),
        agentState,
        dataDir: deps.dataDir,
        home: deps.home ?? homedir(),
        silosApi: deps.silosApi ?? defaultSilosApi(),
        ...(vault ? { vault } : {}),
        ...(territory ? { territory } : {}),
        systemAppendFor: (id, has) => chat.systemAppendFor?.(id, has) ?? null,
        // an attended launch: composing its context IS serving
        inboxFor: (id) => chat.inboxFor?.(id, 'attended') ?? '',
      },
      agent,
      cwd,
      {
        provider,
        model: convModel ?? recordModel ?? agent.model ?? null,
        // what Silos keeps for this launch's places (loads-scopes.ts): the
        // folder's, then the agent's — read at the console's start
        carried: registry.get(agent.id) ? (deps.loadsCarried?.(agent.id, cwd) ?? []) : [],
      },
    )
    const fence = assembled.fence
    const port = await allocatePort()
    // the TUI's HTTP server answers only Silos (basic auth; Task 13 reads it
    // from the console record) — never the other agents on this machine.
    const serverPassword = randomBytes(24).toString('base64url')
    // the console's colours follow Silos' light/dark unless the owner chose
    // OpenCode's own (console-theme.ts): theme `system`, the pane styled
    // with Silos' console colours for the birth theme and Silos' palette
    // answered to the TUI (console-palette.ts)
    const followsSilos = prefs.consoleThemeOf('opencode') === 'silos'
    const spec: LaunchSpec = {
      agent,
      cwd,
      key,
      ...(resumeId ? { resumeId } : {}),
      ...(theme ? { theme } : {}),
      fence,
      provider,
      port,
      ...(permissionMode ? { permissionMode } : {}),
      ...(mode.length > 0 ? { modeArgs: mode } : {}),
      // the pinned (or the gateway's first) model as `--model`: a resumed
      // session would otherwise keep the model it last ran on
      ...(assembled.model ? { model: assembled.model } : {}),
      // vault first, platform plumbing after (assemble.ts)
      env: {
        ...assembled.env,
        ...(serverPassword ? { OPENCODE_SERVER_PASSWORD: serverPassword } : {}),
        ...(followsSilos ? { OPENCODE_TUI_CONFIG: writeSilosTuiConfig(deps.dataDir, deps.home ?? homedir()) } : {}),
      },
    }
    const h = harnesses.opencode!
    // no resumeId to ensureConsole: its "previous claude still running"
    // guard reads Claude's lock files, which an OpenCode id never has
    const launching = !(await terminals.hasConsole(key))
    const opened = await terminals.ensureConsole({
      cwd,
      key,
      agentId: agent.id,
      command: h.console.command(spec),
      baseEnv: { TERM: 'xterm-256color' },
      extraEnv: h.console.env(spec),
      port,
      harness: 'opencode',
      serverPassword,
      ...(recordPick ? { providerPick: recordPick } : {}),
      ...(recordModel ? { modelPick: recordModel } : {}),
      ...(theme ? { theme } : {}),
      ...(followsSilos ? { skin: consoleSkinFor(theme === 'light' ? 'light' : 'dark') } : {}),
    })
    // a RESUMED session restores its last user message's model when the
    // TUI opens it — `--model` names a NEW session's only (prompt/index.tsx,
    // verified 1.19.4) — but it also puts the pin first in the TUI's
    // recent list, so once the TUI is up and has restored, Silos cycles that
    // list until the SCREEN reads the pin (tui-client settleModelOnScreen).
    // If the screen never shows it, the TUI's own model picker opens as the
    // honest fallback. Best effort, one line on failure.
    if (launching && resumeId && assembled.model) {
      const ref = splitModelRef(assembled.model)
      if (ref) {
        const password = serverPassword
        const fetchOpt = oc?.tuiFetch ? { fetchImpl: oc.tuiFetch } : {}
        void (async () => {
          await waitForSession({ port, password, sessionId: resumeId, ...fetchOpt })
          await new Promise((r) => setTimeout(r, oc?.tuiSettleDelayMs ?? 1_500)) // the TUI's own restore lands first
          const r = await settleModelOnScreen({
            port,
            password,
            providerID: ref.providerID,
            modelID: ref.modelID,
            screen: () => terminals.consoleScreen(key),
            ...fetchOpt,
          })
          if (r !== 'settled') {
            await openModelPicker({ port, password, ...fetchOpt })
            console.warn(`opencode console ${key}: the TUI did not reach ${assembled.model} (${r}) — its model picker is open instead`)
          }
        })().catch((err: unknown) =>
          console.warn(`opencode console ${key}: could not settle the model ${assembled.model} — ${err instanceof Error ? err.message : String(err)}`),
        )
      }
    }
    return opened
  }

  // The provider ids whose models an OpenCode process can run with a given
  // Silos provider: a harness-* → its providerId; anthropic-compatible →
  // `silos-<id>` (Silos injects it per process); the default (no Silos
  // provider) → every login in OpenCode's auth.json + the free `opencode`
  // tier. A Claude account reaches nothing on OpenCode.
  const opencodeReach = (providerId: string | undefined, into: Set<string>): void => {
    const p = providers?.resolve(providerId)
    if (!p) return
    if (p.kind === 'harness-provider' || p.kind === 'harness-native') into.add(p.providerId)
    else if (p.kind === 'anthropic-compatible') into.add(`silos-${p.id}`)
    else if (p.id === 'default') {
      for (const id of readAuthIds(deps.home ?? homedir())) into.add(id)
      into.add('opencode')
    }
  }

  return {
    // An OpenCode session whose console was born moments ago may not be
    // sealed yet (the registrar sweeps every 5 s): unsealed, its startup
    // marker reads as a nested run (409 below) and no binding names its
    // console (a second `--session` process). Seal first — the real
    // sweep, with all its proofs — then decide.
    beforeOpen: async () => {
      await oc?.registrar?.sweep()
    },

    // An OpenCode session: reattach to the live console it is bound to
    // (a console born for a new conversation, sealed by the registrar,
    // or one resumed under the id itself); else relaunch it with
    // `--session <id>` — a slept console wakes this way — under the id
    // as its key (durable: the registrar rebinds it after a restart),
    // bound at once. Only in the agent whose own DB holds it: OPENCODE_DB
    // must be where the session lives, and a contested id has no owner.
    openSession: async (id, meta, input): Promise<RouteResult> => {
      const { pinPicks } = input
      const live = terminals.keyOfNativeId(id) ?? ((await terminals.hasConsole(id)) ? id : null)
      const reattached = live ? await terminals.reattachConsole(live) : null
      if (reattached) return { code: 201, body: reattached }
      const owner = oc?.agentOfDb && !oc.isContested?.(id) ? oc.agentOfDb(id) : null
      const ocAgent = owner ? registry.get(owner) : null
      if (!ocAgent || ocAgent.archived || harnessOf(ocAgent) !== 'opencode')
        return { code: 400, body: { error: "not in an OpenCode agent's own database — cannot open its console" } }
      if (!meta || meta.cwd === null) return { code: 400, body: { error: 'session has no cwd — cannot open console' } }
      pinPicks(meta.cwd, id)
      const opened = await openOpencodeConsole(input, ocAgent, meta.cwd, id, id)
      terminals.bindNativeId(id, id)
      return { code: 201, body: opened }
    },

    // An OpenCode agent: its console is born under a Silos key (OpenCode
    // mints the session id; the plugin reports it and the registrar
    // seals it — no native record here). The waiting console is reused
    // while it is not bound to a session yet (nothing typed).
    openNew: async (agent, input): Promise<RouteResult> => {
      const { pick, modelPick } = input
      const agentId = agent.id
      const waitingKey = freshConsoles.get(agentId)
      const waiting =
        waitingKey && terminals.nativeIdOf(waitingKey) === null && terminals.consoleAgent(waitingKey) === agentId
          ? await terminals.reattachConsole(waitingKey)
          : null
      if (waiting) {
        // the account and model picked now are the ones its conversation keeps
        if (pick && waitingKey) terminals.setConsoleProviderPick(waitingKey, pick)
        if (modelPick && waitingKey) terminals.setConsoleModelPick(waitingKey, modelPick)
        return { code: 201, body: waiting }
      }
      const opened = await openOpencodeConsole(input, agent, agent.folder, randomUUID(), undefined, pick || undefined, modelPick || undefined)
      freshConsoles.set(agentId, opened.key)
      return { code: 201, body: opened }
    },

    // An OpenCode console (its Silos-owned record says so) is a TUI with
    // its own loopback HTTP server: append-prompt then submit-prompt,
    // basic auth from the record. A failure there is a 502 and NEVER falls
    // back to keystrokes — a half-typed prompt in the TUI is worse than none.
    sendText: async (key, rec, text): Promise<RouteResult> => {
      const password = rec.serverPassword || undefined
      if (!rec.port || password === undefined) return { code: 502, body: { error: 'this OpenCode console has no API port or password on record — reopen it' } }
      try {
        await appendAndSubmit({ port: rec.port, password, text, ...(oc?.tuiFetch ? { fetchImpl: oc.tuiFetch } : {}) })
      } catch (e) {
        return { code: 502, body: { error: e instanceof TuiSendError ? e.message : 'the OpenCode console did not take the prompt' } }
      }
      return { code: 200, body: { ok: true, key, via: 'tui' as const } }
    },

    // An OpenCode session's open question is an ask its plugin wrote — a
    // permission (the column shows pendingOf()'s Allow/Deny) or a question
    // of OpenCode's `question` tool (its own options): answered through the
    // reply file the plugin polls, NEVER as a digit typed into the TUI. The
    // ask is the newest one its own agent wrote that still waits — the
    // reader's rule (asksOf + pendingOf). A question takes the picked
    // option (`opt`, one question) or the form's `answers` (one label list
    // per question).
    answer: (meta, id, opt, answers): RouteResult => {
      const agentId = oc?.agentOfDb?.(id) ?? classifyAgentId(meta)
      const waiting = oc?.pendingAsks ? oc.pendingAsks(id) : asks ? asks.forSession(id) : []
      const ask = agentId ? [...waiting].filter((a) => a.agentId === agentId).sort((a, b) => b.askedAt.localeCompare(a.askedAt))[0] : undefined
      if (!agentId || !ask || !asks) return { code: 404, body: { error: 'no pending ask for this session' } }
      let status: AskReply
      if (ask.type === 'question') {
        const qs = ask.questions ?? []
        if (answers !== undefined) status = { answers }
        else {
          const label = qs[0]?.options[opt]?.label
          if (qs.length !== 1 || label === undefined)
            return { code: 400, body: { error: qs.length !== 1 ? 'this question has several parts — answer them all at once' : 'no such option' } }
          status = { answers: [[label]] }
        }
      } else {
        if (answers !== undefined || opt > 1) return { code: 400, body: { error: 'an OpenCode permission takes index 0 (allow) or 1 (deny)' } }
        status = opt === 0 ? 'allow' : 'deny'
      }
      const result = asks.reply(agentId, id, ask.id, status)
      if (result === 'missing') return { code: 404, body: { error: 'no such ask — already answered or gone' } }
      if (result === 'answered') return { code: 409, body: { error: 'already answered' } }
      if (result === 'invalid') return { code: 400, body: { error: 'invalid ask' } }
      // engine 'ask': answered through the reply file. Only `engine: 'chat'`
      // ever lets the caller send the label as a turn (ContextColumn).
      return { code: 200, body: { engine: 'ask' as const, ok: true } }
    },

    //  · OpenCode: the TUI keeps its OWN selection, and neither the
    //    session's model through its server nor `--model` on a resume
    //    changes it (the TUI restores the last user message's model when
    //    it opens a session — prompt/index.tsx, verified 1.19.4).
    //    What the TUI does honour is its own gesture: cycling its recent
    //    models, which Silos drives through /tui/publish and VERIFIES on
    //    the console's screen (tui-client settleModelOnScreen). Reached →
    //    'live'. Not reachable in this process (a model never used here)
    //    → 'restart': the panel relaunches with `--model`, which puts the
    //    pin first in the recent list, and the launch settles it the same
    //    way. No console: the next launch takes the pin ('next-turn').
    //    If the console has to restart for the pin to take effect, it does.
    pushPin: async (id, key, _patch, prefs) => {
      let applied: 'live' | 'restart' | 'next-turn' | null = 'next-turn'
      if (key) {
        applied = 'restart'
        const rec = terminals.consoleRecord(key)
        const agentId = (() => {
          const m = index.allSessions().find((x) => x.id === id)
          return m ? classifyAgentId(m) : null
        })()
        const resolved = providers
          ? (providers.resolve(prefs.provider) ?? (agentId ? providers.resolveForAgent(agentId, registry.get(agentId)?.provider) : null))
          : null
        const ref = (() => {
          try {
            const l = providerLaunch(resolved, prefs.model ?? registry.get(agentId ?? '')?.model ?? null)
            return l.model ? splitModelRef(l.model) : null
          } catch {
            return null
          }
        })()
        // in place only what the screen already shows: cycling a running
        // process's recent list from an unknown position trips over
        // entries its providers do not hold (each refused with a toast)
        // — the relaunch puts the pin first and settles it from there
        if (ref && rec?.harness === 'opencode' && rec.port && rec.serverPassword) {
          try {
            const r = await settleModelOnScreen({
              port: rec.port,
              password: rec.serverPassword,
              providerID: ref.providerID,
              modelID: ref.modelID,
              screen: () => terminals.consoleScreen(key),
              maxSteps: 0,
              ...(oc?.tuiFetch ? { fetchImpl: oc.tuiFetch } : {}),
            })
            if (r === 'settled') applied = 'live'
          } catch {
            /* the console did not answer: a relaunch is the honest route */
          }
        }
      }
      return applied
    },

    // optionally narrowed to the providers one agent (`agentId`: its provider
    // + fallback) or one provider (`provider`) can reach — see opencodeReach.
    narrowModels: (view, { agentId, provider }) => {
      if (provider) {
        if (!providers?.resolve(provider)) return { code: 400, body: { error: `unknown provider: ${provider}` } }
        const reach = new Set<string>()
        opencodeReach(provider, reach)
        return filterByProviders(view, reach)
      }
      if (agentId) {
        const agent = registry.get(agentId)
        if (!agent) return { code: 404, body: { error: 'agent not found' } }
        const reach = new Set<string>()
        for (const id of [agent.provider, ...(agent.fallback ?? [])]) opencodeReach(id, reach)
        return filterByProviders(view, reach)
      }
      return view
    },

    // ---- OpenCode import ----------------------------------
    // The operator's OpenCode logins (auth.json, READ ONLY — never written):
    // ids out, a key only on an explicit import, straight into the store.
    // Registered with the providers routes (only when a ProvidersStore is wired).
    routes: (app, ownerOnly) => {
      if (!providers) return
      const ocHome = deps.home ?? homedir()

      // ---- OpenCode's own sign-in (sign-in.ts) -------------------
      // a provider OpenCode signs in to by link (ChatGPT Plus/Pro today);
      // once it lands, the passthrough provider that agents pick
      const nativeRow = (providerId: string) =>
        providers.list().find((p) => p.kind === 'harness-native' && p.harness === 'opencode' && p.providerId === providerId) ?? null
      const signIns = new OpencodeSignIns(ocHome, (providerId, name) => {
        if (!nativeRow(providerId)) providers.create({ kind: 'harness-native', label: name, harness: 'opencode', providerId })
      })
      app.get('/api/providers/opencode/sign-in', async (req, reply) => {
        if (!ownerOnly(req, reply)) return reply
        try {
          return { options: await signIns.list() }
        } catch (err) {
          return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) })
        }
      })
      app.post<{ Body: { providerId?: unknown } | null }>('/api/providers/opencode/sign-in', async (req, reply) => {
        if (!ownerOnly(req, reply)) return reply
        const providerId = req.body?.providerId
        if (typeof providerId !== 'string' || !PROVIDER_ID_RE.test(providerId)) return reply.code(400).send({ error: 'providerId is required' })
        try {
          return reply.code(201).send(await signIns.start(providerId))
        } catch (err) {
          return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) })
        }
      })
      app.get<{ Params: { id: string } }>('/api/providers/opencode/sign-in/:id', async (req, reply) => {
        if (!ownerOnly(req, reply)) return reply
        const st = signIns.status(req.params.id)
        if (!st) return reply.code(404).send({ error: 'no such sign-in — start again' })
        const row = st.state === 'done' ? nativeRow(st.providerId) : null
        return { ...st, ...(row ? { provider: row.id } : {}) }
      })
      app.delete<{ Params: { id: string } }>('/api/providers/opencode/sign-in/:id', async (req, reply) => {
        if (!ownerOnly(req, reply)) return reply
        signIns.cancel(req.params.id)
        return { ok: true }
      })

      app.get('/api/providers/opencode/auth', async (req, reply) => {
        if (!ownerOnly(req, reply)) return reply
        return { ids: readAuthIds(ocHome) }
      })

      app.post<{ Body: unknown }>('/api/providers/import-opencode', async (req, reply) => {
        if (!ownerOnly(req, reply)) return reply
        let input: { providerId: string; label: string }
        try {
          input = validateLoginImport(req.body, 'opencode')
        } catch (err) {
          return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
        }
        if (providers.list().some((p) => (p.kind === 'harness-provider' || p.kind === 'harness-native') && p.providerId === input.providerId)) {
          return reply.code(409).send({ error: `a provider for ${input.providerId} already exists` })
        }
        const found = readAuthKey(ocHome, input.providerId)
        if (!found.ok && found.reason === 'missing') return reply.code(404).send({ error: `OpenCode has no login for ${input.providerId}` })
        if (!found.ok)
          return reply.code(400).send({ error: `OpenCode's login for ${input.providerId} is not an API key — use it as a login from OpenCode instead` })
        try {
          const p = providers.create({ kind: 'harness-provider', label: input.label, harness: 'opencode', providerId: input.providerId, apiKey: found.key })
          return reply.code(201).send({ provider: maskProvider(p) })
        } catch (err) {
          return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
        }
      })
    },
  }
}
