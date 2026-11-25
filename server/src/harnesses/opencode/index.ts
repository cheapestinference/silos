// harnesses/opencode — an OpenCode agent's console, described through the
// harness contract: the OpenCode TUI on a fixed loopback port (its HTTP API
// is how Silos sends it text — Task 13), in Silos' tmux like Claude's.
//
// OpenCode mints its own session id, so a new console is launched under a
// Silos console key (SILOS_CONSOLE_KEY) and the plugin reports the id it
// got (registrar.ts seals it). A resume names the id (`--session`).
//
// env(spec): the route (server.ts POST /api/console) puts the per-process
// pieces in spec.env — OPENCODE_DB, OPENCODE_CONFIG_CONTENT, SILOS_API,
// SILOS_PROVIDER_KEY (the provider's key, when its kind carries one — the
// config names it as {env:SILOS_PROVIDER_KEY}), OPENCODE_SERVER_PASSWORD (its HTTP server's basic auth, always), and
// SILOS_ASKS_REPLIES (the plugin's Silos-owned reply dir, asks-store.ts),
// the agent's own env (Vault + agent state: SILOS_AGENT_ID…). This turns
// them into launch.ts envFor(...) + TERM, adding the console key — never
// SILOS_SESSION_ID, even on a resume: the process env is the parent the
// plugin gives every session born in it (silos.ts birthRecord), so a `/new`
// in a resumed console would be born as the old conversation's CHILD and
// the registrar would refuse to bind it to the console.
// Each shell gets its calling session's id from the plugin's shell.env;
// only a headless resume carries it (headless.ts). A fenced agent (spec.fence) gets
// OPENCODE_DISABLE_PROJECT_CONFIG=1 (launch.ts). Everything here rides the console's env FILE
// (terminal-service writeEnvFile), never argv: the config can be large and
// the Vault is secret.

import type { Harness, HarnessBootContext, HarnessRuntime, LaunchSpec } from '../contract.js'
import { opencodeBin, opencodeInstallDirs } from './bin.js'
import { fenceToPermission } from './fence.js'
import { opencodeRefToPin } from './pin.js'
import { PROVIDER_KEY_ENV, defaultSkillsPath, envFor, exportSnippet } from './launch.js'
import { opencodeLoadsPersonalSkills } from './assemble.js'
import { OPENCODE_UPDATE_LABEL, opencodeVersions } from './version.js'
import { opencodeInstructions, readOpencodeInstruction } from './instructions.js'
import { readOpencodeLoadedAtStart } from './loaded-at-start.js'
import { OPENCODE_SCOPES, opencodeLoadsInventory, opencodeLoadsSwitch } from './loads.js'
import { OpenCodeHeadless, opencodeEngine, type OpenCodeHeadlessDeps, type OpenCodeHeadlessOptions } from './headless.js'
import type { ChatDeps } from '../../chat-service.js'
import { existsSync } from 'node:fs'
import { mungePath } from '../../agent-registry.js'
import { defaultRun } from '../../harness-run.js'
import { OpenCodeReader } from './reader.js'
import { globalDbPath, opencodeDataDir } from './paths.js'
import { authFilePath } from './auth-file.js'
import { ConsoleRegistrar, pinModelInto, pinProviderInto } from './registrar.js'
import { fetchOpenCodeModels } from './models.js'
import { OpencodeVersionProbe } from './tui-auth.js'
import { opencodeServerHooks, type OpenCodeServerOptions } from './server-hooks.js'
import { OPENCODE_ENGINE_HOSTS } from './network.js'

// The ChatDeps an OpenCode turn shares with Claude's (the stores the
// composition root used to hand OpenCodeHeadless itself).
function fromDeps(
  d: Readonly<ChatDeps>,
): Pick<
  OpenCodeHeadlessDeps,
  'registry' | 'agentState' | 'native' | 'dataDir' | 'convPrefs' | 'lineage' | 'vault' | 'territory' | 'messageReads' | 'loadsCarried'
> {
  if (d.agentState === undefined || d.dataDir === undefined) throw new Error('opencode chat engine: ChatDeps.agentState and dataDir are required')
  return {
    registry: d.registry,
    agentState: d.agentState,
    native: d.native,
    dataDir: d.dataDir,
    ...(d.convPrefs ? { convPrefs: d.convPrefs } : {}),
    ...(d.lineage ? { lineage: d.lineage } : {}),
    ...(d.vault ? { vault: d.vault } : {}),
    ...(d.territory ? { territory: d.territory } : {}),
    ...(d.messageReads ? { messageReads: d.messageReads } : {}),
    ...(d.loadsCarried ? { loadsCarried: d.loadsCarried } : {}),
  }
}

// OpenCode's runtime, moved verbatim from the composition root: the reader,
// the `opencode --version` probe, the chat engine's options, the console
// registrar (before buildServer) and its rehydrate (once the index is warm).
function bootOpencode(ctx: HarnessBootContext): HarnessRuntime {
  // OpenCode sessions (each agent's own DB + the operator's global one) flow
  // through the same index; a missing DB is simply an empty list.
  const opencodeDb = globalDbPath(ctx.home)
  const opencodeReader = new OpenCodeReader({
    dataDir: ctx.dataDir,
    registry: ctx.registry,
    globalDb: existsSync(opencodeDb) ? opencodeDb : null,
    muted: ctx.muted,
    ephemeralPrefix: ctx.ephemeral,
    asks: ctx.asks,
  })
  // `opencode --version`, once (cached) — see tui-auth.ts.
  const opencodeVersion = new OpencodeVersionProbe()
  // The chat engine for OpenCode agents (`opencode run --format json`): its
  // runtime pieces; ChatService builds it through the harness's headless
  // factory (the role prompt is the chat engine's own append, the same one the
  // agent's console gets, and the provider its cascade). The factory leaves
  // the engine on `engine` (sealPending, below).
  const opencodeHeadlessOptions: OpenCodeHeadlessOptions = {
    binary: opencodeBin(),
    home: ctx.home,
    silosApi: ctx.silosApi ?? `http://127.0.0.1:${ctx.port}`,
    agentOfDb: (id) => opencodeReader.agentOfDb(id),
    isContested: (id) => opencodeReader.isContested(id),
  }
  let consoleRegistrar: ConsoleRegistrar | undefined
  return {
    reader: opencodeReader,
    // A session in an agent's OWN opencode.db is that agent's (reader.ts agentOfDb).
    ownership: { agentOfDb: (id) => opencodeReader.agentOfDb(id), isContested: (id) => opencodeReader.isContested(id) },
    // `opencode models` when cache/models-opencode.json is missing (model-catalog.ts)
    ...(ctx.modelCatalog ? { modelFetcher: () => fetchOpenCodeModels(defaultRun, opencodeBin()) } : {}),
    // the Settings row reads the SAME probe (and invalidates it on upgrade).
    versionOptions: { cmd: opencodeBin(), probe: { version: () => opencodeVersion.version(), invalidate: () => opencodeVersion.invalidate() } },
    headlessOptions: opencodeHeadlessOptions,
    beforeServer: (s) => {
      // OpenCode consoles mint their own session id; the plugin reports it in a
      // birth marker and the registrar seals it (native record + key ↔ id
      // binding) — swept when the reader sees a new session, and every 5 s while
      // any console is live (the marker may land before the DB row, or after).
      // A seal pins the console's account pick on the conversation (never over
      // a pin already there).
      const registrar = new ConsoleRegistrar({
        births: s.births,
        native: s.native,
        terminals: s.terminals,
        mungePath,
        agentOfDb: (id) => opencodeReader.agentOfDb(id),
        isContested: (id) => opencodeReader.isContested(id),
        pinProvider: pinProviderInto(s.convPrefs),
        pinModel: pinModelInto(s.convPrefs),
      })
      consoleRegistrar = registrar
      // a session a headless run announced is registered once the reader sees it
      // in the agent's own DB (headless.ts sealPending)
      const sweepQuietly = (): void => {
        registrar.sweep().catch((err: unknown) => console.warn('opencode registrar: sweep failed —', err instanceof Error ? err.message : err))
      }
      opencodeReader.watch((_ref, kind) => {
        if (kind === 'created') {
          sweepQuietly()
          opencodeHeadlessOptions.engine?.sealPending()
        }
      })
      // async tmux listing; a tick that finds the last one still running skips
      let ticking = false
      setInterval(() => {
        if (ticking) return
        ticking = true
        void s.terminals
          .listConsoles()
          .then((c) => (c.length > 0 ? registrar.sweep() : 0))
          .catch(() => 0)
          .finally(() => {
            ticking = false
          })
      }, 5_000).unref()
      // what the server's OpenCode routes read (ServerDeps.engines)
      const serverOptions: OpenCodeServerOptions = {
        agentOfDb: (id) => opencodeReader.agentOfDb(id),
        isContested: (id) => opencodeReader.isContested(id),
        // the asks that still wait (a question whose tool call ended is gone)
        pendingAsks: (id) => opencodeReader.pendingAsks(id),
        registrar,
      }
      return { serverOptions }
    },
    onIndexReady: () => {
      if (!consoleRegistrar) return
      // OpenCode consoles that outlived the last server: rebind key ↔ id and
      // their launch agents from native.json + markers + the agent DBs (the
      // reader is warm now) — registrar.ts rehydrate()
      consoleRegistrar.rehydrate().then(
        (rebound) => {
          if (rebound > 0) console.log(`opencode consoles rebound after restart: ${rebound}`)
        },
        (err: unknown) => console.warn('opencode registrar: rehydrate failed —', err instanceof Error ? err.message : err),
      )
    },
  }
}

// ServerDeps.engines.opencode: what the server's OpenCode routes read (server-hooks.ts)
export type { OpenCodeServerOptions } from './server-hooks.js'

export const opencode: Harness = {
  id: 'opencode',
  label: 'OpenCode',
  /** OpenCode session ids are `ses_…`; every other id is the fallback's. */
  ownsId: (id: string): boolean => id.startsWith('ses_'),
  // what the launch writes into its config (fence.ts)
  fencePermission: (fence, opts) => fenceToPermission(fence, { worktree: opts.worktree, home: opts.home }),
  // the operator's login keys (auth-file.ts): every agent's fence denies them
  secretFiles: (home) => [authFilePath(home)],
  // its global config dir and its data dir (logins, the machine's database)
  ownDirs: (home) => [`${process.env.XDG_CONFIG_HOME || `${home.replace(/\/+$/, '')}/.config`}/opencode`, opencodeDataDir(home)],
  // what OpenCode loads behaviour from, with no approval gate: the project config and dir, and the global config
  configFiles: (folder, home) => {
    const f = folder.replace(/\/+$/, ''),
      h = home.replace(/\/+$/, '')
    return [`${f}/opencode.json`, `${f}/opencode.jsonc`, `${f}/.opencode/**`, `${h}/.config/opencode/**`]
  },
  // what it could load from a folder above a project: the instruction files
  // it walks up to the nearest .git, else `/` (launch.ts projectInstructions,
  // worktree.ts); its config and dir upward to the same stop are unmeasured
  // — listed so no agent writes them
  loadedFromAbove: (dir) => {
    const d = dir.replace(/\/+$/, '') || '/'
    return [`${d}/AGENTS.md`, `${d}/CLAUDE.md`, `${d}/CONTEXT.md`, `${d}/opencode.json`, `${d}/opencode.jsonc`, `${d}/.opencode/**`]
  },
  // the machine's one database (a hand-launched OpenCode's, every folder's
  // conversations in it): not kept per folder, so it is every folder's store
  // and closed to every agent that has another project. The agents Silos
  // launches keep their own database under the data dir (paths.ts
  // agentDbPath), already closed with it.
  projectStores: (_folder, { home }) => {
    const db = globalDbPath(home)
    return [{ path: db, deny: [db, `${db}-*`] }]
  },
  // what it calls itself (network.ts): pinned in an egress allowlist
  engineHosts: OPENCODE_ENGINE_HOSTS,
  // a model picked in the TUI (/models) as a Silos pin (pin.ts; pin-follower.ts)
  requestedModelPin: opencodeRefToPin,
  traits: {
    deletion: 'hide',
    handover: true,
    consolePinsModel: true,
    agentStateDirs: ['opencode'],
    // Claude Code plugins never load here; Silos' skills arrive through the
    // config's skills.paths (assemble.ts); the operator's ~/.claude/skills
    // load too unless OpenCode's own env switches say otherwise
    skillLoad: { claudePlugins: false, personal: opencodeLoadsPersonalSkills(), roots: [{ plugin: 'silos', dir: defaultSkillsPath() }] },
    // OpenCode's own question tool (its AskUserQuestion — asks-store.ts)
    askTool: 'question',
    // web off by config (launch.ts HEARTBEAT_*); MCP can't be switched off
    // per process without knowing the operator's server names (OPEN 3);
    // `task` verified blocked by the real smoke on opencode 1.19.4
    // (scripts/opencode-heartbeat-smoke.sh)
    heartbeatBlocks: { web: true, connectors: false, subagents: true },
    // no sessionEnvKeys: OpenCode sets no session variable of its own — Silos'
    // plugin gives each shell SILOS_SESSION_ID = the calling session
    // (plugin-opencode shell.env), which the System silo reads already
  },
  providers: {
    kinds: ['anthropic-compatible', 'harness-provider', 'harness-native'],
    export: { target: 'opencode', snippet: exportSnippet },
  },
  ui: {
    contextPercent: false,
    models: 'provider-model',
    ownLogin: true,
    territoryFenced: true,
    territoryNote: "On OpenCode a fenced agent runs without the project's own opencode.json (Silos passes the project instructions itself).",
    settingsAbout: 'The other engine agents can run on. Its logins stay in OpenCode — Silos reads one only when you import it in Accounts & providers.',
    loginImport: { list: '/api/providers/opencode/auth', import: '/api/providers/import-opencode' },
    signIn: { path: '/api/providers/opencode/sign-in' },
    providerExport: { target: 'opencode', label: 'for OpenCode' },
    updateLabel: OPENCODE_UPDATE_LABEL,
    consoleColours: true,
    consoleColoursHint: 'change it with /theme inside the console',
    providersAbout:
      'For agents that run on OpenCode: a key for a provider OpenCode already knows — MiniMax, Z.ai, Kimi — handed to each agent on its own, or OpenCode’s own login.',
    providerIdPlaceholder: 'provider id (zai, minimax-coding-plan…)',
    loginCommand: 'opencode auth login',
    // its role file is one per agent and it has no per-prompt hook: a file
    // given to one conversation is never announced to it
    givenFilesNote: 'An OpenCode conversation is not told of files given to it — name the file in your message.',
  },
  // `opencode models`
  models: { file: 'cache/models-opencode.json', label: 'opencode models' },
  // its row in Settings (through the shared probe); `opencode upgrade`
  versions: opencodeVersions,
  binary: { command: opencodeBin, installDirs: opencodeInstallDirs },
  // its runtime: reader, probes, chat options, console registrar (bootOpencode above)
  boot: bootOpencode,
  // its branches of the console, send, answer, prefs and models routes,
  // and its login routes (server-hooks.ts)
  server: opencodeServerHooks,
  loadedAtStart: (input) => readOpencodeLoadedAtStart(input),
  // what its launch passes, read-only (instructions.ts)
  instructions: { list: opencodeInstructions, read: readOpencodeInstruction },
  // the inventory and its places (loads.ts, spec scopes §9): this machine
  // (the global file, global-config.ts), this project, each agent and one
  // conversation (carried in the launch's config, launch-entries.ts) — no
  // status reading, no check, no proof
  loads: {
    inventory: (input) => opencodeLoadsInventory(input),
    scopes: OPENCODE_SCOPES,
    switch: (input, key, to, at) => opencodeLoadsSwitch(input, key, to, at),
  },
  // `opencode run --format json` (headless.ts), only when the root hands its
  // runtime options. The role prompt is the chat engine's own append (the
  // same one the agent's console gets) and the provider its cascade.
  headless: (ctx) => {
    if (!ctx.options) return null
    const options = ctx.options as OpenCodeHeadlessOptions
    const { engine: _engine, ...runtime } = options
    void _engine
    const d = ctx.deps
    const h = new OpenCodeHeadless({
      ...runtime,
      ...fromDeps(d),
      // ChatService.systemAppendFor: registry get → archived → appendFor
      systemAppendFor: (id, has) => {
        const agent = d.registry.get(id)
        if (!agent || agent.archived) return null
        return ctx.hooks.appendFor(agent, has)
      },
      // the Claude engine's provider cascade (pin › agent's own, fallback applied)
      providerFor: (agent, pinned, turnId) => ctx.hooks.providerFor(agent, pinned, turnId).provider,
    })
    options.engine = h
    return opencodeEngine(h, ctx.hooks)
  },
  caps: {
    compaction: true,
    // no auto memory: the launch injects the agent's memory.md instead
    agentAutoMemory: false,
    subagents: true,
    skills: false,
    thinking: true,
    costFromHarness: true,
    permissionsAsEvents: true,
    sendToConsole: true,
    // OpenCode has no output style: the field is never offered nor sent
    outputStyles: false,
  },
  console: {
    idDiscovery: 'reported-by-plugin',
    command(spec: LaunchSpec): string[] {
      if (spec.port === undefined) throw new Error('opencode console: no port')
      return [
        opencodeBin(),
        '--port',
        String(spec.port),
        '--hostname',
        '127.0.0.1',
        ...(spec.modeArgs ?? []),
        ...(spec.resumeId ? ['--session', spec.resumeId] : []),
        ...(spec.model ? ['--model', spec.model] : []),
      ]
    },
    env(spec: LaunchSpec): Record<string, string> {
      const {
        OPENCODE_DB: agentDb,
        OPENCODE_CONFIG_CONTENT: configContent,
        SILOS_API: silosApi,
        OPENCODE_SERVER_PASSWORD: serverPassword,
        [PROVIDER_KEY_ENV]: providerKey,
        SILOS_ASKS_REPLIES: asksReplies,
        OPENCODE_TUI_CONFIG: tuiConfig,
        ...agentStateEnv
      } = spec.env
      if (!agentDb || configContent === undefined || !silosApi)
        throw new Error('opencode console: OPENCODE_DB, OPENCODE_CONFIG_CONTENT and SILOS_API are required in spec.env')
      return {
        ...envFor({
          agentId: spec.agent.id,
          agentDb,
          consoleKey: spec.key,
          silosApi,
          agentStateEnv,
          configContent,
          fenced: spec.fence !== null,
          ...(serverPassword ? { serverPassword } : {}),
          ...(providerKey ? { providerKey } : {}),
          ...(asksReplies ? { asksReplies } : {}),
        }),
        TERM: 'xterm-256color',
        // the browser's xterm renders 24-bit and tmux passes it (terminal-service
        // terminal-features RGB): the TUI's colours arrive exact, not rounded
        // to the 256 cube (console-theme.ts)
        COLORTERM: 'truecolor',
        // Silos' tui config (console-theme.ts: theme `system`), when the console follows Silos
        ...(tuiConfig ? { OPENCODE_TUI_CONFIG: tuiConfig } : {}),
      }
    },
  },
}
