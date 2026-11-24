// inherited-env.ts — what an engine runs on is Silos's decision (a provider:
// an account's config dir, a key), never the environment of whatever shell
// happened to start Silos. Started from inside a Claude Code session, the
// server inherited CLAUDE_CONFIG_DIR (another account), empty ANTHROPIC_*
// and that session's CLAUDE_CODE_* — and every turn on the "default" account
// (config dir = inherit) ran on the OTHER subscription for a day, unseen.
// So at boot those variables leave process.env, before any
// engine is spawned (SDK turns, OpenCode, consoles all inherit it); the
// names are logged, never the values.
const EXACT = new Set(['CLAUDE_CONFIG_DIR', 'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT'])
const PREFIXES = ['CLAUDE_CODE_', 'ANTHROPIC_']

export function isInheritedEngineVar(name: string): boolean {
  return EXACT.has(name) || PREFIXES.some((p) => name.startsWith(p))
}

/** Removes them from `env` (process.env by default); returns their names. */
export function scrubInheritedEngineEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed = Object.keys(env).filter(isInheritedEngineVar).sort()
  for (const name of removed) delete env[name]
  return removed
}

// The same rule for the DEV RUN that started Silos:
// `npm run dev` hands its child npm's own plumbing — ~20 `npm_*` variables
// (npm_config_local_prefix = Silos' repo, npm_package_name = @silos/server…),
// INIT_CWD, NODE and COLOR — and a PATH that starts with every
// `node_modules/.bin` from Silos' workspace up to `/` plus npm's node-gyp-bin.
// Every agent process (console, SDK turn, automation, OpenCode) inherited
// them: `tsc`/`vitest`/`vite` run bare in an agent's project resolved to
// SILOS' copies, and a server restarted from a console stacked the entries
// again on each chained restart (83 of them, live). An agent gets the
// user's own PATH, deduplicated, and none of npm's run variables.
// NODE and COLOR are set by npm's run too, but plausible as a user's own
// names: they only go when the environment shows npm's run (an `npm_`).
const NPM_RUN_WITH_EVIDENCE = ['NODE', 'COLOR']

/** The names npm's run left in `env`, sorted. */
export function devRunVars(env: Record<string, string | undefined>): string[] {
  const npm = Object.keys(env).filter((k) => k.startsWith('npm_'))
  const names = [...npm, ...('INIT_CWD' in env ? ['INIT_CWD'] : [])]
  if (npm.length > 0) names.push(...NPM_RUN_WITH_EVIDENCE.filter((k) => k in env))
  return names.sort()
}

/** A PATH without any `node_modules/.bin` (a package's tools never belong to
 *  every process) nor npm's node-gyp-bin; each entry once, in first-seen
 *  order. Empty entries (= the current directory) go too. */
export function cleanPath(path: string): string {
  const seen = new Set<string>()
  for (const raw of path.split(':')) {
    const entry = raw.length > 1 ? raw.replace(/\/+$/, '') : raw
    if (entry === '' || /(^|\/)node_modules\/\.bin$/.test(entry) || /\/node-gyp-bin$/.test(entry)) continue
    seen.add(entry)
  }
  return [...seen].join(':')
}

/** Removes npm's run variables from `env` (process.env by default) and
 *  cleans its PATH; returns the removed names (plus `PATH` when it changed). */
export function scrubDevRunEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed = devRunVars(env)
  for (const name of removed) delete env[name]
  if (env.PATH !== undefined) {
    const path = cleanPath(env.PATH)
    if (path !== env.PATH) {
      env.PATH = path
      removed.push('PATH')
    }
  }
  return removed
}
