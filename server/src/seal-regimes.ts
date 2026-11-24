// seal-regimes.ts — the ONE table that answers, for every entry of the data
// dir, «who else writes here with right?» (B1-r6 and G1-r7).
// The regime of a file is fixed by its LEGITIMATE WRITER:
//
//   restore      the Silos server is the only legitimate writer: the server
//                keeps the hash of its last write AND a literal copy; a delta
//                is set aside (held/) and the copy put back — Keep the edit /
//                Discard (seals.ts)
//   rotate       an owner/agent CREDENTIAL the server writes: a delta is never
//                adopted — the token is rotated, sessions are rewritten from
//                memory (all revoked when the delta happened while off)
//   plugin-tree  agent-state/<id>/plugin/** — writers: Silos and the owner's
//                hand: appeared ⇒ plugin-held/, edited ⇒ a row with its door
//   read-hash    the operator's and the ENGINE's files (configFiles,
//                settings*.json, the ~/.claude home layer): hash of last READ
//                + a row, NEVER restore nor held (outside the data dir; listed
//                in seals.ts, not here)
//   out-of-seal  named as outside the seal, with why
//
// A declaration with `specNamed: false` is an entry the spec does not name:
// it is declared (the test demands a regime per entry) but its regime is the
// writer rule's reading, not a decision of the spec — the integrator's
// report lists them as open.
export type SealRegime = 'restore' | 'rotate' | 'plugin-tree' | 'read-hash' | 'out-of-seal'

export interface RegimeDecl {
  regime: SealRegime | 'mixed'
  why: string
  /** false: the spec does not name this entry (see the header). */
  specNamed?: false
  /** a directory: the regime of each path below it, by glob on the path
   *  RELATIVE to the directory (`*` = one segment, `**` = any depth).
   *  First match wins; a path no child matches takes the parent's regime. */
  children?: Array<{ glob: string; decl: RegimeDecl }>
  /** a restore DIRECTORY whose files a legitimate reader CONSUMES (deletes):
   *  a deletion drops the seal silently instead of being restored */
  deletion?: 'consumed'
}

const restore = (why: string, extra: Partial<RegimeDecl> = {}): RegimeDecl => ({ regime: 'restore', why, ...extra })
const outside = (why: string, specNamed?: false): RegimeDecl => ({ regime: 'out-of-seal', why, ...(specNamed === false ? { specNamed } : {}) })
const unnamed = (why: string): RegimeDecl => outside(why, false)

/** Every top-level entry of the data dir, by name. Patterns (sidecars) are in
 *  DATA_DIR_PATTERNS below. A name the code writes and this table misses
 *  fails seals.test.ts. */
export const DATA_DIR_REGIMES: Readonly<Record<string, RegimeDecl>> = {
  // ---- restore: the server is the only legitimate writer ----
  'agents.json': restore('the roster: missions, control, caps — authority'),
  'automations.json': restore('every automation and its trigger'),
  'proposals.json': restore("agents' proposals: the input the owner read is what an accept creates"),
  messages: restore("the messages store: read/unread is the server's word"),
  heartbeats: restore('the heartbeat ledger and considered: read back into quotas and prompts'),
  'plans-origins.json': restore('who created each plan entry (B1-r7)'),
  'plans-provenance.json': restore("the stamper's cursors"),
  'settings.json': restore('platform settings: the unattended provider'),
  'live-turns.json': restore('its console entries CLASSIFY turns'),
  'providers.json': restore("an unattended provider's baseURL would route all unattended traffic (G1-r7)"),
  'vault.json': restore("secrets' scopes per agent (G1-r7)"),
  // its only legitimate writer is the server (the owner edits it in Settings
  // › Agents › Territory): `enabled` decides which agents are fenced — and
  // so which can be On its own — and privatePaths what the fence denies
  'territory.json': restore("the fence's settings (enabled, privatePaths): who is fenced and what the fence denies"),
  // what an agent's (and a conversation's) launches load (loads-scopes.ts):
  // an entry rides the flag-tier settings beside the fence — the server alone
  // writes it, on the owner's click
  'loads-scopes.json': restore("the launch places' entries: what an agent's or a conversation's starts load beside the fence"),
  'asks-replies': restore("the owner's answers to an engine's permission asks: who writes here approves its own asks (G1-r7)", {
    // the OpenCode plugin (plugin-opencode/silos.ts) removes a reply once it
    // read it — a legitimate consumer; an APPEARED or EDITED reply is held
    deletion: 'consumed',
  }),
  // ---- rotate: credentials the server writes ----
  token: { regime: 'rotate', why: "the owner's static token (config.ts ensureData)" },
  'sessions.json': { regime: 'rotate', why: 'login sessions (session-tokens.ts): rewritten from memory' },
  agents: {
    regime: 'mixed',
    why: 'per-agent dirs: the bearer and the agent memory',
    children: [
      { glob: '*/token', decl: { regime: 'rotate', why: "an agent's bearer (agent-tokens.ts, G8-r6): rotated, no row" } },
      { glob: '**', decl: unnamed("the agent's memory (memory-service.ts) — the agent itself writes it") },
    ],
  },
  // ---- the agents' state: their own plugin is sealed as a tree ----
  'agent-state': {
    regime: 'mixed',
    why: "each agent's state dir — the agent's own writable corner (territory.ts), but its plugin is Silos'",
    children: [
      { glob: '*/plugin/**', decl: { regime: 'plugin-tree', why: 'what the engine loads with --plugin-dir: writers Silos and the owner' } },
      { glob: '*/plugin', decl: { regime: 'plugin-tree', why: 'the plugin root' } },
      { glob: '*/plugin-held/**', decl: outside('the quarantine of what appeared in a plugin') },
      { glob: '**', decl: unnamed("the agent's own state (proposed/, asks/, births/, an engine's own dirs…): the agent writes it by design") },
    ],
  },
  // ---- the seal's own machinery ----
  'seals.json': outside('the boot CACHE of the seal map: memory is the truth while the server lives'),
  seals: outside("the seal's copies (seals/copies/…): the boot cache's twin"),
  held: outside('the quarantine of bytes changed outside Silos'),
  // ---- named outside by the spec ----
  trash: outside('the trash (named outside)'),
  executions: outside('mirrors of the SDD execution records (named outside)'),
  births: outside('birth markers (named outside) — today under agent-state/<id>/births'),
  // named outside — its only writer is the server and
  // every agent is fenced from it (territory.ts DATA_DIR_DENIED)
  // the signer's rows — like usage, append-only and the
  // server's alone
  egress: outside(
    "the signer's rows (egress-log.ts): one per signed call, append-only, written by the server alone and fenced from every agent (territory.ts DATA_DIR_DENIED) — it decides no permission and feeds no prompt",
  ),
  usage: outside(
    "Usage's windows (usage-ledger.ts): append-only accounting the server alone writes and every agent is fenced from — it decides no permission and feeds no prompt",
  ),
  'tool-health': outside(
    "the servers' status readings (tool-health.ts): what the engine said of each MCP server and connector, kept by the server alone and fenced from every agent (territory.ts DATA_DIR_DENIED) — an observation, never authority: it decides no permission and feeds no prompt",
  ),
  machine: outside(
    "the machine's samples (machine-sampler.ts): hourly JSONL the server alone writes — measurements, no authority; lost history is lost measurements, nothing to restore",
  ),
  fleet: outside(
    "the control log (fleet-events.ts): append-only record of the ladder's changes the server alone writes — it feeds the fleet chart, decides nothing",
  ),
  vitals: outside("the per-run usage cache (vitals.ts): recomputable from the runs' transcripts — a cache, never the truth"),
  // the container image's root hooks (deploy/docker-entrypoint.sh): agents
  // have full sudo there, so what they write here grants nothing they lack
  'system-packages.txt': outside(
    "the container's remembered `sudo apt-get install` names (deploy/apt-remember.sh), replayed as root at boot — agents are root in their container already",
  ),
  'boot.sh': outside("the container's root boot hook, an agent's to write — agents are root in their container already"),
  // the owner's hand-written deploy settings (server-env.ts): read once at
  // boot, never written by Silos — the environment the server is started
  // with, written down, and no more watchable than that environment
  'server.env': outside(
    "the server's deploy settings, hand-written by the owner (server-env.ts: the Silos ID keys only), read once at boot and never written by Silos — the same authority as the environment the server is started with; fenced from every agent (territory.ts DATA_DIR_FILES_DENIED `*.env`), and an unfenced agent already reads the owner token itself",
  ),
  'boot.log': outside("the container's boot hooks' log (deploy/docker-entrypoint.sh) — a record, no authority"),
  // ---- not named by the spec: declared by the writer rule, reported ----
  'automation-templates': unnamed("the owner's imported automation templates"),
  cache: unnamed('derived caches (session index…), rebuilt from sources'),
  'claude-accounts': unnamed("extra Claude Code accounts' config dirs — the ENGINE writes them (accounts.ts)"),
  'claude-settings-backups': unnamed('backups Silos takes before writing ~/.claude/settings.json'),
  'console-append': unnamed('per-console append files (terminal-service.ts)'),
  'console-env': unnamed('per-console env files, sourced and removed by the launcher'),
  'console-rotations': unnamed('console rotation/context-news markers written by a hook in the console'),
  consoles: unnamed('console bookkeeping'),
  'contested-sessions.json': unnamed("an engine reader's contested sessions"),
  'conversation-prefs.json': unnamed('per-conversation prefs (account, model) the owner picks'),
  digests: unnamed('the daily digests'),
  'doorbell.json': unnamed('the doorbell state'),
  escalation: unnamed("the escalation machinery's state"),
  'file-backups': unnamed('backups of files the owner edits through Silos'),
  hidden: unnamed("sessions hidden from an engine's list"),
  'infra.json': unnamed('infra entries the owner keeps'),
  'lineage.json': unnamed('conversation lineage and thread owners'),
  logs: unnamed('the server log (server-log.ts)'),
  'memory-backups': unnamed('backups before memory edits'),
  'model-catalog.json': unnamed("the SDK's model list cache"),
  'muted.json': unnamed('muted folders'),
  'native.json': unnamed('native sessions Silos started'),
  'needs-you-acks.json': unnamed("the owner's Seen marks"),
  'notifications.json': unnamed('notification state'),
  'overrides.json': unnamed('session title overrides'),
  'pending-resumes.json': unnamed('pending console resumes'),
  push: unnamed('web-push keys (vapid.json)'),
  'push-subscriptions.json': unnamed("the owner's push subscriptions"),
  runs: unnamed('automation run logs'),
  'seen.json': unnamed('Seen marks of conversations'),
  'session-origins.json': unnamed('which automation/run a session was born from'),
  silos: unnamed('the silo kernel: registry, conventions, journal'),
  'skill-staging': unnamed("a proposed skill between proposed/ and the plugin during its accept (skill-accept.ts): Silos' alone, fenced from every agent"),
  'skills-held': unnamed('the Held capability state of skills (skill-states.ts) — a STATE, not a quarantine'),
  'task-mode': unnamed("the task-mode silo's state"),
  'task-seen.json': unnamed("the owner's marks on plan tasks"),
  'visits.json': unnamed("the owner's last Home visit (home-since.ts): where Since counts from — no authority hangs on it"),
  'titler.json': unnamed("the titler's state"),
  'ui.json': unnamed('UI prefs'),
  'server.lock': unnamed('the instance lock (instance-lock.ts)'),
  backups: unnamed('backups'),
  'silos-id.json': unnamed(
    "this instance's Silos ID registration (silos-id.ts): a public id the broker hands out, re-registered every boot — no authority: a pass still needs an allowed, verified email",
  ),
}

// An engine's own entries of the data dir are declared from ITS folder (the
// harness boundary: no neutral code names an engine) — declareDataDirEntry.
const engineEntries = new Map<string, RegimeDecl>()

/** An engine declares a data-dir entry it creates (from its own folder). */
export function declareDataDirEntry(name: string, decl: RegimeDecl): void {
  engineEntries.set(name, decl)
}

/** Every declared top-level entry: the table plus the engines' own. */
export function declaredEntries(): Record<string, RegimeDecl> {
  return { ...DATA_DIR_REGIMES, ...Object.fromEntries(engineEntries) }
}

/** Sidecar patterns of any entry: an atomic write's temp, a corrupt backup. */
export const DATA_DIR_PATTERNS: ReadonlyArray<{ re: RegExp; decl: RegimeDecl }> = [
  { re: /\.tmp$/, decl: outside('an atomic write in flight (tmp + rename)') },
  { re: /\.corrupt-[^/]*$/, decl: outside('a corrupt file preserved before replacement (json-store.ts)') },
]

// segment glob: `**` = zero or more segments, `*` inside a segment = any chars
function segMatch(seg: string, pat: string): boolean {
  return new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(seg)
}
export function globMatch(glob: string, path: string): boolean {
  const g = glob.split('/'),
    p = path.split('/')
  const go = (i: number, j: number): boolean => {
    if (i === g.length) return j === p.length
    if (g[i] === '**') {
      for (let k = j; k <= p.length; k++) if (go(i + 1, k)) return true
      return false
    }
    return j < p.length && segMatch(p[j]!, g[i]!) && go(i + 1, j + 1)
  }
  return go(0, 0)
}

/** The declaration of a data-dir path (relative, posix), or null when
 *  undeclared. */
export function declarationOf(rel: string): RegimeDecl | null {
  const clean = rel.replace(/^\/+/, '')
  const [top, ...rest] = clean.split('/')
  if (!top) return null
  const decl = DATA_DIR_REGIMES[top] ?? engineEntries.get(top)
  if (!decl) {
    const p = DATA_DIR_PATTERNS.find((x) => x.re.test(top))
    return p ? p.decl : null
  }
  if (rest.length === 0 || !decl.children) return decl
  const sub = rest.join('/')
  if (DATA_DIR_PATTERNS.some((x) => x.re.test(sub))) return DATA_DIR_PATTERNS.find((x) => x.re.test(sub))!.decl
  for (const c of decl.children) if (globMatch(c.glob, sub)) return c.decl
  return decl
}

/** The regime of a data-dir path, or null when undeclared. */
export function regimeOf(rel: string): SealRegime | 'mixed' | null {
  return declarationOf(rel)?.regime ?? null
}

/** The restore directory a path lives in (its top entry), when it is one. */
export function restoreDirOf(rel: string): { dir: string; decl: RegimeDecl } | null {
  const top = rel.split('/')[0]!
  const decl = DATA_DIR_REGIMES[top]
  if (!decl || decl.regime !== 'restore' || rel === top) return null
  return { dir: top, decl }
}
