// harnesses/opencode/fence — the territory fence (territory.ts fenceFor,
// written as Claude Code deny rules) translated to OpenCode's permission
// config. Each Claude rule `Tool(pattern)` becomes
// `permission.<tool>[pattern] = 'deny'`; a rule OpenCode cannot enforce is
// skipped and reported in `unmapped`, never guessed.
//
// What OpenCode does (read from the binary's embedded source,
// `strings ~/.opencode/bin/opencode`; 1.14.22 on 26-10, 1.19.4 on 09-11):
// - read asks `{permission:"read",patterns:[relative(worktree,u)]}` and edit,
//   write and apply_patch `{permission:"edit",patterns:[relative(worktree,o)]}`
//   — a WORKTREE-RELATIVE path for both on 1.19.4 (1.14.22's read still
//   asked with the absolute path: a read fence written only in that form
//   matched nothing on 1.19.4 — the 09-11 smoke read a denied ~/.silos file,
//   OpenCode's log `evaluated permission=read pattern=../.silos/ui.json
//   action=allow`). So every read and edit rule is emitted twice: the
//   relative form (the one that matches) and the absolute one. Config
//   patterns are taken as written (only `~/`/`$HOME` expanded).
// - glob/grep ask with the SEARCH pattern (`patterns:[t.pattern]`), not a
//   path, and there is no `list` permission: Glob/Grep/LS rules are unmapped.
// - wildcard match: `u.replace(/\*/g,".*")` compiled with the `s` flag — `*`
//   crosses `/`, so `<dataDir>/*.json` also covers `<dataDir>/agent-state/
//   <me>/runmode.json`. OpenCode cannot say "one level".
// - evaluation: `rules.findLast(r => match(permission) && match(pattern))`,
//   rules built from `Object.entries(cfg.permission[tool])` in insertion order
//   — the LAST matching key wins. Hence `allowPaths`: allow keys appended
//   after every deny (moved to the end even if the key already exists) so an
//   agent can still read and write its own state dir.
// - config layers (launch.ts configContent): a key an EARLIER config layer
//   already holds keeps its position, so a layer the agent can write could
//   reorder our rules. Hence `home`: OpenCode's own config files are denied
//   for edit (opencodeConfigDenies) — they are to an OpenCode agent what
//   ~/.claude/settings.json is to a Claude one — and the launch sets
//   OPENCODE_DISABLE_PROJECT_CONFIG.

import { isAbsolute, relative } from 'node:path'
import type { FenceOverlay } from '../../territory.js'
import { RULE_RE, TOOL_MAP, type PermissionAction, type PermissionConfig } from '../fence-rules.js'

// the rule grammar and the permission shape are neutral (../fence-rules.ts)
export type { PermissionAction, PermissionConfig }

export interface FenceOptions {
  /** OpenCode's worktree for the process (edit patterns are relative to it). */
  worktree: string
  /** Absolute dirs the agent must keep (its own agent-state dir): allowed for read and edit, winning over any deny. */
  allowPaths?: string[]
  /** The operator's home: when given, OpenCode's config files are denied for edit (opencodeConfigDenies), before the allow keys. */
  home?: string
}

/** OpenCode's config files, as edit patterns: project files and `.opencode/`
 *  dirs at the worktree root and anywhere below or above it (an edit asks
 *  with the worktree-relative path: `opencode.json`, `a/opencode.json`,
 *  `../x/.opencode/…` — OpenCode's `*` crosses `/`), and the global config
 *  dir (absolute; setEdit adds its relative form). */
export function opencodeConfigDenies(home: string): string[] {
  return [
    'opencode.json',
    'opencode.jsonc',
    '.opencode/**',
    '**/opencode.json',
    '**/opencode.jsonc',
    '**/.opencode/**',
    `${home.replace(/\/+$/, '')}/.config/opencode/**`,
  ]
}
export interface FenceMapping {
  permission: PermissionConfig
  unmapped: string[]
}

/** OpenCode substitutes `{env:…}`/`{file:…}` over the whole config text: a brace in a path could inject one. */
export function assertNoBrace(what: string, value: string): void {
  if (value.includes('{')) throw new Error(`opencode launch: ${what} contains "{" (OpenCode would read it as a substitution): ${value}`)
}

export function fenceMapping(fence: FenceOverlay, opts: FenceOptions): FenceMapping {
  const permission: Record<string, Record<string, PermissionAction>> = {}
  const unmapped: string[] = []
  // Last write wins AND goes last: delete first so a re-set key moves to the end.
  const set = (tool: string, pattern: string, action: PermissionAction): void => {
    assertNoBrace(`${tool} pattern`, pattern)
    const t = (permission[tool] ??= {})
    delete t[pattern]
    t[pattern] = action
  }
  // a path rule: the worktree-relative form (what the tool asks with) and the absolute one
  const setPath = (tool: 'read' | 'edit', pattern: string, action: PermissionAction): void => {
    if (isAbsolute(pattern)) set(tool, relative(opts.worktree, pattern) || '.', action)
    set(tool, pattern, action)
  }
  const setEdit = (pattern: string, action: PermissionAction): void => setPath('edit', pattern, action)
  for (const rule of fence.permissions.deny) {
    const m = RULE_RE.exec(rule)
    const tool = m?.[1],
      arg = m?.[2]
    const key = tool !== undefined && Object.hasOwn(TOOL_MAP, tool) ? TOOL_MAP[tool] : undefined
    if (!key || !arg) {
      unmapped.push(rule)
      continue
    }
    if (key === 'bash') {
      set('bash', arg, 'deny')
      continue
    }
    // `//abs` is Claude's absolute-path form: one slash off gives `/abs`.
    const pattern = arg.replace(/^\/\//, '/')
    if (key === 'edit') setEdit(pattern, 'deny')
    else setPath('read', pattern, 'deny')
  }
  if (opts.home !== undefined) for (const p of opencodeConfigDenies(opts.home)) setEdit(p, 'deny')
  const allowRoots = (opts.allowPaths ?? []).map((raw) => raw.replace(/\/+$/, ''))
  for (const root of allowRoots) {
    const p = `${root}/**`
    setPath('read', p, 'allow')
    setEdit(p, 'allow')
  }
  // last match wins: a deny INSIDE an allowed dir (the agent's own plugin,
  // inside its state dir) is set again after the allow
  // keys, or the allow would reopen it
  for (const tool of ['read', 'edit'] as const) {
    for (const [pattern, action] of Object.entries(permission[tool] ?? {})) {
      if (action === 'deny' && pattern.startsWith('/') && allowRoots.some((r) => pattern.startsWith(`${r}/`))) setPath(tool, pattern, 'deny')
    }
  }
  return { permission, unmapped }
}

export function fenceToPermission(fence: FenceOverlay, opts: FenceOptions): PermissionConfig {
  return fenceMapping(fence, opts).permission
}
