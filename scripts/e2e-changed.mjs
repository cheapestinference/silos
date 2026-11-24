#!/usr/bin/env node
// e2e-changed.mjs — the e2e specs of what a branch touched, before it merges.
//
// Why: two changes reached main the same day breaking the e2e of the
// very surfaces they touched — nobody runs the whole suite (8 min, and it
// loads the machine) for a small change. This runs the specs of the ZONES the
// change touches: a minute or two.
//
//   npm run e2e:changed            what differs from main (commits + working tree)
//   npm run e2e:changed -- --list  only say which specs, run nothing
//   npm run e2e:changed -- <base>  against another base
//
// A zone is a set of paths and the specs that exercise them. A changed file
// under server/src or web/src that no zone names runs EVERYTHING — the map
// never hides a spec by omission; add the path to a zone instead.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const ZONES = [
  {
    name: 'tasks',
    paths: [
      /^server\/src\/(silos\/(task-flow|turn|plans|executions)|task-|task-mode\/|tasks|owner-notes|own-turns)/,
      /^web\/src\/(components\/tasks\/|components\/PlanView|lib\/(tasks|team-plan|task-|executions?\.)|hooks\/useTasks)/,
      /^plugin\/.*team-plan/,
    ],
    specs: [
      'tasks',
      'task-feed',
      'task-keyboard',
      'task-link',
      'task-mode',
      'task-navigation',
      'new-task',
      'give',
      'answer-gesture',
      'task-fit',
      'plans-silo',
      'executions',
    ],
  },
  {
    name: 'live-and-home',
    paths: [
      /^server\/src\/(work-live|board|inbox|conversation-live|digest|heartbeat|doorbell)/,
      /^web\/src\/lib\/digest\./,
      /^web\/src\/(components\/BackgroundPage|lib\/sidebar-show)/,
      /^web\/src\/(lib\/(live|home|inbox|vitals)|components\/home\/)/,
    ],
    specs: [
      'home-board-views',
      'inbox',
      'digest',
      'task-fit',
      'subagents',
      'proactive',
      'first-run',
      'plans-silo',
      'task-navigation',
      'task-keyboard',
      'silo-settings',
      'silo',
      'usage',
    ],
  },
  // the board's one widget: Home, an agent's Now, the silos, the automations
  { name: 'tiles', paths: [/^web\/src\/components\/Tile\./], specs: ['home-board-views', 'inbox', 'dossier', 'silo', 'automation-editor'] },
  {
    name: 'transcripts',
    paths: [
      /^server\/src\/(harnesses\/|session-index|session-owner|routes\/sessions|terminal|chat-service|overview-cap|session-counts)/,
      /^web\/src\/lib\/conversation-refs\./,
    ],
    specs: [
      'home-board-views',
      'subagents',
      'chat-switch',
      'plan-mode',
      'inter-session',
      'multimedia',
      'conversation-refs',
      'context-viewer',
      'executions',
      'tasks',
    ],
  },
  {
    name: 'silos',
    paths: [
      /^server\/src\/silos\/(?!task-flow|turn|plans|executions)/,
      /^server\/src\/routes\/silos\.ts$/,
      /^web\/src\/components\/silo\//,
      /^web\/src\/lib\/silo-/,
      /^docs\/standard\//,
    ],
    specs: ['silo', 'silo-install', 'silo-settings', 'plans-silo', 'hierarchy'],
  },
  {
    name: 'automations',
    paths: [
      /^server\/src\/(resident|automation|routes\/(automation|heartbeat|proposals)|proposals|skill-accept)/,
      /^web\/src\/(components\/(Automation|automation\/)|lib\/automations)/,
    ],
    specs: ['automation-editor', 'templates', 'proactive', 'mission', 'inbox'],
  },
  {
    name: 'map',
    paths: [/^server\/src\/(routes\/map|uses)/, /^web\/src\/(components\/(MapPage|UsesView)|lib\/(map-views|uses|org)\.)/],
    specs: ['uses', 'hierarchy', 'nav-menu'],
  },
  {
    name: 'vault',
    paths: [/^server\/src\/vault/, /^web\/src\/(components\/Vault|lib\/vault)/, /^web\/src\/components\/agent\/VaultZone/],
    specs: ['vault', 'binding-ask'],
  },
  {
    name: 'settings-and-accounts',
    paths: [
      /^server\/src\/(accounts|providers|fallback|server-env|session-tokens|silos-id|territory|routes\/providers\.ts$)/,
      /^web\/src\/components\/(SettingsPage|settings\/|SkillsInventory|ProviderPanel|ProvidersTab|RunOn|AuthGate|LoginView|FenceScope)/,
      /^web\/src\/lib\/auth\.ts$/,
    ],
    specs: ['providers', 'selectors', 'sign-in', 'first-run', 'silo-settings'],
  },
  // the first run: Welcome's tour and the words of an agent's birth
  {
    name: 'first-run',
    paths: [
      /^web\/src\/(components\/(Welcome|welcome\/|ClaudeSignIn|EngineSignIn|AgentModal|NewProjectModal|agent\/(FirstMeeting|GiveContext))|lib\/(first-run|new-agent|birth|first-meeting|starting-set)\.)/,
      /^server\/src\/(starting-set|platform-settings|birth-project|project-folder)\.ts$/,
    ],
    specs: ['first-run', 'providers'],
  },
  // the machine's vitals: the sampler, GET /api/system and System's page
  { name: 'system', paths: [/^server\/src\/(machine-sampler|routes\/system)\.ts$/, /^web\/src\/(components\/system\/|lib\/vitals\.ts$)/], specs: ['system'] },
  {
    name: 'usage',
    paths: [/^server\/src\/(usage|model-prices|vitals|fleet-events|routes\/vitals)/, /^web\/src\/(components\/Usage|lib\/usage)/],
    specs: ['usage'],
  },
  {
    name: 'navigation',
    paths: [
      /^web\/src\/(lib\/routes|store\/|components\/(Sidebar|SessionDot|CommandPalette|PageHeader|HeaderTabs|SystemTabs|FilesPage|FacetBar|App)|lib\/system-house)/,
      /^web\/src\/(App|main|theme)\./,
      /^web\/src\/lib\/(dark-mode|look|themes|theme-contrast)\./,
    ],
    specs: ['routing', 'nav-menu', 'layout', 'facets', 'task-navigation', 'dossier', 'tasks'],
  },
  {
    name: 'agent-page',
    paths: [
      /^web\/src\/components\/(agent\/|AgentPage|ProjectPage|knows\/|ArtifactsBlock|RolePack)/,
      /^web\/src\/(lib\/agent-tabs|lib\/owners|lib\/origin-filter|lib\/owner-caption|hooks\/useNewMessages)\.ts$/,
      /^web\/src\/components\/(OwnerFilter|OwnerLabel)\.tsx$/,
      /^web\/src\/lib\/(project-reach|loaded-at-start|loads-view|loads-places|here-tools|loads-weight|loads-check-view|memory-rows)\.ts$/,
      /^server\/src\/(memory-service|folder-instructions|routes\/files\.ts$|knows|skill-states|role-pack|role-plugin|agent-tools|artifacts|plugin-enablement|folder-loads|folder-personal|folder-instruction-places|picomatch\.d\.ts$|loads-check|loads-scopes|loads-bulk|conversation-places|tool-health|start-health|switch-proof|harnesses\/claude-code\/(loads\/|local-settings|personal-instructions|instruction-places|instructions)|harnesses\/opencode\/(loads|launch-entries|global-config)\.ts$|routes\/agents\.ts$|control\.ts$|routes\/skills\.ts$|complete-service\.ts$|routes\/workspace\.ts$|routes\/role-packs\.ts$|context-(service|news)\.ts$)/,
    ],
    specs: ['dossier', 'mission', 'knows-drawer', 'artifacts', 'role-pack', 'proactive', 'vault'],
  },
  // routes/console.ts: the console's routes and, beside them, the task routes
  // (/api/tasks/{mode,feed,talk,claim,release,link,act,new,ask,assign,work},
  // /api/task-mode) and the escalation window (/api/escalation — Map Org's
  // escalation-panel)
  // the messages store and its routes: Needs you (needs_owner), the board's
  // inbox counts, the agent page's Messages tab (inbox + Sent)
  {
    name: 'messages',
    paths: [/^server\/src\/(messages|message-reads|routes\/messages)\.ts$/, /^web\/src\/lib\/messages-view\.ts$/],
    specs: ['inbox', 'inter-session', 'dossier', 'home-board-views'],
  },
  {
    name: 'console-and-task-routes',
    paths: [/^server\/src\/routes\/console\.ts$/],
    specs: ['tasks', 'task-feed', 'task-keyboard', 'task-link', 'task-mode', 'task-navigation', 'new-task', 'give', 'answer-gesture', 'task-fit', 'hierarchy'],
  },
  {
    name: 'conversation',
    paths: [
      /^web\/src\/components\/(Composer|Cockpit|Transcript|ContextColumn|FileViewer|StartedWith|StatusLine|PlanProposal)/,
      /^server\/src\/context-(service|news)\.ts$/,
      /^server\/src\/routes\/files\.ts$/,
    ],
    specs: [
      'selectors',
      'autocomplete',
      'auto-resume',
      'chat-switch',
      'context-viewer',
      'knows-drawer',
      'artifacts',
      'multimedia',
      'plan-mode',
      'subagents',
      'dossier',
    ],
  },
]
// what every spec stands on. server.ts, index.ts and web/src/lib/api.ts are
// here ON PURPOSE, not forgotten: they wire every route and every call the
// web makes — no zone is smaller than the whole suite for them.
// agent-registry.ts too: every spec's agents are its own.
// seals.ts too: it sits under every write to a sealed control file (agents,
// automations, proposals, vault, territory…) and no spec owns its rows.
const EVERYTHING = [
  /^web\/e2e\/(helpers|global|fixtures)/,
  /^web\/playwright\.config/,
  /^server\/src\/(server|index|config|env|seals|seal-regimes|agent-registry)\.ts$/,
  /^web\/src\/lib\/api\.ts$/,
  /^package(-lock)?\.json$/,
  /^web\/(package\.json|vite\.config|tailwind\.config)/,
]

// type-only files: erased by the build, they change no page by themselves —
// the code that uses a changed type is under its own zone and brings its specs
const TYPES_ONLY = [/^web\/src\/lib\/types\.ts$/]

const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const base = args.find((a) => !a.startsWith('--')) ?? 'main'
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
const changed = [
  ...new Set([
    ...git('diff', '--name-only', `${base}...HEAD`),
    ...git('diff', '--name-only', 'HEAD'),
    ...git('ls-files', '--others', '--exclude-standard', 'web/e2e', 'web/src', 'server/src'),
  ]),
]

const specs = new Set()
const unmapped = []
let all = false
for (const f of changed) {
  const own = /^web\/e2e\/([\w-]+)\.spec\.ts$/.exec(f)
  if (own) {
    specs.add(own[1])
    continue
  }
  if (EVERYTHING.some((r) => r.test(f))) {
    all = true
    unmapped.push(f)
    continue
  }
  if (TYPES_ONLY.some((r) => r.test(f))) continue
  const hit = ZONES.filter((z) => z.paths.some((r) => r.test(f)))
  if (hit.length > 0) {
    for (const z of hit) for (const s of z.specs) specs.add(s)
    continue
  }
  // code no zone names: the whole suite, said — never a silent skip
  if (/^(server|web)\/src\//.test(f)) {
    all = true
    unmapped.push(f)
  }
}

if (changed.length === 0) {
  console.log(`e2e:changed — nothing differs from ${base}`)
  process.exit(0)
}
const files = all
  ? []
  : [...specs]
      .sort()
      .map((s) => `e2e/${s}.spec.ts`)
      .filter((p) => existsSync(join(root, 'web', p)))
if (all)
  console.log(
    `e2e:changed — the WHOLE suite: ${unmapped.slice(0, 5).join(', ')}${unmapped.length > 5 ? ` and ${unmapped.length - 5} more` : ''} ${unmapped.length === 1 ? 'is' : 'are'} in no zone (scripts/e2e-changed.mjs)`,
  )
else if (files.length === 0) {
  console.log(`e2e:changed — ${changed.length} files changed, none of them under a surface with e2e`)
  process.exit(0)
} else console.log(`e2e:changed — ${files.length} specs for ${changed.length} changed files:\n  ${files.join('\n  ')}`)
if (listOnly) process.exit(0)

const run = (cmd, a) => spawnSync(cmd, a, { cwd: join(root, 'web'), stdio: 'inherit' }).status ?? 1
if (run('npm', ['run', 'build:e2e']) !== 0) process.exit(1)
process.exit(run('npx', ['playwright', 'test', ...files]))
