// harnesses/claude-code — the Claude Code harness object: label, caps and
// the console through the contract. The rest of the engine lives beside it
// in this folder (reader.ts is the index's fallback reader, headless.ts the
// SDK chat turn, console.ts the console's argv). command() returns claude's
// argv WITHOUT the per-console hooks (rotation, context news) and the append
// FILE: TerminalService.ensureConsole builds those from its own paths and
// calls console.ts defaultConsoleCommand itself (no `command` override), so
// this command() serves the conformance suite and symmetry with OpenCode.
// Start with docs/harnesses.md.

import { CLAUDE_SCOPES } from './loads/places.js'
import type { Harness, LaunchSpec } from '../contract.js'
import type { ChatDeps } from '../../chat-service.js'
import { CLAUDE_CONSOLE_ENV, defaultConsoleCommand } from './console.js'
import { claudeDialogOnScreen } from './dialogs.js'
import { CLAUDE_CMD, claudeInstallDirs } from './binary.js'
import { claudeFencePermission } from './fence.js'
import { claudeProjectStores } from './stores.js'
import { claudeExportSnippet } from './export.js'
import { CLAUDE_UPDATE_LABEL, claudeVersions } from './version.js'
import { ClaudeHeadless, claudeEngine, type ClaudeHeadlessDeps } from './headless.js'
import { join } from 'node:path'
import { ClaudeReader } from './reader.js'
import { fetchModelsWithSdk } from './models.js'
import { claudeServerHooks } from './server-hooks.js'
import { agentProcessEnv } from '../../agent-env.js'
import { readClaudeLoadedAtStart } from './loaded-at-start.js'
import { claudeInstructions, claudeInstructionsReading, readClaudeInstruction } from './instructions.js'
import { claudeInstructionPlaces, claudeInstructionSwitch } from './instruction-places.js'
import { claudeLoadsInventory } from './loads/inventory.js'
import { CHECK_COST, claudeLoadsCheck, claudeSends } from './loads/check.js'
import { claudeLoadsOriginSwitch, claudeLoadsSwitchMany, claudeLoadsSwitch } from './loads/switch.js'
import { claudeStartingSet } from './loads/starting-set.js'
import { claudeMachineHeads, claudeMachineHeadSwitch } from './loads/heads.js'
import { userSettingsChangedAt } from './loads/machine.js'
import { localSettingsChangedAt } from './local-settings.js'
import { claudePersonalPlaces, claudePersonalState, claudePersonalSwitch } from './personal-instructions.js'
import { ClaudePluginProjection, PROJECTED_BY } from './loads/projected.js'
import { claudeLoadsSkills, claudeSkillPlaces, claudeSkillSwitch, claudeSkillSwitchMany } from './loads/skills.js'
import { TranscriptStartedWith } from './started-with.js'
import { listClaudeOutputStyles } from './output-styles.js'
import { CLAUDE_ENGINE_HOSTS } from './network.js'

// A LIVE view of ChatDeps, never a copy: each field is read at the
// moment the turn uses it, exactly as `this.deps.x` was before the move
// (tests swap `deps.queryFn` on a built ChatService between turns).
function liveView(deps: Readonly<ChatDeps>): ClaudeHeadlessDeps {
  const live = (): Readonly<ChatDeps> => deps
  return {
    get native() {
      return live().native
    },
    get queryFn() {
      return live().queryFn
    },
    get lineage() {
      return live().lineage
    },
    get convPrefs() {
      return live().convPrefs
    },
    get catalog() {
      return live().catalog
    },
    get territory() {
      return live().territory
    },
    get vault() {
      return live().vault
    },
    get registry() {
      return live().registry
    },
    get messageReads() {
      return live().messageReads
    },
    get loadsCarried() {
      return live().loadsCarried
    },
    get loginDirs() {
      return live().loginDirs
    },
    get dataDir() {
      return live().dataDir
    },
    agentStateEnv: (agentId) => agentStateEnv(live(), agentId),
    processEnv: (agent, cwd, key, turn) =>
      agentProcessEnv({ vault: live().vault, agentState: { envFor: (id) => agentStateEnv(live(), id) }, silosApi: live().silosApi }, agent, cwd, key, turn),
  }
}

// SILOS_AGENT_STATE for the turn, or nothing. envFor() rejects an id that
// isn't a single safe path segment (a hand-edited agents.json is the only
// way to get one) — losing the state channel degrades that agent's
// autonomy, aborting the turn would take its chat down with it.
function agentStateEnv(deps: Readonly<ChatDeps>, agentId: string): Record<string, string> {
  try {
    return deps.agentState?.envFor(agentId) ?? {}
  } catch (err) {
    console.warn(`chat-service: no agent-state dir for ${agentId}:`, err)
    return {}
  }
}

// one projection per process: one `claude plugin details` at a time, its
// figures kept per plugin version (loads/projected.ts)
const projection = new ClaudePluginProjection()

export const claudeCode: Harness = {
  id: 'claude-code',
  label: 'Claude Code',
  // owns every id no other harness claims; an agent with no framework runs here
  fallback: true,
  fencePermission: (fence) => claudeFencePermission(fence),
  // the project MCP servers every conversation of the folder starts
  // (S2); the home layer (~/.claude/{skills,commands,…}) is
  // fenced per config dir in territory.ts CLAUDE_CONFIG_DENIED, accounts included
  configFiles: (folder) => [`${folder.replace(/\/+$/, '')}/.mcp.json`],
  // what it could load from a folder above a project (instructions.ts walks
  // the instruction files and rules up to the first folder below `/`,
  // measured on 2.1.331); settings, skills, commands, agents and .mcp.json
  // in an ancestor are unmeasured — listed so no agent writes them. At the
  // home folder `.claude/` is the user layer (territory.ts CLAUDE_CONFIG_DENIED)
  loadedFromAbove: (dir, home) => {
    const d = dir.replace(/\/+$/, '') || '/'
    const files = [`${d}/CLAUDE.md`, `${d}/CLAUDE.local.md`, `${d}/AGENTS.md`, `${d}/.mcp.json`]
    if (d === (home.replace(/\/+$/, '') || '/')) return files
    return [
      ...files,
      `${d}/.claude/CLAUDE.md`,
      `${d}/.claude/rules/**`,
      `${d}/.claude/settings*.json`,
      `${d}/.claude/skills/**`,
      `${d}/.claude/commands/**`,
      `${d}/.claude/agents/**`,
    ]
  },
  // its config dir (an extra account's sits under Silos' data dir)
  ownDirs: (home) => [join(home, '.claude')],
  // a folder's transcripts, scratch space and memory (stores.ts): closed to
  // the agents of every other project
  projectStores: (folder, ctx) => claudeProjectStores(folder, ctx),
  // what it calls itself (network.ts): pinned in an egress allowlist
  engineHosts: CLAUDE_ENGINE_HOSTS,
  traits: {
    deletion: 'trash',
    // console ⇄ chat on a started conversation: the chat turn
    // appends through the SDK's resume after the console is closed
    handover: true,
    consolePinsModel: false,
    // `claude [--resume <id>] "<prompt>"`: the task's briefing rides as the
    // first prompt (console.ts consoleCommand)
    consoleBriefing: true,
    agentStateDirs: [],
    // the machine's enabled plugins load in every session (their skills
    // as <plugin>:<skill>); Silos' own skills ride as folder copies
    skillLoad: { claudePlugins: true },
    askTool: 'AskUserQuestion',
    // disallowedTools + strictMcpConfig with no servers (headless.ts
    // unattendedSdkOptions): documented Agent SDK options
    heartbeatBlocks: { web: true, connectors: true, subagents: true },
    // Claude Code sets it in every shell its tools start (verified on Linux
    // in /proc/<pid>/environ; the claude process itself does not carry
    // it) — the System silo's attribution (silos/processes.ts)
    sessionEnvKeys: ['CLAUDE_CODE_SESSION_ID'],
  },
  providers: {
    // a Claude account never runs on another engine (Anthropic restricts
    // subscription OAuth to Claude Code); an engine-owned provider never reaches Claude
    kinds: ['claude-account', 'anthropic-compatible'],
    export: { target: 'claude', snippet: claudeExportSnippet },
  },
  ui: {
    contextPercent: true,
    models: 'catalog',
    ownLogin: false,
    territoryFenced: false,
    territoryNote: null,
    settingsAbout: null,
    loginImport: null,
    providerExport: { target: 'claude', label: 'for Claude' },
    // its Settings › Engines section is the fixed one (the fallback's rows);
    // no engine-provider section (no harness-provider kind)
    updateLabel: CLAUDE_UPDATE_LABEL,
    consoleColours: false,
    consoleColoursHint: null,
    providersAbout: null,
    providerIdPlaceholder: null,
    loginCommand: null,
  },
  // the SDK's supportedModels() (the long-standing file)
  models: { file: 'model-catalog.json', label: 'the SDK' },
  // the one claude (consoles and chats), the Agent SDK library and its pairing, npm's latest; `claude update`
  versions: claudeVersions,
  binary: { command: () => CLAUDE_CMD, installDirs: claudeInstallDirs },
  // the index's fallback reader (the transcripts under root), the SDK's model
  // catalogue, and the transcript watcher once the server is built
  boot: (ctx) => {
    // watcher.ts (chokidar) is loaded here, not imported by this module: the
    // registration list must not evaluate chokidar, or a test's
    // vi.mock('chokidar') would meet the real module already cached
    // (claude-code-watcher-error.test.ts). The root awaits Booted.ready().
    let start: typeof import('./watcher.js').startWatcher | undefined
    const ready = import('./watcher.js').then((m) => {
      start = m.startWatcher
    })
    return {
      reader: new ClaudeReader(ctx.root, join(ctx.dataDir, 'cache', 'sessions.json'), ctx.muted, ctx.ephemeral, join(ctx.dataDir, 'trash')),
      ...(ctx.modelCatalog ? { modelFetcher: fetchModelsWithSdk() } : {}),
      versionOptions: {},
      ready,
      afterServer: (s) => {
        if (!start) throw new Error('claude-code: the transcript watcher is not loaded yet — await Booted.ready() before afterServer()')
        const watcher = start(s.root, s.index, s.muted, s.ephemeral)
        return { stop: () => watcher.close() }
      },
    }
  },
  // the SDK's query() turn (headless.ts), over ChatService's deps read live
  headless: (ctx) => claudeEngine(new ClaudeHeadless(liveView(ctx.deps), ctx.hooks)),
  // its branches of the console and prefs routes (server-hooks.ts); answer
  // and send-to-console are server.ts's neutral defaults
  server: claudeServerHooks,
  loadedAtStart: (input) => readClaudeLoadedAtStart(input),
  // every instruction file a conversation in a folder loads, judged for
  // Silos' writes (instructions.ts; the record reader instructions-record.ts)
  instructions: {
    list: claudeInstructions,
    read: readClaudeInstruction,
    places: claudeInstructionPlaces,
    switch: claudeInstructionSwitch,
    reading: claudeInstructionsReading,
  },
  // everything a conversation in a folder loads, one row per thing (loads/inventory.ts);
  // «Check now» and «See what it sends» (loads/check.ts); the item switches (loads/switch.ts);
  // the account's skills and each skill's position (loads/skills.ts)
  loads: {
    inventory: (input) => claudeLoadsInventory(input),
    readsStatus: true,
    // the places a choice is kept at, broadest first (loads/places.ts)
    scopes: CLAUDE_SCOPES,
    switch: (input, key, to, at) => claudeLoadsSwitch(input, key, to, at),
    // the account groups' heads at each place: plugins, skills and connectors your Claude account sends
    switchOrigin: (input, origin, to, at) => claudeLoadsOriginSwitch(input, origin, to, at),
    switchMany: (input, set, to, at) => claudeLoadsSwitchMany(input, set, to, at),
    // the heads for this whole machine, outside any folder (loads/heads.ts)
    machineHeads: (input) => claudeMachineHeads(input),
    switchMachineHead: (input, origin, to, confirmed) => claudeMachineHeadSwitch(input, origin, to, confirmed),
    // what a reading must be newer than to prove a switch (switch-proof.ts)
    switchesChangedAt: (folder) => localSettingsChangedAt(folder),
    // and the machine's: the user file the machine line writes
    machineChangedAt: (home) => userSettingsChangedAt(home),
    check: (input, deps) => claudeLoadsCheck(input, deps),
    checkCost: CHECK_COST,
    sends: (input) => claudeSends(input),
    // a plugin row this project does not load, opened: `claude plugin details`' one figure (loads/projected.ts)
    projected: (input) => projection.estimate(input),
    projectedBy: PROJECTED_BY,
    // the account's skills and the three positions per skill (loads/skills.ts)
    skills: (input) => claudeLoadsSkills(input),
    skillSwitch: (input, target, to, at) => claudeSkillSwitch(input, target, to, at),
    skillSwitchMany: (input, items, at) => claudeSkillSwitchMany(input, items, at),
    // «Where it loads» per skill: machine · project · each agent (loads/skill-places.ts)
    skillPlaces: (input, asks) => claudeSkillPlaces(input, asks),
    // what a new project starts with: the account's classes, set once at its birth (loads/starting-set.ts)
    startingSet: claudeStartingSet,
  },
  // your personal CLAUDE.md and rules off for one project (claudeMdExcludes)
  personal: {
    state: (input) => claudePersonalState(input),
    switch: (input, to, at) => claudePersonalSwitch(input, to, at),
    places: (input) => claudePersonalPlaces(input),
  },
  // what one conversation started with, from its own transcript's head
  startedWith: () => new TranscriptStartedWith(),
  caps: {
    compaction: true,
    subagents: true,
    skills: true,
    thinking: true,
    costFromHarness: false,
    permissionsAsEvents: false,
    sendToConsole: false,
    // the cockpit's outputStyle: `outputStyle` + the style plugins off, in
    // the SDK's settings and the console's one --settings (output-styles.ts)
    outputStyles: true,
    // memory per agent: every launch points auto memory at the agent's dir
    agentAutoMemory: true,
  },
  outputStyles: (cwd) => listClaudeOutputStyles(cwd),
  console: {
    // a new console is born with the id Silos picks (`--session-id <key>`)
    idDiscovery: 'silos-chosen',
    command(spec: LaunchSpec): string[] {
      return defaultConsoleCommand({
        ...(spec.resumeId ? { resumeId: spec.resumeId } : { sessionId: spec.key }),
        ...(spec.permissionMode ? { permissionMode: spec.permissionMode } : {}),
        ...(spec.theme ? { theme: spec.theme } : {}),
        ...(spec.fence ? { fence: spec.fence } : {}),
        ...(spec.rolePlugin ? { rolePluginDir: spec.rolePlugin } : {}),
        ...(spec.outputStyle ? { outputStyle: spec.outputStyle } : {}),
        ...(spec.carried && spec.carried.length > 0 ? { carried: spec.carried } : {}),
      })
    },
    // see the CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN note in ensureConsole
    env(): Record<string, string> {
      return { ...CLAUDE_CONSOLE_ENV }
    },
    // trust / permission / question / plan dialogs (dialogs.ts)
    dialogOnScreen: claudeDialogOnScreen,
  },
}
