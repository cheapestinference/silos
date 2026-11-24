# Silos — architecture: what is Claude Code's, what is Silos', and how it fits

The mechanics behind `docs/product.md`. product.md says WHAT the user sees
and whose each thing is (binding); this file says HOW each piece works and
by which mechanism (skill, hook, API, silo, automation). Keep it current:
when a mechanism changes, change its line here. This file is the present,
not the history.

## Four layers — each thing lives in exactly one

| Layer                                                                                                                 | What it is                                                                                                        | What it holds                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code** (the engine, never bent)                                                                              | the unmodified `claude` binary, used only through documented flags, settings, hooks, CLAUDE.md, skills and memory | conversations (JSONL transcripts), CLAUDE.md, native memory, skills, plan mode, the checklist (TaskCreate/TodoWrite), native cron                                                       |
| **Silos plugin** (`plugin/`; its hooks and skills reach a session as described in _How the plugin reaches a session_) | what the agent knows                                                                                              | hooks, the skills `team-plan`, `heartbeat`, `vault-secrets`, `support-inbox`, `silo-author`, the briefing parts (`context/briefing.d/`), the claim/release recipes (`context/recipes/`) |
| **Silos** (Fastify server + React web, `~/.silos`)                                                                    | what the owner sees and what wakes agents                                                                         | identities, fence, tokens, the automation scheduler, Needs you, messages, the Silo Standard kernel and its installed silos                                                              |
| **Project folder** (data Silos manages, never code in this repo)                                                      | where work happens                                                                                                | `plans/*.plan.json`, `.claude/skills`, CLAUDE.md, deliverables                                                                                                                          |

OpenCode is the second engine (`server/src/harnesses/`, `docs/harnesses.md`);
everything below that names Claude Code has its OpenCode counterpart there.

## The pieces

**Project** — a folder. To Claude Code it is the cwd (its CLAUDE.md, its
memory under `$CLAUDE_CONFIG_DIR/projects/<munged cwd>/`, its
`.claude/skills`). To Silos it is a Home with that focus.

**Agent** (Silos) — name, mission, folder(s), permissions, skills, in
`~/.silos/agents.json`. The **mission** (`server/src/mission.ts`) is why it acts, in the owner's words: `{ text, never[],
updatedAt }` — text 1–2000 chars, up to 10 «Never» lines of ≤ 200. Only
the owner writes it (`POST`/`PATCH
/api/agents`; a bearer never reaches those routes and `agents.json` is
fenced) — an agent proposes a change, it never edits its own. The fleet
roster (`roster.py` / `roster-text.ts`, twins) says its first sentence.
Its birth asks no decisions: `POST /api/agents`
takes a name and, optionally, a mission and a folder — the id is the name's
slug (`server/src/slug.ts`, the one slugifier; the client sends none), the
folder is `~/Silos/<id>` (made) when none was chosen; with a mission it is
born On its own, fenced at birth, and its page opens on its first minute
(`web/src/components/agent/FirstMeeting.tsx`: one attended chat turn reads
the mission, its answer painted as it came, never parsed).
Before that first birth: the packaged command
`silos` (npm package `silosplatform`: `scripts/pack-npm.mjs` writes
`bin/silos.mjs`; `.github/workflows/release.yml` publishes it on a GitHub
release) starts the same server with `--open`, which opens the printed address —
token included, so the click pairs the browser — where there is a screen
(`server/src/open-browser.ts`; `npm run dev` never opens). Welcome's
`ClaudeReady` reads the default engine's compatibility verdict
(`GET /api/harness`) and the machine's Claude login (`GET /api/accounts`).
Every account's login — signed in or not, email, plan, organization — is
Claude's own answer to `claude auth status --json` (the PATH `claude`, env
built from nothing: PATH/HOME/locale/user plus `CLAUDE_CONFIG_DIR` only for
an extra account; 3 s timeout, non-0/bad JSON ⇒ signed out; kept 30 s per
account, verify asks fresh — `harnesses/claude-code/auth-status.ts`); never
`.credentials.json` (macOS keeps it in the Keychain, an API key has none) nor
`~/.claude.json`. Signed out, «Sign in to
Claude ›» runs Claude's own `claude auth login` in a PTY with no
`CLAUDE_CONFIG_DIR` (`POST /api/accounts/default/login` — refused 409 once
the machine is signed in: a UI sign-in never replaces a login it has). It
never gates Welcome.
When Silos launches its `claude` it adds, by documented means only:

- its mission, as the head of the system append — `Your mission: <text>`
  and `Never, without the owner's word:` with one line per rule — through
  the ONE append every engine reads (`ChatService.systemAppendFor`): the SDK
  chat's `systemPrompt.append`, the console's `--append-system-prompt-file`,
  OpenCode's per-process `instructions` (`role.md`). Read on every launch:
  a saved mission reaches the next conversation;
- its bearer token (`SILOS_AGENT_TOKEN`, `SILOS_AGENT_ID`, `SILOS_API`) —
  every agent has one, the built-in default agent `master` (no folder) included, fence on or off; the server checks
  bearers in memory (`agent-tokens.ts`). Identity on the API: the owner
  carries the static token or a login session, an agent its bearer; a
  request with neither only reads, and only when it is genuinely local
  (loopback `Host`, no forwarding or tunnel headers — `isLocalRequest`) —
  its writes and websockets answer 401, and anything arriving through a
  proxy or tunnel without a credential is refused outright (`server.ts`;
  deployment notes in `docs/deploy/`, reporting a hole in `SECURITY.md`);
  an engine's OWN sign-in by link runs from Silos where the engine offers
  one (descriptor `ui.signIn`; OpenCode today, `harnesses/opencode/sign-in.ts`):
  a short-lived loopback `opencode serve` (random password, the machine's
  own OpenCode data dir — where the agents' OpenCode reads its logins),
  `GET /provider/auth` for the providers with an OAuth «headless» method
  (ChatGPT Plus/Pro), `POST …/oauth/authorize` for the device link and code,
  `POST …/oauth/callback` until the person finishes; OpenCode writes its own
  auth.json, Silos creates the `harness-native` provider agents pick, and
  the server is always stopped (bounded calls, SIGKILL fallback, and on
  Silos' own exit); a login session comes from Google through ONE
  mechanism, the Silos ID broker, when `SILOS_ID_URL` is set (`silos-id.ts`
  — an instance never runs an identity SDK or a Firebase project of its
  own; the broker is a Cloudflare Worker in `silos-id/`,
  official at `https://auth.silosplatform.com`, the one domain Firebase
  authorizes — its registry of origins in Workers KV, its signing key a
  Worker secret; anyone can run their own, `silos-id/README.md`). The instance
  registers its origin with the broker; the way in (Google, or an email
  link to an address) is picked on the INSTANCE's login page and travels
  as `method`/`email` to the broker, which carries it out with no second
  choice — Google by redirect when Firebase's auth domain is the broker's
  own (the Worker passes Firebase's `/__/auth/*` and
  `/__/firebase/init.json` through from `<project>.firebaseapp.com`, GET
  only), else its button and popup; an email link sent at once. The broker
  returns the browser to that REGISTERED origin with an RS256 pass (aud =
  the instance id, nonce = a single-use state bound to the browser by a
  cookie, 120 s); the instance verifies it against the broker's `/jwks` and
  `SILOS_OWNER_EMAIL`, and mints its 7-day session (`session-tokens.ts`;
  setup: `docs/deploy/railway-template.md`). An instance on a broker also
  tells it its use (`instance-usage.ts`, on unless `SILOS_TELEMETRY=off`):
  per UTC day the hours the owner's credential reached the API (the
  `onRequest` hook) and the turns started — attended (chat, console
  spawned) or not (heartbeat, wake, run) — counted where `LiveTurns` mints
  them (`onTurn`); kept in `<data>/instance-usage.json`, finished days sent
  at boot and hourly to `POST /usage`, signed HMAC-SHA256 with the key the
  broker gave this instance once at registration (`silos-id.json`), dropped
  once they land. The broker keeps them on the instance's record beside its
  own counts (boots, passes issued, who signed in) and shows them to
  `SILOS_ID_ADMIN_EMAILS` at `/stats`. The Silos ID settings
  (`SILOS_ID_URL`, `SILOS_PUBLIC_URL`, `SILOS_OWNER_EMAIL`, `SILOS_TELEMETRY`) come from the
  environment merged with `<data dir>/server.env` (`server-env.ts`), read
  once at boot so a hand-started or `npm run dev` server keeps them across
  restarts: `KEY=VALUE` lines, blank lines and `#` lines skipped, the value
  trimmed and optionally wrapped in matching `'…'` or `"…"` (taken
  literally: no escapes, no inline comments); a non-empty variable in the
  real environment wins over the file; the file's values are NEVER copied
  into `process.env` (agents and child processes inherit it — these are not
  theirs); a malformed line or a key the file does not hold (it holds only
  those three — never `SILOS_DATA_DIR`/`SILOS_ROOT`/`SILOS_PORT`/`SILOS_HOST`,
  needed before the data dir is known, nor the secret `SILOS_TOKEN`) is
  ignored and named, keys only, in one boot warning. The seal declares it
  _out of seal_ (below), and the fence denies `*.env` at the data dir's top
  to every fenced agent. The broker's page also offers a
  Firebase email link (passwordless; Firebase Console › Authentication ›
  Sign-in method › Email/Password › «Email link», with the broker's domain
  in Authorized domains) as a minor secondary option: the link returns to
  the same `/login` attempt and its ID token takes the same exchange — no
  new trust path, and the browser binding still decides where it completes;
- its turn token `SILOS_TURN` (`server/src/live-turns.ts`) — 128
  random bits per TURN, never per agent: `ChatService.send` mints one for
  every turn it launches (Claude SDK and `opencode run`; the caller declares
  the class — `chat`, `heartbeat` with `kind`/`packetKeys`, `wake` with
  `taskKey`, `run` with `automationId`; an `unattended` send that declares
  none throws: attended is a class, never a default) and exports it through
  `agentProcessEnv` / OpenCode's `envFor` like `SILOS_SESSION_ID`, binds a new
  session at `chat-init`, drops it in `send`'s finally. Every console
  `TerminalService` spawns (any engine) gets its own, class `console`,
  through the launcher's env FILE (sourced then removed — never `tmux -e`,
  so `tmux show-environment` never shows it); console entries persist in
  `~/.silos/live-turns.json` (0600) and die with their tmux — only when tmux
  SAYS so (`TerminalService.consoleState` / `tmuxSaysGone`: «can't find
  session», «no server running», no socket file; a kill it confirmed; a
  listing it answered). A probe that fails (the 5 s timeout, a spawn error,
  any other errno or stderr) is `unknown`: the token is kept, nothing is
  spawned over the console (`reattachConsole` throws `ConsoleUnknownError`,
  POST `/api/console` answers 503, the console socket closes 4503 and
  retries), and the next definite answer collects a console that really died
  (any later probe, or a listing — the sleep sweep lists every 10 min). The
  token check runs on every agent request, so it never forks tmux: it reads
  the last answer tmux gave (`TerminalService.knownConsoleState` — a probe,
  a listing, a spawn or a kill, ordered by when it was ASKED; a key the
  newest listing does not name is `gone` with no probe of its own; an answer
  older than 3 s still stands while a background refresh runs; `unknown` only before tmux said anything,
  after a failed probe, or while a spawn of the key is in flight; the first
  answer or a flip emits `liveness`, and Task mode delivers again). A
  relaunch STAGES its new token beside the old one and commits it only once
  tmux took the session; a failed spawn discards just the new one. Every bearer WRITE `agentMayWrite` lets through names its
  turn — `"turn"` in the JSON body, the `x-silos-turn` header on a DELETE —
  and a `preHandler` (`server.ts`) classifies it: another agent's token 403;
  unknown/absent 400 while anything of the agent is live, 403 with nothing
  live (never guessed, never «the only live one»); the entry rides
  `req.turn` and the token leaves the body before any route sees it. The
  exemption list (`agent-authz.ts TURN_EXEMPT_WRITES`) is empty: a new
  bearer route needs a turn by default. GETs are not classified;
- its fence: a generated `permissions.deny` in the settings
  (`server/src/territory.ts`), on from birth (`TerritoryStore.enableAtBirth`,
  called right after the create by every path that makes an agent —
  `POST /api/agents` and a role-pack install; Settings › Territory keeps
  only the explicit off). A console whose argv (the fence rides `--settings`)
  passes 8 KB carries it in the same 0600 launch file as its env, not on the
  tmux line (16 KB message cap — `terminal-service.ts`). Beyond Silos' data,
  other agents' state and private paths, it denies Edit on everything an
  engine LOADS behaviour from — the agent's own plugin dir whole, every
  config dir's `skills|commands|agents|plugins|output-styles`, the
  `.claude/skills` of every folder of every agent Silos knows (archived
  included — a conduct file planted in another agent's folder runs as that
  agent; a shared folder is listed once), and each engine's declared `configFiles` there
  (Claude: `<folder>/.mcp.json`; OpenCode: `opencode.json[c]`,
  `.opencode/`, `~/.config/opencode/`) — and Read+Edit on `CLAUDE.md` of
  the config dir, every such folder's `.claude/settings*.json` and
  `/proc/*/environ`. Skills stay READABLE (a skill reads its own files).
  File tools and direct Bash only — an interpreter is not covered
  (`scripts/territory-smoke-loads.sh` checks the real binary);
- its role plugin (`~/.silos/agent-state/<id>/plugin`) — Silos' and the
  owner's to write, sealed as a tree (below);
- its state dir `$SILOS_AGENT_STATE` (its own files: births, asks,
  `proposed/` — no run-mode files: how it runs is the owner's control).

**Vault** (`server/src/vault-store.ts`, `vault.json` 0600) — credentials by scope (agents > folder > global; ONE resolver: deepest
folder then newest, shortest agents list then newest). An entry is
_delivered_ (in the env, `agentProcessEnv`) or _signed_: with a `binding`
(`baseUrl` + `inject {header, format}`, validated at bind: token header name,
no CR/LF/control in the resulting value; never on a public entry; agents
scope refused while a named agent has no identity, folder/global warned) it
leaves `envFor`/`secretsFor` and the agent calls
`$SILOS_API/api/egress/<NAME>/<path>` (`routes/egress.ts`, every verb,
write-class: bearer + `x-silos-turn`, or the owner) — the viewFor winner
over all its folders, 404 without binding, raw body streamed to the fixed
host, 30 s idle cut, redirects/upgrades never followed, its own
Authorization/Cookie/hop-by-hop dropped. The signer only talks to PUBLIC
addresses (`net-guard.ts`: the IP literal before connecting and every DNS
answer — rebinding included — refuse loopback/private/link-local/CGNAT), so
a binding can never aim the server at itself or an internal service. One row per call (no query, no
body) in `egress/signed.jsonl` (rotated at 2 MB like `runs/`), read by the
owner at `GET /api/vault/signed-calls`. The producer brief lists both classes
(`VaultStore.credentialsFor`).

**Binding asks** (`server/src/binding-asks.ts`) — an agent
that needs an entry signed says so on its task: `waitingOn {owner: "owner",
…, binding: {entry, baseUrl?, inject?}}` (team-plan). Silos reads it from
the Plans silo (`GET /api/vault/asks`, also beside the entries on
`GET /api/vault`), checked with the Vault's own `validateBinding`, aimed at
the entry the asking agent would sign with (`VaultStore.winnerOf`): a name
not in the Vault, not visible to it, or public is a BROKEN ask — said on the
row, never an editor prefilled toward an entry made on the fly. Each live ask
carries its provenance (`project#tN`, the task's owner — informative: plan
files are unsigned) and `neverSeen` when its registrable domain matches no
Vault binding and no engine's `network.ts`. The task row (Needs you, the
task's page) shows the host as hero and a door to `/vault?sign=<task key>`:
the editor opens PREFILLED, lists every live proposal on that entry (one
entry = one binding, said), shows now → after — and writes nothing. The
owner's save is the only write; ANY successful save of that entry's binding
(PATCH, or a POST created signed — never a refused one or a hand-back)
resolves every open ask on it, whatever values were saved: an owner note
saying what was saved (task mode's owner-note wakes a bound owner), the wait
cleared, `pending` when nothing else holds it — the woken agent verifies
with a first signed call.

**Egress** (`server/src/egress-proxy.ts`) — per agent in
`territory.json`: `egress: {<id>: {mode: open|allowlist, hosts}}`, absent =
`open`. ONE local proxy started by `index.ts` on every boot at
`127.0.0.1:<API port + 1>` (stable: a console's env is frozen for days;
EADDRINUSE retried 30 s). An `allowlist` agent's env gains — through
`AgentStateStore.envFor`, the identity channel every launch site spreads
after the Vault, so both engines, console and SDK and command runs —
`HTTP(S)_PROXY`/`http(s)_proxy` = `http://agent:<bearer>@127.0.0.1:<port>`
and `NO_PROXY`/`no_proxy` = `localhost,127.0.0.1,::1`; `open` = nothing.
The proxy: CONNECT tunnels (TLS intact, never MITM) and absolute `http://`
forwards; identity by `Proxy-Authorization: Basic agent:<bearer>` (else 407);
allowlist = the owner's hosts + its harness's `engineHosts` (the engine's
own documented list, in its folder's `network.ts`; optional ones offered,
never pinned); exact, `*.domain` or `*-prefix` matching; not allowed = 403.
An `open` agent calling it anyway is let through (open means open). Public
addresses only for every caller (`net-guard.ts`, the literal and the
connection's own lookup — the socket connects to the checked IP) = 502.
Each 403/502-private leaves `{at, agentId, host, port, reason}` in
`egress/rejected.jsonl` (rotated at 2 MB), read by the owner at
`GET /api/territory/egress/rejections`; `GET /api/territory/egress` lists the
policies + engine hosts, `PATCH /api/territory/egress/:agentId` sets one.

**The seal** (`server/src/seals.ts`, regimes in `seal-regimes.ts`) — the net under the fence (with the fence off it is THE
net). Every entry of `~/.silos` has ONE declared regime, fixed by its
legitimate writer (a test boots a server and walks its data dir):

- _restore_ (the server is the only writer: `agents.json`, `automations.json`,
  `proposals.json`, `providers.json`, `vault.json`, `territory.json`, `asks-replies/`,
  `messages/` (a directory store: `registerDir` gives every file below it
  the same rules — «Keep the edit» validates and adopts one message), and
  `heartbeats/`, `plans-*.json`, `settings.json`, `live-turns.json` as they arrive): the server keeps the hash of its last
  write and a literal copy, IN MEMORY — the truth while it lives. A store
  writes through `atomicWriteJson` (or `seals.write/append`, or the
  `stage/commit` hooks for an exclusive write) and the seal does it in the
  contract order: copy (`seals/copies/`) → file → cache (`seals.json`). A
  delta (10 s reconcile tick) is moved to `held/<ts>/`, the copy put back
  with the mode Silos gave the file (a restore or a Keep never widens who
  can read: secret-bearing files — credentials, `providers.json`,
  `vault.json`, `territory.json` — are 0600 when no mode is
  known and never wider than their owner),
  and Needs you says «<file> changed outside Silos — review the set-aside
  copy · Keep the edit · Discard»; Keep validates (`registerFile` rules —
  agents.json: no On its own without a mission), writes, re-seals and
  reloads the store. The boot re-hashes against cache + copy: Silos' own
  crashed writes are recognised, an outside change is restored, and the one
  double mismatch loads the file DEGRADED (`degradeAgentsJson`: own → told,
  knobs to default; `seals.degraded(file)`) with «unverified across restart».
- _rotate_ (credentials: `token`, `sessions.json`, `agents/<id>/token`):
  same order — the copy is a hash, never the secret — but a delta is never
  adopted: the owner token rotates (row), sessions are rewritten from memory
  (all revoked + row when it happened while off), a bearer rotates silently.
- _plugin tree_ (`agent-state/<id>/plugin/**`): an appeared path goes to
  `plugin-held/` (Put back · Delete), an edited one is a row that says its
  consequence («X's engine loads it on its next conversation») with «Hold»
  in the row itself: one touch moves the edited paths to `plugin-held/`
  too (out of `--plugin-dir`) and the row becomes their Put back · Delete
  row; a deletion has nothing to hold. Silos' own plugin writes re-seal
  (`seal-hooks.ts pluginWritten`).
- _read hash_ (each engine's `configFiles`, `<folder>/.claude/settings*.json`,
  `~/.claude/{commands,agents,plugins,output-styles}`): Claude Code itself
  writes some of these — hash of last READ + a Seen row, never restore;
  the walk is bounded (`READ_WALK_MAX`, 20 000 files). The server's tick runs
  it every minute as `reconcileReadsAsync` — async readdir/stat/read, files
  in batches of 64 and long loops in slices with the event loop released
  between them, never overlapping itself, `seals.json` rewritten only when
  the pass changed it; same rules and results as the sync `reconcileReads`
  the boot runs (`test/seals-reads-async.test.ts`). A file Silos checks or
  reseals meanwhile is left to that newer reading; `checkRead` (before an
  owner's settings write) finds the file's watch entry from the plan, never
  a walk;
  Silos' own capability-state writes re-seal (`harnesses/claude-code/local-settings.ts`); an
  engine-keys-only diff (`permissions.allow`) is a page line.
  The engine's own bookkeeping there (`.in_use/<pid>`, `.last_inuse_sweep`,
  `.orphaned_at` — markers its processes write as they run, not content it
  loads) is never hashed and never a row (`seals.ts ENGINE_BOOKKEEPING`).
  Under `~/.claude/plugins/` only what the engine's record
  (`installed_plugins.json`: plugin → version + `installPath`) names is
  loaded code, so only three things are rows: the record gains or loses a
  plugin versus Silos' last read («X was installed in / removed from the
  engine outside Silos — every agent's engine …»); a file edited, added or
  deleted inside an `installPath` the PREVIOUS record named and the current
  one still names (an in-place edit); and the record turning unreadable,
  or readable again. A plugin moving to another version is the engine's
  routine — a page line («superpowers 7.0.1 → 7.0.2»), no row — and the
  rest (the marketplace catalog, caches, `store/`, `synced/`, a version
  directory fetched before the record names it: the engine writes the new
  directory BEFORE it rewrites the record, which is why the rule keys on
  the previous record) is the engine's storage: nothing. The last read of
  the record is persisted in `seals.json` (`pluginRecord`), so a boot after
  an update diffs against it; the first read is the seal. Honest limits: Silos cannot tell an
  engine auto-update from a hand-made version bump (both are a page line)
  — the integrity signal kept is new plugins and in-place edits; and the
  account-synced plugins under `plugins/synced/` are not in the record, so
  they are not watched as loaded code.
- _out of seal_ (each named with why in `seal-regimes.ts`): among them
  `server.env`, the owner's hand-written deploy settings — never written by
  Silos, read once at boot: the same authority as the environment the
  server is started with, which no seal can watch either. Fenced agents
  cannot reach it (`*.env` is denied), and an unfenced one already reads
  the owner token itself, so a seal would protect nothing it lacks. There
  is no regime for hand-written files the server serves live: the one that
  existed (_blessed_, for an instance's own Firebase config) left with that
  sign-in path.
  Residue, said once: an interpreter running as the same Unix user can still
  write; what changed is not SERVED, and only OS-level isolation per agent (a
  separate Unix user or container — not built) would close the class.
  The plans stamper has the same class of residue: a verdict waiting for its
  turns' end survives a restart (persisted with the cursor in
  `plans-provenance.json` and judged at the first settle), but a plan edited
  while the server is DOWN has no live turn to attribute it to — it stays
  (`unknown` if it appeared), never judged; the same limit.

**Conversation** (Claude Code) — a real session. Silos opens it as a real
console (one tmux session running `claude`) or as an SDK chat; it links to
it and never owns or embeds it. A conversation Silos launches gets its id
as `SILOS_SESSION_ID` (stable across `/clear`); a `claude` the owner starts
by hand has only Claude Code's `CLAUDE_CODE_SESSION_ID`.

**What a conversation loads at start — names, plugins, the account's
batches** (Claude Code; `harnesses/claude-code/loads/`). Three rules every
reader of «what loads» stands on:

- **One name resolver** (`loads/names.ts`). The engine names a server
  exactly (`plugin:<plugin>:<server>`, `claude.ai <Name>`, a config key);
  its tool names carry an id where everything outside `[A-Za-z0-9_-]` is
  `_`. The id of every KNOWN name is computed and compared; an id is never
  split or turned back, and two names with one id stay unresolved. A
  connector seen only in tool names is shown by that id.
- **One plugin resolver** (`plugin-enablement.ts`): an explicit
  `enabledPlugins` entry by precedence (managed > local > project > user),
  else the manifest's `defaultEnabled`, else ON — so a plugin no settings
  file mentions loads. It answers for the account's plugins too
  (`<manifest name>@synced`), under their origin key
  `syncClaudeAiPlugins: false` (managed, local or user file — never the
  project's), which hides them all. Knows › At start (`loaded-at-start.ts`)
  asks it; it no longer keeps a resolver of its own.
- **Account batches** (`loads/account-batches.ts`): the account's plugins
  live in `plugins/synced/<organizationUuid>_<accountUuid>/<folder>[~gN]`
  (one tree shared by every login — `accounts.ts SHARED_DIRS`); the highest
  generation of a folder is live, the plugin is its manifest name. Read by
  structure only, unknown shapes skipped. A batch is matched to a login by
  the account id a start recorded (the transcript's `session-owner`
  record), by elimination when one login and one batch remain, else not
  listed and said. An installed copy that is on takes the account copy's
  name («a plugin you installed with the same name takes precedence»).
  A plugin's server entry with no `url` and no `command` is a placeholder
  (by structure, never by name); entries sharing a `url` are one server,
  connected once under the first (`loads/plugin-servers.ts`). What the
  account's plugins bring is owned by «Your Claude account · <login>», never «This machine».
- **The inventory** (`Harness.loads.inventory`; Claude Code:
  `loads/inventory.ts`; neutral gathering: `folder-loads.ts`; `GET
/api/folders/:folder/loads`, owner-only, managed folders only). ONE row
  per thing a folder's conversations load: installed plugins, each batch's
  plugins under its login, every plugin's MCP servers (a row each, under
  its plugin, with placeholder / «same server as»), the folder's
  `.mcp.json`, the operator's `~/.claude.json` servers, and connectors a
  status reading names. A row has its origin (owner + carrier, the login
  for an account row), its state — active · held (yours or the project's,
  off here) · available (the account's, not added) — and the file and key
  that decide it when that is not the project's local file. Observed rows
  join what disk declares: a name only a reading lists (origin from its
  `source`) and a tool-name id no known name has (no switch). Of two copies
  of one plugin, a reading that lists a server only one copy declares names
  the live one; else the installed copy when it is on (`replacedBy` on the
  other). What a plugin carries (skills, commands, subagent types, hooks by
  event, servers, placeholders, LSP servers, output styles) is read from its
  manifest and folders and remembered per directory by mtime
  (`loads/carries.ts`). Settings layers are read on every call. The folder's
  agents' engines answer (the fallback for a folder no agent of a declaring
  engine has); an engine without `loads` adds no rows. The logins come from
  the `session-owner` records of the folder's newest starts and the
  machine's. Only `inventory` is required: the answer says per engine
  what it adds (`engines[].readsStatus`, `switches`, `checks`), a row of an
  engine without `switch` never carries one, and Tools says in one line, by
  the engine's label, why such an engine's rows have no switch or no
  health. OpenCode (`harnesses/opencode/loads.ts`) declares the inventory
  alone: the MCP servers of `~/.config/opencode/opencode.json(c)` (Your
  machine) and the folder's `opencode.json(c)` (Project), each naming the
  file and key that decide it (`enabled` merged in OpenCode's layer order:
  yours, then the project's); the agent's own servers are Agent › Tools'
  rows; no account origin, no reading, no notice, no check, no proof, no
  starting-set class; its places (spec scopes §9, T13) are below. Project › Tools draws every row (owner groups, the account per
  login, a plugin unfolding to its servers); Agent › Tools draws what loads
  for that agent, switched for it alone («The agent's page», below), and
  counts the rest at its foot; the proactive sheet's connectors read it too.
- **Where it loads — the places on every row** (spec scopes §2, §4, §9;
  T2 drew the lines; each place's switch is in the sections below). An engine declares `Harness.loads.scopes` — its
  places, broadest first, each with its carrier (`file` the engine reads
  itself · `launch` Silos keeps and hands to every process it starts ·
  `door` changed outside Silos) and where its entries are kept. Claude
  Code (`harnesses/claude-code/loads/places.ts`): account (door,
  claude.ai) · machine (`~/.claude/settings.json`) · project
  (`.claude/settings.local.json`) · agent · conversation (launch). Each row
  then carries `family` — `override` (plugins: the narrowest entry decides,
  either way) or `off-only` (MCP servers, connectors, an account origin's
  head: off at any place is off) — and `at`, one line per place and per
  FACT (managed settings on top, locking every other line; a plugin's own
  default; the repository's `.claude/settings.json` between machine and
  project; `~/.claude.json`'s per-project toggle): its own `entry`, the
  `result` there with every line above counted, `keptIn`, and `locked`
  (`wider` — an off-only thing a wider line keeps off; `organization`;
  `provided` — a server of the organization's `managed-mcp.json`, listed as
  its own row, takes no entry from the project's files, so only its
  project line is locked). A server of ONE project (`.mcp.json`,
  `~/.claude.json`'s per-folder entry) has no machine line unless the user
  file holds it; a plugin's server is off wherever its plugin's line is.
  The agent lines come from `LoadsInput.carried.agents` — the folder's
  non-archived agents, each with the payload Silos keeps for it (below;
  null: none, so the line follows the project);
  `folder-loads.ts` names them (`agentName`), passes each engine's
  `scopes` in `engines[]`, and strips `at`/`family` from an engine that
  declares none (it keeps today's single switch). The web
  (`lib/loads-places.ts`, `knows/WhereItLoads.tsx`) draws ▾ beside every
  such row's switch on Project › Tools and Agent › Tools, the block «Where
  it loads» under it (an agent's page: that agent's line only; more than
  five agents: those with an entry), and ONE phrase when the places
  disagree («off on this machine», «on here — off on the rest of this
  machine», «off for Builder», «only Builder loads it») — a door to the
  block; a file that is one of the row's places is its line, never a «set
  in …» beside the row. The row's project switch is unchanged.
- **OpenCode's places** (spec scopes §9, T13; `harnesses/opencode/loads.ts`,
  `launch-entries.ts`, `global-config.ts`). Every OpenCode layer is an
  override, both ways (measured 1.19.6): global file ‹ the folder's
  `opencode.json(c)` ‹ `OPENCODE_CONFIG_CONTENT`, so every row is `family:
'override'` and its lines are: facts above every line — a managed config
  (`/etc/opencode`, or OpenCode's own `OPENCODE_TEST_MANAGED_CONFIG_DIR`) and
  an `OPENCODE_PERMISSION` deny of `<name>_*` — that lock all of them (the
  row then names what decides, no switch; a remote organization config
  Silos can't read is said once in the Tools notes); **This machine** — a
  FILE, `mcp.<name>.enabled` in the global file OpenCode reads last
  (`opencode.jsonc` over `opencode.json`; none → `opencode.json` created),
  written only while it is strict JSON (comments, not JSON, not an object,
  an entry of another shape → 409 naming the file, untouched, and the line
  shows no switch but the reason), only its entry («on» removes it — the
  machine follows OpenCode's default — and a bare `{enabled}` left empty
  goes), atomically through a symlinked file, re-read before the rename; the
  seal watches that file (`configFiles`), so the writer calls
  `beforeOwnEdit`/`afterOwnEdit` — its write is never a «changed» row; the
  folder's file — a FACT (`repository`) when it says `enabled`, never
  written, and not read at all by a fenced launch
  (`OPENCODE_DISABLE_PROJECT_CONFIG`); **Project · <name>**, **Agent ·
  <name>**, **Conversation · <title>** — LAUNCH places, kept by Silos: the project's under
  `loads-scopes.json` `folders` keyed by folder (`LoadsCarried.folder`; the
  row's plain switch, no `scope`, lands there — folder-loads routes a
  project whose scope is `launch` through the store), the agent's under
  `agents`, the conversation's (T5) under `conversations`. The switch
  returns the new payload, writing nothing; an entry is kept only where the
  place differs from what it follows (rule 12). **The allowlist**
  (`cleanOpencodeEntries`): `mcp.<name>: {enabled: boolean}` and
  `permission.skill.<name>: "deny"` — anything else (a server's definition,
  any other `permission` key, `plugin`, `instructions`, `provider`, a name
  carrying `{`) is dropped at the switch and at every launch. **The
  launch** (`configContent` `carried`, `withOpencodeEntries`): every
  OpenCode process — console (`server-hooks.ts`), chat, run, wake, round
  (`headless.ts`) — gets `loadsCarried(agent, cwd)`: the launch folder's
  payload, then the agent's (T5: then the thread's), merged LAST into the
  config content, later wins; a skill's deny is merged INTO the
  `permission` the launch carries (the fence's, the held skills' denies),
  appended last, replacing none of its keys — a held skill stays denied; a
  heartbeat takes no `enabled: true`. A fenced launch carries all of it
  (the content is not a project layer). No payload: byte-identical.
- **«Agent · <name>» — the agent's place, carried at launch** (spec scopes
  §3, §6; T3). Kept in `<dataDir>/loads-scopes.json` (`loads-scopes.ts`,
  0600, seal regime `restore`, the server its only writer; a top-level
  `*.json`, so already outside a fenced agent's tools —
  `DATA_DIR_FILES_DENIED`): `{agents: {<agent id>: {<engine id>: {entries,
at}}}, conversations, folders, undo}` — `entries` the engine's payload
  (neutral code never reads inside), `at` each row's own entry time by row
  key (a row whose entry goes loses it). `conversations` is the same shape
  keyed by thread (below); `folders` the same keyed by folder — the project's
  place of an engine that carries it at launch (OpenCode, T13); `undo` each
  place's last bulk click (T11, below). An archived
  agent keeps its entries; one the roster no longer has loses them (pruned
  at boot and when `agents.json` is adopted); a role pack carries none.
  **The switch**: `POST …/loads/switch {key, to, scope: 'agent', agent}`
  (owner-only; an agent that does not have the folder, or is archived, is 404) hands the engine the kept payload (`Harness.loads.switch(input, key,
to, at)`); Claude Code (`loads/switch.ts claudeLaunchSwitch`) cleans it
  through its allowlist, writes the row's entry only where the agent
  differs from the project line (rule 12 — `to` equal to what it follows
  removes it), refuses (409) a line a wider place locks (an off-only thing
  off above, managed settings), and returns the new payload — it writes no
  file; neutral code keeps it. Each kind writes exactly its key with the
  engine's exact names: a plugin `enabledPlugins` true/false, a `.mcp.json`
  server `disabledMcpjsonServers`, every other server and a connector a
  `{serverName}` deny — every live copy's name for a server several plugins
  ship. A home folder's refusal stays on the project line; its agent lines
  work. **The allowlist** (`loads/launch-entries.ts cleanEntries`) — only
  §3's keys and shapes: `enabledPlugins` booleans, `deniedMcpServers`
  `{serverName}` entries, `disabledMcpjsonServers` names, `skillOverrides`
  off/name-only/on, the three account keys in their «off» value; anything
  else (`permissions`, `hooks`, `env`, a URL deny…) is dropped, at the
  switch AND at every launch. **The launch** (`withLaunchEntries`): the
  agent's payload merges into the SAME flag-tier object as the fence —
  later wins per key for an override kind, lists joined, every key the
  launch already carried kept (the fence's `permissions`, Silos' hooks, the
  style's plugin «off» entries) — in a chat turn's `options.settings`
  (`headless.ts`, after the files an unattended turn skips), a console's ONE
  `--settings` (`console.ts`; `server-hooks.ts` and `console-open.ts` hand
  it `carried` from `ServerDeps.loadsCarried`), and so every run, wake and
  round (they are chat turns); a heartbeat takes only what removes (no
  plugin «on», no skill lifted — rule 14). Nothing kept, or nothing the
  allowlist keeps: the launch is byte-identical. It is what LOADS, never a
  fence: a `claude` the agent starts from its shell reads the folder's
  files. On Project › Tools each agent line of the block carries its
  switch (`LoadsLine.switch`: the names, and the rows they reach — asked
  first); a locked line shows its reason instead.
- **«This conversation» — one conversation's place, carried at launch**
  (spec scopes §4, §6, §7; T5). Kept in the same store under
  `conversations[<thread id>]`, the thread ROOT the SERVER resolves from
  the session id the web holds (`threadIdOf`, the resolver conversation
  files use; `conversation-places.ts`): a resume, a sleep and wake, a
  console's `/clear` rotation and a branch in the same project (a worktree
  counts) are one thread and read one set; a fork into another project is
  another thread and starts with none. **The routes**: `GET
…/loads?conversation=<session id>` answers the rows as that conversation
  sees them — `carried.conversation` only (no other conversation's
  entries), its line following ITS agent's (managed › conversation › agent
  › project: `places.ts` resumes the chain from the agent's line, so an
  off-only thing its agent keeps off locks it `at: 'agent'`, and an
  override kind can be turned on here over its agent's «off»), plus
  `here` on each line with an entry of its own (`switch-proof.ts
conversationEntryState`): `pending` until a start of ITS thread begins
  after that row's own `at`, then `in-effect` or `didnt-take` by the
  newest such start — a turn's status reading (a whole list) or a start
  notice (names only what failed: an «off» it does not name counts in
  effect, the console limit of spec §13). `POST …/loads/switch {scope:
'conversation', conversation: <session id>}` writes only that entry
  (rule 12 against its agent's line; an off-only row held wider is 409,
  saying where). A session the index does not know (not started yet) or
  whose cwd is not that managed folder is 404; owner-only like every
  switch. Without `conversation`, a page's GET carries the folder's other
  conversations that keep an entry (`carried.conversations`): a line only
  where one names the row, no switch, and `conversations[]` — each one's
  newest session and title — for the block's «Also off in «title» ›».
  **The launch**: `ServerDeps.loadsCarried(agentId, cwd?, sessionId?)`
  (`index.ts`, the one path) returns the folder's and the agent's payloads, then —
  for a chat turn that resumes a session (`headless.ts`), a console
  reopened on one (`server-hooks.ts`, `console-open.ts`) — its thread's;
  `withLaunchEntries` merges them in that order (the conversation wins an
  override kind, lists joined). A console already running is reattached,
  never relaunched: it keeps what it started with, so its line says
  «when this console is reopened». **The sweep**: the
  resident's slow sweep (`sweepLostConversations`, beside the pins') drops
  the entries of a thread the index no longer knows — root nor any
  session on it — only with a warm index, and never within 10 minutes of
  the record's newest row time (a durable grace). **Its house — the agent's
  page opened from the conversation** (spec scope-ui-review §4.3; the
  column only points, owner 24-11): `agent/from-conversation.ts` reads,
  beside the agent's own read, `GET …/loads?conversation=<session id>`
  and the skills catalog for it, and merges each row's line of THAT
  conversation into the agent's rows (a conversation in another folder
  than its agent's: that project's rows, narrowed to the agent);
  `lib/loads-places.ts` keeps that one conversation line in the block
  (`PlacesPage.from`), last, «Conversation · <title>», with its switch
  (`POST …/loads/switch {scope: 'conversation', conversation}`) and the
  words of when it takes effect (`lib/here-tools.ts`: «from its next
  message» · «from its next run» for a thread an automation keeps · «when
  this console is reopened», with a way back to the conversation to
  restart a running one) or that it didn't take. Opened any other way the
  block has no conversation line: another conversation's entry is a fact
  at its end, «Also off in «title» ›», whose door opens THIS tab from that
  conversation. **The column** (`knows/knows-here.ts`): Knows is one
  summary line per kind as the conversation loads it — «N load · n off
  here» — each line a door to its agent's tab carrying the conversation
  (`openDossier`, `agentFrom`); Context size's MCP count takes the same
  door to Tools. **Skills, the same
  way** (T9's seam): `skill-places.ts` adds the conversation's line after
  its agent's (it follows its agent's, its entry wins both ways, a project
  skill only off; a skill the engine locks stays inert); `claudeSkillSwitch`
  takes `scope: 'conversation'` like an agent's, against its agent's line;
  `switchFolderSkill` keeps it under the thread (`skill:<name>`); `GET
/api/agents/:id/skills-catalog?conversation=<session id>` returns each
  skill with that line and `POST …/skills/:name/position {scope:
'conversation', conversation}` writes it (404 a session that is no
  conversation of the folder); the agent's Skills tab opened from the
  conversation draws it (`SkillPlaces`), positions and when-words.
- **The agent's page — the house of «this agent»** (spec scopes §4, §5,
  §7; T4). Agent › Tools reads `GET …/loads?agent=<id>`: the same rows,
  each `at` narrowed AFTER health and proof are computed to the machine's,
  the project's, the facts' and THAT agent's line — another agent's line
  (its entries) is never returned to it; an agent that does not have the
  folder is 404, an archived one reads with no line of its own; its
  project line still names every agent of the project it reaches
  (`LoadsLine.agents`, names only — `folder-loads.ts asAgentLines`), and
  switches there too, after saying whom it reaches. Its plain
  switch is that agent's line (the same `POST …/loads/switch {scope:
'agent', agent}`, asked first when it reaches more rows): what loads
  for the agent is its line's `result` (`lib/loads-view.ts loadsFor`); a
  row the project loads and the agent alone holds stays in its group,
  dimmed, «off for Ana only», with no health, and is counted at the foot
  («· 2 off only for Ana ›», which narrows the list to them); a row the
  project keeps off and the agent turns on is listed, never counted «off»;
  a line a wider place locks writes nothing — the click opens the block
  on it. The block's own agent line switches there too. «Check now» on it
  (`GET|POST …/loads/check` with `agent`) checks that agent's login only,
  with its role plugin, starting as its launches do —
  `LoadsCheckInput.as` hands the engine the payload Silos keeps, which
  Claude Code merges into the check's flag-tier settings through the
  launch allowlist (`withLaunchEntries`) — and keeps the reading as the
  agent's (`agent` in the ledger); its last check is its page's, the
  project's head counts only checks taken as no agent; «See what it sends»
  is the project's (400 with an agent). **Health stays the project's**:
  `tool-health.ts holdersOf` — the agents whose line has an entry of its
  own — and `withHealth`/`start-health.ts` skip their readings for that
  row's health and count (never «not read»). Not yet: the start notices
  and the measured weight carry no agent, so they are not skipped.
- **«This machine», switched** (spec scopes §6, §8; T6). A line carries its
  own `switch` (the exact names) or `refused` (an engine below the version
  its key was confirmed on: Claude Code's machine line, 2.1.331 —
  `MACHINE_CONFIRMED_ON`); the project line's is the row's own. `POST
…/loads/switch {key, to, scope: 'machine'}` → `Harness.loads.switch(input,
key, to, {scope})` → Claude Code's `loads/machine.ts`: ONE entry of the
  user's own `~/.claude/settings.json` through its one writer
  (`settings.ts editUserSettings`, which the five older writers — retention,
  hooks in and out, push, checklist — now call too): a plugin you installed
  explicit `false` / `true` (the bytes `claude plugin disable|enable --scope
user` writes), an account plugin `<name>@synced: false` (on removes it),
  a server, a plugin's server (every live copy's name) and a connector
  exactly `{serverName}` (on removes exactly that; a hand-written entry of
  another shape that keeps it off is named and kept). Refused 409: no
  machine line (a server of one project), managed settings, the engine
  version, a file it can't read as an object, a key of another shape; the
  machine's line works in a home folder (only the project line refuses
  there). A request without `scope` never writes the user file. After the
  write the route asks the extra logins to follow (`AccountsService.follow`
  now answers per account: `followed`, or why not — its own file
  unreadable, never clobbered) and answers `logins: {followed, missed}`; the
  block names any login that missed. `GET …/loads/reach?key=` counts the
  managed projects whose inventory loads the row now — the machine «off»'s
  confirm («Turns it off in every project on this machine and every login
  Silos connects — 3 projects load it now»). The project line turns an
  override kind ON over the machine's or the repository's «off» (local
  `true`); an off-only kind the machine keeps off is refused, saying it
  can't come back for one project. The seal does not watch the user file:
  nothing to reseal. Welcome › «At start» and the New agent form's line
  read `startingFacts`, whose `machine[]` counts what a new project loads
  (`n`) apart from what the machine keeps off (`off`, named).
- **The heads at every place, rule 4 per place, the account's door** (spec
  scopes §3, §7; T8). Each account origin — `plugins`
  (`syncClaudeAiPlugins: false`), `skills` (`syncClaudeAiSkills: false`),
  `connectors` (`disableClaudeAiConnectors: true`) — is an off-only key
  with its own `LoadsOrigin.at` (Claude Code: `loads/heads.ts` →
  `places.ts linesOf`): the account door, the facts, the machine, the
  project, each agent. `POST …/loads/switch {origin, to, scope?, agent?,
confirmed?}` → `Harness.loads.switchOrigin(input, origin, to, at)`: each
  place writes or removes ONLY its head key — the project's local file, the
  user file (`machine`), an agent's payload (`agent`, returned and kept in
  `loads-scopes.json` under `origin:<id>`). The machine's «off» is the one
  that moves things (Claude Code trashes the synced copies; downloads them
  again on «on»): its line carries `asks` — the engine's sentence — and the
  writer refuses it 409 unless `confirmed: true`. A head off at a place
  takes its account rows out there (`RowTiers.head`; an agent's payload
  included) and says so (`LoadsLine.headOff`); every narrower line is
  locked (`locked: {why: 'wider', head: true}` — «open it for this machine
  first»). Rule 4 per place: «on» on an account row whose head is off at
  THAT place (machine: `machine.ts`; agent: `claudeLaunchSwitch`) removes
  the place's head key and writes the item-level «off» for every other
  known item of that origin there — the UI says so first. The account line
  is a door: its `url` only where a walk confirmed the page (connectors:
  `sign-in.ts CONNECTORS_URL`); plugins and skills name «claude.ai» with no
  link. Outside any folder: `Harness.loads.machineHeads` /
  `switchMachineHead`, `GET/POST /api/loads/machine` (owner-only) — the
  Settings › «New projects» line of a class (`StartingSetClass.origin`)
  the machine keeps off («Off for this whole machine — new projects can't
  add it · change ›», its machine line opened right there). UI: ▾ on the
  head (`OriginHead` → `WhereItLoads` with `head`), Project › Tools and
  Skills.
- **All / nothing, its «Undo», and «Make it <agent>’s alone»** (spec scopes §4, T11;
  `loads-bulk.ts`, neutral). `POST …/loads/bulk {keys, origins, to, scope?,
agent?, confirmed?, group, preview?}` (owner-only) — the head of an owner
  group, or of the tab, at ONE place (project · machine · one agent). The
  plan is read from the lines: a row is an item where its line at that
  place can take the click (`switch`, not `locked`; an off-only row is
  turned on for one agent only by removing its own «off»), «cannot» where
  its line differs and can't (decided elsewhere); an account row is never
  an item — its origin's head key is (it covers what the account sends
  later); a plugin's server is an item only where its plugin ends on.
  `preview: true` answers the counts by kind and writes nothing (a machine
  head's sentence in `asks`; its «off» still refused without `confirmed`).
  The click is ONE write: `Harness.loads.switchMany(input, set, to, at)` —
  Claude Code (`loads/switch.ts claudeLoadsSwitchMany`) collects each
  item's mutation from the single switches (their `edit` seam) and writes
  the local or the user file once; at an agent it chains the payload and
  answers it once (`LoadsScopesStore.recordMany`, each item's own `at`).
  Its undo set is kept in `loads-scopes.json` `undo` under the place's key
  (`project:<folder>` · `machine` · `agent:<id>`, one per place, replaced
  by the next bulk click there): the head (`group`), the folder, and each
  item's line `entry` before and after. `POST …/loads/bulk/undo {scope?,
agent?, group}` replays the opposite click over exactly those items —
  only while every one still reads its `after` (409 otherwise, the set
  dropped; 404 nothing on that head); used, it is dropped. `GET …/loads`
  returns `undo` — the sets that still hold for the page's places (a stale
  one is dropped there). `POST …/loads/only {key, agent, preview?}` — «this
  is Builder's alone», the two-sided set per family, project line first,
  then each agent's (`switchFolderLoad`): an override kind off in the
  project and on for the agent, every other agent's own «on» removed (an
  agent added later won't load it); an off-only kind on in the project
  (refused 409 when the machine keeps it off — off anywhere wins) and off
  for every other agent of the folder (one added later will). An agent
  that is not the folder's: 404, nothing written; a set that fails after
  the project's write puts the project line back. UI: `BulkHead` on each
  owner group's head and the tab's («Turn all off ▾ / on ▾», the sentence
  with its counts, «Undo»), «Make it <agent>’s alone» on an agent line of
  the block (`WhereItLoads`), and the Tools and Skills chips «off on this machine» /
  «off for an agent». The conversation's place — `scope: 'conversation'`
  - `conversation` (a session id; the server resolves its thread, 404
    none) — is an item of the bulk ▾ on its agent's page opened from it:
    items only (an account head has no conversation line: counted
    «cannot»), one payload kept under the thread, its set under
    `conversation:<thread>`, returned only by `GET …/loads?conversation=`.
    **On Skills** (T15) the same route takes `skills: [{name, from}]`
    (`from` account · personal · project · plugin — a plugin's is counted,
    never written) and `origins: ['skills']` — never
    with tools' `keys` or heads (400). The plan reads each skill's lines
    (`folderSkillPlaces`, a folder copy out in Silos' held store asked as
    `held`): an item where its line at the place has the position (`positions`,
    not `locked`/`refused`), «cannot» otherwise (a plugin's skill, a name
    settings can't store, a wider place's or your organization's say); a
    folder copy has no machine line — the machine's click never reaches it,
    uncounted. The write is ONE `Harness.loads.skillSwitchMany(input, items,
at)` — Claude Code (`loads/skills.ts claudeSkillSwitchMany`) collects each
    item's mutation from `claudeSkillSwitch` (its `collect` seam: rule 12, «on»
    only over a wider «off») and writes the local or the user file once; at a
    launch place it chains the payload and answers it once (each skill's own
    `at` under `skill:<name>`). A folder copy's project place is the held
    store: moved out, or back (`FolderLoadsDeps.skillStore`, server.ts over
    `skill-states.ts`). The account group goes by its head (`skills`, the
    tools' head path) and counts the account skills it reaches; in the column
    (no head line there) the account's skills are items. The undo set is the
    place's one set, `kind: 'skills'`: rows `<from>:<name>` with each entry
    before and after — any position, a hand value too (`name-only` comes back
    exactly) — and `store:<name>` for a moved copy; Undo puts the exact entries
    back in one write (`skillSwitchMany` with `entry`), moves the copies
    back, the head back. UI: `BulkHead` (`skills`) on each owner group of
    Project › Skills and Agent › Skills (the account group's `OriginHead`
    keeps its phrase and ▾, `bare`).
    The group heads of Tools, Skills, Memory and Files read the ORIGIN and
    nothing else (scope-ui review R1–R3, owner 24-11): `ownerOrigin` is
    «From» + the one place label of `lib/owners.ts` («From This machine»,
    «From Your Claude account · <login>», «From Project · <name>», «From
    Agent · <name>»), no glyph, no «Own / Inherited», no reach words (they
    live on the opened item and the block's lines); one control on the
    right — `BulkHead`, whose button names its place («Turn all off in this
    project ▾», «… for <agent> ▾»; ▾ items from `loads-places.ts
lineWords`), or the door to the house. ONE filter row, «From»
    (`OwnerFilter` over `lib/origin-filter.ts`: a chip per head with its
    count, counts under the «Only» row's choice), and the «Only» row of
    condition chips in `KnowsLibrary` (off on this machine · off for an
    agent · need your sign-in · different in «<title>» · Memory's types),
    shown only when a chip has rows.
- **The switches** (`Harness.loads.switch`; Claude Code:
  `harnesses/claude-code/loads/switch.ts` over the ONE writer,
  `harnesses/claude-code/local-settings.ts`; `POST
/api/folders/:folder/loads/switch {key, to}`, owner-only, managed folders
  only). A row carries `switch: {names, reaches?}` where the folder's local
  file decides it — the engine's exact names the click writes — or
  `refused` where it would but may not: `home` (the folder's `.claude` is a
  login's config dir: the folder is `$HOME` or lies inside `~/.claude`) or
  `engine` (the installed engine is older than `SWITCH_CONFIRMED_ON`,
  2.1.330, the release the newer keys were confirmed on — the GET reads the
  last compatibility verdict, the POST reads it fresh). Each kind writes
  exactly its key of `<folder>/.claude/settings.local.json`: a `.mcp.json`
  server `disabledMcpjsonServers`; a plugin `enabledPlugins` — `<name>@<mkt>`
  or, for one the account sends, `<manifest name>@synced` (`false` off; on
  drops the local entry, or writes `true` only when nothing beneath turns it
  on and its manifest starts it off); a plugin's server, a server of yours
  (`~/.claude.json`, read, never written) and a connector
  `deniedMcpServers: [{serverName}]` with the engine's name
  (`plugin:<plugin>:<server>`, `<name>`, `claude.ai <Name>`). A server
  several live plugins ship is one address the engine connects once, so its
  switch writes and removes every copy's name together (`reaches` names the
  other rows; the web says it before the click and asks to confirm); a deny
  by name takes a namesake with it, said the same way. Only a
  `{serverName}` entry naming exactly the name is removed; every other key
  and entry is kept; a click in the same direction writes nothing. No
  switch on the row → 409 saying what decides (managed settings, another
  file, the engine version, a home folder, a name only a tool id carries).
  The writer: contained `<folder>/.claude` (a link out refused), a home
  folder refused, an unreadable / non-object file refused untouched,
  atomic tmp+rename, the seal's read hash noticed and renewed, the file
  kept git-ignored through `.git/info/exclude`. Project › Tools draws the
  switch on each row (or, in its place, what decides — «set in
  .claude/settings.json», «needs Claude Code 2.1.330 · Update ›»); a change
  reaches new conversations only, said beside it.
- **The account origins' heads and rule 4** (`Harness.loads.switchOrigin`;
  Claude Code: `claudeLoadsOriginSwitch` in `loads/switch.ts`; neutral
  `folder-loads.ts switchFolderOrigin`; `POST …/loads/switch {origin:
'plugins'|'connectors', to}`). The inventory answers `origins`: per
  account origin, `on` here and `switch` — or `decidedBy` (managed or the
  user's `syncClaudeAiPlugins: false`; `disableClaudeAiConnectors: true` in
  any other layer) or `refused` (home; the plugins head below
  `SWITCH_CONFIRMED_ON`). «Off» writes only the origin key, «On» removes
  only it; the click is recorded in the tool-health ledger as
  `origin:<id>`, the switch time `switch-proof.ts` reads for the rows that
  origin holds (`heldHere.by: 'origin'`). **Rule 4**: an account plugin or connector row whose origin is
  off in the folder's own file alone keeps its switch («Add»); the click
  removes the origin key and writes the item-level off for every OTHER item
  of that origin known at the click — `enabledPlugins "<name>@synced":
false` for each other account plugin on disk (the added one's local
  `false` dropped, `true` only when nothing beneath turns it on; no hold is
  written on its servers: it comes whole), a `deniedMcpServers` entry for
  each other connector row (the added one's own entry dropped). **A
  login's list**: `folder-loads.ts` hands the engine `loginLists` — for the
  folder's agents' logins (`LoadsChecks.logins`) and the logins its readings
  and notices recorded, `ToolHealthLedger.connectorsOf` (`logins.json`) —
  and the inventory turns each list into connector rows (`connector:<login>:
<name>`, available where the origin or a deny keeps them off), so a
  project with connectors off still lists what it could add; with no list
  known there are none, and the account group keeps the connectors' head
  with «See what it sends ›». Project › Tools opens each Claude account
  group's plugins and connectors under their head (`OriginHead.tsx`, the
  skills head's component too: «Off in this project» · «Turn all on/off»); «Add» on a
  row of an origin that is off says first «Adds only <name> — the others
  stay off; what your Claude account sends later will load here» and asks
  to confirm.
- **Account skills and the three positions** (`Harness.loads.skills` /
  `skillSwitch`; Claude Code: `harnesses/claude-code/loads/skills.ts` over
  the same ONE writer; neutral `folder-loads.ts folderSkills /
switchFolderSkill`; `POST /api/folders/:folder/skills/:name/position {to,
from}` and `POST /api/folders/:folder/skills-origin {to}`, owner-only,
  managed folders only, both answering the refreshed catalog). What a
  Claude account sends sits under each login's own config dir,
  `skills/synced/<organizationUuid>_<accountUuid>/<name>/SKILL.md` — a
  batch per login, read by structure, matched to its login like the plugin
  batches (account id of a start's `session-owner`, else elimination, else
  «a login Silos can't match yet»); the config dirs are the machine's and
  every extra login's. The skills catalog (`complete-service.ts`, still the
  lister of skill rows) takes it through an injected reader bound in
  `index.ts` to the agent's engine: an entry per login's copy (`source:
'account'`, `account.login`), `active`, or `available` («could add») when
  `syncClaudeAiSkills: false` or its own position is off; a personal skill
  whose position is off is `held`; each carries `position` (as found),
  `switches` or `decidedBy` (another settings file, or `home`), `sameName`
  and, on account entries, the `origin`. A `seen` name that is an account
  skill (bare, or as the engine lists it, `<x>:<name>`) gives way. The
  project's switch writes `skillOverrides: {"<name>": "name-only" | "off"}`
  (on = no entry, or `on` over a wider «off» — T9 below) in the folder's
  local file — never the personal skills folder; `~/.claude/settings.json`
  only from a «This machine» line (T9); a value it does not write
  (`user-invocable-only`, a later engine's) is shown and kept; a non-object
  `skillOverrides` is refused untouched. The head writes or removes only
  `syncClaudeAiSkills: false` (read from managed, local and user settings —
  the schema says not from `.claude/settings.json`). Adding one account
  skill while the head is off (rule 4) removes the head key and writes
  «off» for every other account skill known, except a name a personal skill
  also carries. A shared name (measured, CLI 2.1.330): read from the local
  file, the entry hides only the personal copy; carried in the flag tier
  (an unattended turn, an agent's entry) it hides both — the row says «one
  name, two copies», each line of its «Where it loads» says which copies it
  reaches, and the confirm says it before the click. `sdkTurnSkills` (and the
  console's `consoleSkills`, which calls it) counts the login's batch — by
  the account id its `.claude.json` records (`oauthAccount.accountUuid`),
  else the only batch — then leaves out what the turn's layers and its
  flag-tier settings (what an unattended turn carries, `local-holds.ts`,
  and its agent's and thread's entries) turn `off` or leave
  `user-invocable-only`.
  `started-with.ts` files a listing line of an account skill under the
  account («Skill listing · Claude account») instead of a plugin or «no
  longer installed». Project › Skills draws the account group per login
  with its head («Turn all off» / «Off in this project · Turn all on») and `on · name
only · off` on every account and personal row; a click that reaches more
  than its row says so first.
- **A skill at every place** (spec scopes T9; measured CLI 2.1.331, the T1
  appendix). `Harness.loads.skillPlaces(input, asks)` answers one skill
  copy's lines (`LoadsSkillLine`: LoadsLine's grammar with three positions —
  `entry` and `result` are positions, `positions` what a click may pick,
  `reaches`/`unmeasured` the copies of a shared name an entry reaches);
  the catalog (`complete-service.ts withPlaces`) asks for every personal,
  account, folder (held or not) and plugin copy, saying what only Silos
  knows (`held`, `shadowed`), and hangs them on the entry as `at`. Claude
  Code's `loads/skill-places.ts`: `skillOverrides` is an override kind,
  precedence flag › local › repository › machine both ways, managed above
  all (every line locked); the account's head `syncClaudeAiSkills: false`
  off-only — off at the machine locks every narrower line, off in the
  project locks the agents (the project adds one by rule 4). A project
  skill has no machine line, its project line is Silos' held store
  (`store`), its agent lines only turn it off and lock while the copy is
  held. A plugin's skill and a name settings can't store (`__proto__`) are
  inert (`locked: engine`) and refused before any write; a skill with
  `disable-model-invocation` has ordinary lines (measured: an «off» at user,
  local and flag hides it). A shared personal+account name: the local entry
  reaches only the personal copy (its account copy's result ignores it),
  a launch entry both, the machine's and the repository's reach of the
  account copy is said «not measured»; a personal skill shadows a folder
  copy of its name (said under the block). `POST …/skills/:name/position
{to, from, scope?, agent?}` → `switchFolderSkill` → `claudeSkillSwitch(…,
at)`: rule 12 everywhere — what the place follows is no entry, «on» is
  written only over a wider «off» (the project's position no longer refuses
  a skill the machine or the repository's file names: it overrides it);
  `machine` one entry of `~/.claude/settings.json` through `editUserSettings`
  (the answer names logins that did not follow); `agent` the payload Silos
  keeps (`setSkillEntry`, the allowlist both ways), recorded under
  `skill:<name>` with its own time. The briefing's set (`sdkTurnSkills`,
  the consoles' `consoleSkills`, `carriedSkillKeys`) reads the launch's
  flag tier as T7's layer: an «off» drops every copy — a folder copy too —,
  an «on» restores over a file's «off» (not in a heartbeat), managed still
  wins.
  UI: `SkillPlaces.tsx` under the row's ▾ on Project › Skills and Agent ›
  Skills (machine asks before «off»; the project line is the page's own —
  a position or a hold; agent lines on a project page, the page's own on an
  agent page), `skillPlacesPhrase` on the row when places disagree. The
  conversation's line lives only in its column's Knows › Skills fold (T5,
  above), never on a page.
- **Unattended turns load what the screen says, and never more** (rule 14,
  spec scopes §6; T7 — it reversed, on purpose, the earlier «a hold only
  removes» premise: the project's files are the project's place, not the
  owner's local tweaks). Runs, wakes and rounds launch with
  `settingSources: ['user']` (or `['user', 'project']` with
  `projectSettings`), so a file the screen reads would not load in them;
  `headless.ts` builds the turn's flag-tier `settings` as an overlay —
  later wins for an override kind, lists joined: (1) what the launch always
  carries (the style, hooks off, the fence's `permissions`); (2) every
  settings FILE the turn does not read, fresh from disk, in the engine's
  own order — without `projectSettings` the repository's
  `.claude/settings.json`, then the local file; with it the local file (the
  machine's would ride first if a launch ever dropped `user`) —
  `harnesses/claude-code/local-holds.ts filesCarry`/`withFilesCarried`, for
  the spec's keys in BOTH directions: `enabledPlugins` booleans and
  `skillOverrides` (on · name-only · user-invocable-only · off) as written,
  `disabledMcpjsonServers`/`deniedMcpServers` (one per server)/
  `claudeMdExcludes` joined, `syncClaudeAiPlugins`/`syncClaudeAiSkills` only
  `false` (`syncClaudeAiSkills` never from the repository's file — the
  engine does not read it there), `disableClaudeAiConnectors` only `true`;
  no other key of any file rides (`permissions`, `hooks`, `env`,
  `enableAllProjectMcpServers`…), and a skipped file's override never rides
  over a file the turn reads above it; (3) the agent's entries; (4) its
  conversation's thread's (`ServerDeps.loadsCarried(agentId, sessionId)`:
  the resumed session's thread root by `threadIdOf`; a new conversation
  has none yet) — both through the allowlist. **Never more**: a heartbeat
  (with its tools or without) takes from (2), (3) and (4) only what removes
  — no plugin «on», no skill lifted, a carried skill at the most
  restrictive value any file gives it; and a skill name a personal skill
  and the account's share is carried from a file only where its entry
  restricts, at the most restrictive of the files, because a local entry
  reaches only the personal copy while the flag tier reaches both. The
  briefing's skill set follows the same carry: `sdkTurnSkills(…, flag)` →
  `loads/skills.ts launchSkillNames` — THE answer to «which skills does
  this launch load», read by the briefing's `has`, the «Your skills for
  this session» note (`preludeSkillNames(…, loads)`: a folder copy the
  launch does not keep is never named) and the consoles' `consoleSkills` —
  reads the turn's flag-tier settings as a layer between managed and the
  files it reads (local › project › user), first tier naming a skill
  decides both ways, for every copy: the folder's (when the launch reads
  `project`), the login's personal and account skills (when it reads
  `user`). A flag-tier entry hides a shared name's both copies, a local one
  only the personal; a name a personal skill and a folder copy share is
  left out when the personal copy is off (shadowing beyond that is not
  measured); `__proto__` takes no entry. OpenCode's twin: the launch's
  carried `permission.skill` denies (`deniedSkillNames`) leave its
  briefing's `has` like the held names do. Such a turn's
  status reading lands in the ledger with its `via` (`run` · `wake` ·
  `round`), so a Tools row says «read …, in a run of Builder». The engine
  facts are the smokes': `scripts/smoke-held-connector.mts` (per key, the
  attended launch against Silos' carried one) and `scripts/smoke-scopes.mts`
  (its `t-` cases: the «on» a run carries, the «on» a heartbeat does not).
  What it opens (spec §13): any shell in the folder can write the local
  file, so an agent can turn on, for its own runs, a plugin already
  installed or a skill already there — bounded by the allowlist, never into
  a heartbeat, and the seal shows the file changed.
- **The starting set — the birth seam** (`Harness.loads.startingSet`;
  Claude Code: `harnesses/claude-code/loads/starting-set.ts` over the one
  writer; neutral `server/src/starting-set.ts`). The engine declares its
  classes — id, what, from, Silos' recommendation by origin (Claude Code:
  `account-plugins` off → `syncClaudeAiPlugins: false`, `account-connectors`
  off → `disableClaudeAiConnectors: true`, `account-skills` on; what you set
  up on this machine has no class, always on). The install's own set lives
  in `~/.silos/settings.json` (`PlatformSettingsStore`, `startingSet: {
<engine>: { <class>: boolean } }`, an absent class follows Recommended;
  `GET/PATCH /api/settings`, a class the engine does not declare is a 400,
  `null` takes one back). A project is BORN when a folder is first given to
  an agent of an engine — as its folder or an extra one, a directory Silos
  made or one that existed — and no other agent of that engine has or had
  it (archived included). The seam runs where agents get folders:
  `POST /api/agents` and the role-pack install (right after the fence's
  `enableAtBirth`), and `PATCH /api/agents/:id` when it changes the folder,
  the extra folders or the engine. It writes each «off» key only where the
  folder's local file does not set it (a choice on disk wins), once: a
  second agent there is no birth, and an existing project is never
  migrated. It never blocks the birth: a home folder, a corrupt or
  unwritable file come back as `startWarn` (the agent's first minute says
  it with «Tools ›»; a role pack's report and a Settings save say it too).
  `GET /api/starting-set?framework=&folder=` feeds the New agent form's
  line: the set, whether the folder exists, and the agents it would join;
  with `facts=1` (Welcome's «At start») also `facts` — what you set up on
  this machine, counted, and per class the names its origin sends — read
  by `folder-loads.ts wouldLoad` (that engine's inventory and skills for a
  folder no agent has yet) and `starting-set.ts startingFacts`, each class
  saying what it `covers` (the account's `plugin` or `connector` rows, or
  its `skill`s). Welcome saves the set (`PATCH /api/settings`) before the
  agent, only when it differs from Recommended; Settings › Accounts &
  providers holds a switch per class. The new agent's first minute offers
  «Tools from your Claude account ›» while one of the folder's account
  origins is off — the project's Tools, at the account's group
  (`ACCOUNT_GROUP`, `lib/loads-view.ts`).
  The seam is wired with the settings store (always in `index.ts`); a
  server built without one has none.
- **Personal instructions per project** (`Harness.personal`; Claude Code:
  `harnesses/claude-code/personal-instructions.ts` over the one writer;
  neutral `folder-personal.ts`; `GET/POST /api/folders/:folder/personal
{to}`, owner-only, managed folders only). Project › Memory draws a switch
  on the «Your personal instructions» row; an engine without `personal` leaves
  it a fact. Off writes into the folder's `claudeMdExcludes` the exact
  entries `<config dir>/CLAUDE.md` and `<config dir>/rules/**` for EVERY
  login's config dir (`~/.claude` and each extra account's, from
  `AccountsService.configDirs()`): the engine names the User file by its
  login's config dir, not through the account's followed link, so one
  entry per login keeps it out whichever login runs here. On removes
  exactly those strings; every other entry and key is kept; `partly` = only
  some logins' entries are there (another Off covers all). One of the
  entries already listed in a login's `settings.json`, the project's
  `.claude/settings.json` or managed settings decides (a fact naming the
  file, 409 on a click); a home folder and an unreadable file are refused
  as every switch is. The engine drops `claudeMdExcludes` from a local file
  in a folder its host does not trust («can make these settings stricter,
  not looser» — read in the 2.1.331 binary), like the other per-folder
  keys. Unmeasured (schema text); the smoke's `personal-md` case observes
  it through the `InstructionsLoaded` hook (`memory_type: "User"`), the
  reading a proof (T13) would match the entries against.
- **Instruction files, every place** (spec memory-places T2/T3;
  `Harness.instructions`; Claude Code `harnesses/claude-code/instructions.ts`
  over `instructions-record.ts`; OpenCode `harnesses/opencode/instructions.ts`;
  neutral `folder-instructions.ts`; `memory-service.ts`; `GET /api/memory`
  `rows`/`places`, `GET|PUT /api/memory/file`). **The list**: every file a
  conversation in a folder loads, one row per REAL file, in the engine's load
  order — the organization's (`<managed dir>/CLAUDE.md`, its `.claude/rules`),
  each login's `CLAUDE.md` and `rules/**` (a login that keeps its own rules is
  named in `reach.notOn`; `rules` joins `accounts.ts FOLLOWED_DIRS`, so an
  extra login follows them like `CLAUDE.md`), every folder above (first below
  `/` to the parent; never a login's `.claude`), the folder's `CLAUDE.md`,
  `.claude/CLAUDE.md`, `.claude/rules/**`, `CLAUDE.local.md`, `AGENTS.md`
  (alone, or through an import), subfolders on demand (bounded: depth 6,
  2,000 folders, 60 files; no dot folder but a folder's own `.claude`, never
  `.git`, `node_modules`, a link or a login dir), imports to the engine's
  depth 5, and auto memory (the index and notes; moved by
  `autoMemoryDirectory` in managed, local or user settings — never the
  repository's — it is listed read-only naming that file). Each row carries
  its origin, engine type, reach (scope + the launch kinds that read it —
  console/chat read user+project+local, a wake and an isolated run
  user+project, a run without a folder user only: `LAUNCH_SOURCES`), when,
  and weight. Loaded-at-start's instruction list is now a projection of the
  same scan (`loadedInstructions`). **The reader** (`InstructionsReplay`):
  the transcript's `instructions` records replayed as the engine does — the
  last base (no `changed`), then each delta's `files` and `removed` —, plus
  `nested_memory` loads since the base; Started with's first turn and «now»
  both read it (a delta no longer stands for the whole set). No record is not
  «not read»: a start seen after the last record (a SessionStart hook
  followed by a reply, or a start the caller hands in) reads `unchanged`, one
  with no record ever `empty`, neither `unread`. Rows are weighed from the
  folder's 12 newest transcripts (followed per file: only appended bytes are
  read again), matched by real path — the engine names one file under each
  login's dir — and a file a record names that the scan missed is listed
  (`fromRecord`), judged by where it is. **The write boundary**: a write is
  allowed only on a row the server lists as editable for the page's folder
  (`folder`; else every ACTIVE agent's folder the path, or its asked form,
  lies in, then the machine's logins), or a new file at one of the list's
  fixed places — `<folder>/CLAUDE.md`, `<folder>/CLAUDE.local.md`,
  `<folder>/.claude/rules/<name>.md`, `<login dir>/CLAUDE.md`, `<login
dir>/rules/<name>.md` (one plain name), the default auto-memory dir, the
  agent's own memory. Editable: the login's two files (`confirm`: the request
  needs `confirmed: true`, else 409), the folder's own files and its
  subfolders', auto memory in its default place; read-only, saying why: the
  organization's, a folder above, an import, a moved auto memory, a link out
  of its root (`linkOut` — not even read through Memory), and, in a folder
  whose `.claude` is a login's config dir, everything but its `CLAUDE.md`.
  The client names a path, never a kind. Links resolved, backup before
  write under `memory-backups/<root segment>/<path relative to the root>`
  (`CLAUDE.md`, `.claude/CLAUDE.md` and `sub/CLAUDE.md` never share a
  folder), atomic write, owner only (agent-authz never lets a bearer write).
  The ignore line (`CLAUDE.local.md` in `<folder>/.git/info/exclude`) only on
  a create whose request says `ignoreLine: true`, and only where the place
  offers it — `<folder>/.git` a directory (a worktree's or a parent
  repository's git: `ignoreElsewhere`, nothing written). Archived agents are
  out of play. OpenCode lists what its launch passes, all read-only.
- **Personal instructions for one agent, for one conversation** (spec
  scopes T10). The launch places keep the CHOICE, never a path: the
  payload in `loads-scopes.json` (row key `personal`) holds
  `personalInstructions: "off"`, the one shape the allowlist
  (`loads/launch-entries.ts cleanEntries`) admits for the kind — a raw
  `claudeMdExcludes` in a payload is dropped. Every launch
  (`withLaunchEntries` with `loginDirs`: the chat/run/wake turn via
  `ChatDeps.loginDirs`, the console via `TerminalService.ensureConsole
loginDirs` from the claude server hooks, a check with its own login)
  turns it into `claudeMdExcludes` = every login dir's `CLAUDE.md` +
  `rules/**` read from `AccountsService.configDirs()` AT THAT LAUNCH, joined
  with what the launch already excludes; the choice key never rides as
  itself. So a login added after the click is covered. A heartbeat carries
  it (a removal). `Harness.personal.places` answers «Where they load»:
  organization/repository facts, the machine (no Silos switch — the file
  itself, door Settings › Memories), the project's local file (today's
  switch, unchanged), each agent and, asked, one conversation; off-only —
  a line below an «off» with no entry of its own is locked, and its «off»
  is refused (409). `Harness.personal.switch(input, to, at)` with a launch
  place returns the new payload and writes nothing; `folder-personal.ts`
  keeps it. Routes: `GET …/personal?agent=|?conversation=`, `POST
…/personal {to, scope: agent|conversation, agent|conversation}` (the
  thread resolved by the server). UI: the CLAUDE.md row's ▾ opens
  `WhereItLoads` (kind `personal`; its project line writes through the
  page's `onFile`); an agent's Memory switches it for that agent only and,
  opened from a conversation, its block gains that conversation's line
  (a second `…/personal?conversation=` read) with its switch and the
  when-words (no proof yet: `claudeMdExcludes` is schema-only, T1); the
  column's Memory line says «your instructions off here» while they are.
  OpenCode declares no `personal`: no line anywhere.
- **Every instruction file's places** (spec memory-places T4;
  `Harness.instructions.places`/`.switch`; Claude Code
  `harnesses/claude-code/instruction-places.ts`; neutral
  `folder-instruction-places.ts`; `GET /api/folders/:folder/instructions
?agent=|?conversation=`, `POST … {path, to, scope, agent|conversation,
confirmed}` — owner-only, the path judged against the engines' own list,
  404 for one they don't list). Two families, measured per tier by T1 on
  2.1.331. **A file** (personal, personal rule, folder above, project,
  project rule, `CLAUDE.local.md`, subfolder, import, `AGENTS.md` — alone
  too) is off-only through `claudeMdExcludes`: the project line writes the
  row's OWN strings into the local file through its one writer and removes
  only them (a personal file once per login dir; a folder's file as its path
  AND `<folder>/.claude/worktrees/*/<rel>`; a file outside the folder and
  the login dirs, its path); every foreign entry is kept. A pattern in a
  file Silos never writes (managed, a login's `settings.json`, the
  repository's) that matches the row — the engine's matcher, picomatch with
  dot files on; a `!` matches every file (measured: it re-includes nothing)
  — is a fact, the lines below locked; one in the local file that Silos did
  not write refuses the project line, naming it. An import follows its
  parent (`locked.parent`). **Auto memory** (its index row) is an override
  kind through `autoMemoryEnabled`: This machine (the user's `settings.json`,
  its «off» refused without `confirmed` — the line `asks` the machine
  sentence; the logins that follow the file are asked after), This project
  (the local file), each agent and conversation; an entry is written only
  where the place differs from what it follows (rule 12); managed settings
  lock every line. **The launch places** keep the choice in the payload —
  `instructionsOff: [{personal: rel} | {in: folder, file: rel}]` and
  `autoMemoryEnabled` — under the allowlist `cleanEntries(payload,
{loginDirs, folders})`: an instruction entry survives, in and out, only
  with that context, a relative normalized path without `..` or a glob
  character naming one of the engine's files, and `in` exactly one of the
  folders (at a switch: the folder whose agent it is; at a launch: the
  folder it starts in). Without context every instruction entry is
  dropped; a raw `claudeMdExcludes` always is. A write of another kind keeps
  them by shape (`keptEntries`) — every setter, and the tools/skills switch
  paths, so a click elsewhere never loses them. `withLaunchEntries(…, {cwd,
loginDirs})` expands a personal entry for every login dir and a folder's
  for the folder the launch starts in — and its worktree root when it
  starts in `<folder>/.claude/worktrees/<name>` (`launchFolderOf`); chat,
  run and wake (`headless.ts`), console (`console.ts`, cwd from
  `TerminalService`) and a check pass their cwd. **Carried** (rule 14):
  `filesCarry` adds `autoMemoryEnabled` from a skipped file (an override
  kind: never over a file the turn reads above it; a heartbeat only
  `false`, and `removalsOf` drops a payload's `true`); a launch started in a
  worktree carries the folder's own local `claudeMdExcludes`, each exact
  path also said for the worktree root (`worktreeCarry`, console too). UI:
  Project › Memory and Agent › Memory draw the plain switch (the page's own
  place: Project · <name> / Agent · <name>) and ▾ «Where it loads»
  (`knows/InstructionPlaces.tsx` over `WhereItLoads`, kind `instruction` /
  `auto-memory`; its file lines write through `onFile(to, scope,
confirmed)`) on every row `GET /api/memory` lists (`lib/memory-rows.ts`:
  owner and head qualifier — «a folder above», «private to you», «auto
  memory» — the reach phrase, the weight as loaded or «on disk», amber over
  the engine's 40k warning), the amber phrase from `placesPhrase`, and an
  inert line saying why where a row has no place (the agent's own memory,
  the organization's files, a note, an import from outside). The machine's
  own `CLAUDE.md` keeps the personal head switch (`Harness.personal`).
  OpenCode declares no `places`: no line.
- **Memory rows: editor, Write instructions, Settings** (spec memory-places
  T3 UI). A row opens `MemoryDetail` with the page's folder (the read and
  the write are judged against that folder's list); a read-only row says
  why instead of Edit; Save names its reach (`saveWords`: «Save — for every
  project on this machine» asks first through `MachineSaveConfirm`, «… for
  every agent here», «… for <agent> only»). «+ Write instructions»
  (`knows/WriteInstructions.tsx`) offers the list's fixed `places` with
  their labels and reach; an existing file opens its row, a rules folder
  takes one plain name and an optional `paths:` line; the ignore line is
  said and sent only where the place carries `ignoreLine` (`<folder>/.git`
  a directory), `ignoreElsewhere` says to keep it out of commits by hand.
  Settings › Memories lists the machine's rows from `GET /api/memory` with
  no folder — personal rules editable there, the organization's read-only.
- **A folder above at the launch places** (spec memory-places T5, the T4
  open question). A file in a folder above the agent's folder takes the
  agent's and the conversation's lines as `{in: folder, above: <absolute
path>}` (`launch-entries.ts aboveFileOk`): admitted only as the scan
  lists such a file — absolute and normalized, in a strict ancestor of
  `in` other than `/`, one of the names the engine reads there, never under
  a login dir — and judged again at every launch against the folder it
  starts in (its worktrees included), riding only while the file exists.
  An import from outside the folder stays the project's line alone: what
  makes it load is another file's text, which a launch would have to read
  again to judge.
- **«This conversation» for instruction files, and its proof** (spec
  memory-places T5; owner rule: the column has no switches). The line lives
  on the agent's Memory tab opened from the conversation
  (`agent/from-conversation.ts`): `InstructionPlaces` reads `…/instructions
?conversation=` beside the agent's read and puts that line last in the
  row's block, its click `POST … {scope: 'conversation', conversation:
<session id>}` (the server resolves the thread). Its when-words come from
  the line's `here`, set by `folder-instruction-places.ts` from
  `switch-proof.ts instructionEntryState`: the engine reads the THREAD's
  own transcripts (`Harness.instructions.reading`, Claude Code over the one
  replay — the session that last started or recorded is in force; one with
  starts and no record ever loaded nothing), starts come only from start
  MARKERS after the entry's own `at` — the record's SessionStart hooks
  followed by a reply, and the turn ledger's process starts
  (`toolHealth.readings` of the thread's sessions) — never from an
  instructions record. No start since: `pending`. After one: an «off» file
  still in force is «still loaded — the switch didn't take» (a start with no
  record keeps the earlier record: the set did not change); gone — a
  `removed`, a new base, a fresh session with no record — is in effect. An
  on-demand file is proven only by a `nested_memory` load after such a
  start; its absence leaves the when-words. Auto memory's «on» absent while
  its index exists did not take. The column's Knows › Memory says «N files
  off here · n didn't take» (`knows-here.ts instructionsHere`) as one
  summary line and its door. The conversation's entries ride the thread's
  record in `loads-scopes.json` and its sweep.
- **The turn's status and the ledger** (`harnesses/claude-code/turn-status.ts`,
  neutral `tool-health.ts`). Every turn Silos runs through the SDK asks
  `Query.mcpServerStatus()` of its own process on its first assistant or
  tool message, and once more on a later one when a server was still
  connecting — never awaited: the turn's messages pass unchanged, an answer
  after the result is dropped (a single-prompt turn's process exits), a
  query without the method or one that throws records nothing, a heartbeat
  without its tools (strict, no servers) asks nothing. The engine hands
  over each row without its `config` (URLs, headers — secrets): only «has
  no address» (no `url`, no `command`: a placeholder, by structure). The
  turn's login is its start's (`session-owner`/`session_context` in the
  transcript head); `connectorsOn` says whether the process fetched the
  account's connectors (no layer it reads sets `disableClaudeAiConnectors`,
  a Claude login, not strict). `ChatTurnHooks.onToolStatus` hands it to the
  ledger: `<dataDir>/tool-health/<sha256(folder)>.json` (0600, dir 0700;
  outside the seal — an observation, never authority; in
  `DATA_DIR_DENIED`): per folder and login the last 20 readings, one per
  conversation (its newest), `{at, login, from, conversation, agent, via,
servers: [{name, status, reason, source, scope, tools, noAddress}]}`;
  per login and failing server its unbroken run (`since`, `count`, once
  per turn — kept past the cap; `pending` neither breaks nor extends it, a
  placeholder is never one); and `logins.json` — each login's connector
  list, replaced only by a reading taken with connectors on. A reason is
  untrusted: cut at the first markup, URLs to their host, credential-like
  strings removed, 160 characters — before it is stored. `GET …/loads`
  hands the readings to the inventory (engines that declare
  `loads.readsStatus`) and gives each server or connector that a
  conversation dials its `health` — the newest reading listing it, on its
  login for an account row, with who read it (`via`, the agent's name). A
  placeholder, a shared address, a copy standing aside and what is off have
  none. Each Tools row says it under its own line («connected · 26 tools ·
  read 2h ago, in a chat of Builder», «needs your sign-in», «didn't start —
  <reason>», «still connecting», «off in Claude Code», «not read yet»); a
  plugin row counts its servers; Agent › Now's Tools door says what needs
  you, else «all connected».
- **Start notices and counts** (`harnesses/claude-code/context.ts
startNoticeOf`, neutral `start-health.ts`). A conversation's start
  notice is its NEWEST start's deferred-tools delta, kept in its parsed
  context (`SessionContext.start`, the session cache — `CACHE_VERSION`
  49). A start writes its delta, then its initial `skill_listing`, before
  any reply: that listing marks a later start (a console restarted, a chat
  resumed), whose own delta replaces the notice — or, when it wrote none,
  a clean notice (a start without a failure record has no failure; the
  old one does not carry over). A delta after a reply is the tool set
  changing mid-conversation and never replaces it. The notice carries
  `failedMcpServers` with the reason cleaned as the ledger cleans it, a
  chat's `needsAuthMcpServers`, and a console's sign-ins — it lists none,
  only each waiting server's `authenticate`/`complete_authentication`
  tool pair, whose names give the tool-name id (`mcp__<id>__authenticate`:
  the fixed prefix and suffix cut, the id never split) kept as
  `needsAuthIds`. `GET …/loads` hands the inventory the notices of the
  folder's listed conversations (newest 40; a trashed one is no longer
  listed) with the login each recorded; the inventory adds an observed row
  for a notice's name nothing declares and returns the notices with every
  name the engine's own (an id resolved through `names.ts`, kept as its
  id row when no known name has it, dropped when two do). Counts prefer
  status readings: a failing row says the kept run («didn't start the last
  12 times · since 3 Nov» — it holds past the cap), a row that failed in
  some of the window says «3 of the last 20 times». A row no reading lists
  takes its health from the newest notice of its login that names it
  (`read.from: 'notice'`) and its count from the notices, labelled «from
  start notices — they name some failures, not all» (and «console starts»
  when all were); a newest notice that does not name it claims nothing.
  An account row counts only its login. Placeholders, shared addresses
  and `pending` are never counted. Trashing a conversation calls the
  ledger's `forget`: its reading leaves the window and what it gave a
  failing run (per-conversation tallies, the newest 50) leaves the run.
  `FolderLoads.basis` (readings, notices, consoles) lets Tools say, in a
  project with notices only, «Only consoles ran here: health comes from
  their start notices — they name some failures, not all · Check now ›»
  — a door to the Tools head's check.
- **A switch proves itself** (spec tools-origin §2 rule 7, §7 «Proof»;
  neutral `switch-proof.ts`). The engine marks each row its project's own
  switch file turns off (`LoadsRow.heldHere`: `item` — its own entry —
  or `origin` — the origin's key, `disableClaudeAiConnectors` /
  `syncClaudeAiPlugins`) with the exact names a status reading would list
  if it still loaded — a server's or connector's own name, a plugin's
  servers' (placeholders included: present means loaded) — and says when
  that file changed (`HarnessLoads.switchesChangedAt`: Claude Code's
  `.claude/settings.local.json` mtime). The mtime is coarse (any key, by
  anyone), so the one writer's path (`folder-loads.ts switchFolderLoad`)
  records each row it switched — `{key, to, at, mtime}` in the folder's
  ledger file, the newest 50, kept through the ledger's own writes and
  `forget` — and while the file still has the newest record's mtime
  nobody else wrote it, so a row Silos switched off has its own time;
  every other case (a hand edit, an origin head, a skill's position,
  Claude Code writing the file) falls back to the mtime, never earlier
  than the real change. A turn's status reading, a check or a start
  notice counts from when its process STARTED (`TurnToolStatus.started`,
  the check's start; a notice is taken at the start), so a turn already
  running at the click proves nothing. A reading after the change that
  lists one of the names with a status other than `disabled` — on the
  row's login for an account row, and not a name another row loading
  there explains (the same plugin installed and sent) — gives the row
  `proof: {name, status, by, read}`. Tools draws an amber line under it,
  «still loaded — the switch didn't take · read 20 min ago, in a chat of
  Builder», with its way out: an account item off by its own name points
  at its group's head (the origin's key depends on no name); every row
  offers «Check now ›», a door to the Tools head's check — never a fix
  made for him. Opened, the row says which name was listed and why it
  may not have taken. Skills cannot be proven: a status reading lists
  servers only, so a skill's position and a plugin with no server carry
  no proof.
- **Proof per place** (spec scopes §7, T12; `switch-proof.ts
withPlaceProof`). The engine marks on a row what each place other than
  the project expects (`LoadsRow.expect: [{scope, agent?, conversation?,
to, names}]`, Claude Code's `places.ts expectsOf`): the MACHINE only
  where its entry is what decides for the project — never where a
  narrower file, a fact (the repository's file) or the project's own entry
  turns it back by right — and each agent or conversation line that holds
  its own entry and can change the result. A reading counts for ONE place:
  its thread's or its agent's line where either holds the row
  (`holderOf`), else the machine. It counts from when its process started,
  after that place's own change: the machine's — its own switch record
  while the user file still has that record's mtime, else the file's mtime
  (`HarnessLoads.machineChangedAt`); the machine writer's path now records
  `{key, to, at, mtime}` too, keyed by place, in the ledger's
  `machine.json` (one user file for every folder; `forget` leaves it) —
  an agent's or a conversation's entry, its own `at` in
  `loads-scopes.json` (one time per entry: a later click on another row
  moves nothing). The newest reading that counts decides: an «off» still
  listed (not `disabled`, no other row loading for that reading explains
  the name), an «on» listing none of the names — a status reading only (a
  start notice names failures alone; it reaches the machine only on a row
  no launch place holds, as it carries no agent) — gives that place's
  line `proof: {to, name?, status?, read}`. A holder's reading — an agent
  or a thread whose own line has an entry (`tool-health.ts heldBy`) —
  never marks the project's line nor its health and count. `expect` is
  the proof's input only: `folderLoads` never sends it (it names every
  agent that holds the row). Tools draws one amber line
  per proven place under the row — «still loaded for Builder — the switch
  didn't take», «didn't load for Builder — its own “on” didn't take»,
  «still loaded — this machine's switch didn't take» — an agent's page
  only its own agent's and the machine's; the place's line in «Where it
  loads» says «didn't take» too. A conversation's thread comes from the
  session id through `FolderLoadsDeps.threadOf` (the id itself until the
  conversation place's resolver is handed in); the column's «still loaded
  here» is `placeProofWords(row, now, {here: thread})`.
- **The door, the alert, the sign-in** (spec tools-origin §9; neutral
  `start-health.ts problemsOf`/`rowOfServer`, `folder-loads.ts
conversationProblems`). A door names a ROW KEY the inventory made, never
  a name the screen derives. `GET /api/sessions/:folder/:id/started-with`
  adds `problems: [{kind: failed | needs-auth, name, label, row?}]` from
  THIS conversation's own reading — its turn's status reading in the
  ledger (a chat), else its start notice (a console; its notice is handed
  to the inventory even past the newest-40 cap, so its names resolve) —
  each placed on the row of that name that loads here (active, no other
  copy standing in for it, on the conversation's login for an account
  row): the account copy when the installed one is off, the observed
  `seen:` row when nothing declares it. An entry with no address, a
  placeholder row and the same server as another are never a problem, and
  neither is a row the owner turned off (owner 24-11: its `state` is not
  `active` — held, or its origin off here —, so of course it didn't start;
  a held sign-in has nothing to sign in to): the alert counts only live
  failures. A folder that is no project gives names without `row` (no
  door). The conversation column folds them into ONE line («webstats
  didn't start», «1 tool didn't start · 14 need your sign-in»; amber only
  when something didn't start — when only sign-ins remain, a quiet line),
  unfolded to each failing name with «Turn off ›» to its row
  and one sign-in line to Tools narrowed by the «need your sign-in» chip
  (one sign-in opens its own row). These doors leave the column the way
  the Knows doors do: `openDossier('tools', {item | filter})` — the
  agent's Tools tab carrying the conversation (`agentFrom`, `?from=`), the
  row by the store's `dossierItem`/`dossierFilter` (cleared by the next
  tab move); a conversation of no agent falls back to the project's Tools
  (`goHome`, `projectItem`). The column reads the problems' rows now
  (`GET …/loads?conversation=`): a row whose conversation line says off
  (no line: held in the folder) is said «turned off» with no «Turn off»
  (`StartedWithBlock heldNow`). A Tools row opens by its
  exact key only — KnowsLibrary's plugin-name fallback is gone; a plugin
  skill's «Tools in <project> ›» passes the key of the copy of its plugin
  that loads (`loads-view.ts pluginRowOf`). A row waiting for a sign-in
  offers the ENGINE's door, set on each row by its harness
  (`LoadsRow.signIn`, contract `LoadsSignIn`; Claude Code's in
  `harnesses/claude-code/loads/sign-in.ts`, walked on a real install
  24-11): `console` — «Sign in ›» (the store's `askSignIn`), a NEW real
  console of an agent that starts in the folder (`lib/home.ts
signInAgentOf`: the one whose conversation read it, when it starts
  there, else the first; archived and the inbox never; none: no door).
  Only the interactive console hands a waiting server the engine's
  `authenticate` / `complete_authentication` tools — an Agent SDK chat has
  none (measured 24-11, CLI 2.1.330). The row's `draft` names the server
  by the engine's exact name and asks for that tool and its link; Claude
  Code has no documented way to prefill an interactive prompt without
  sending it, and Silos never types into a console for the owner, so the
  sentence sits above the new console's pane (store `consoleCue`,
  `ConsoleCue.tsx`) with a copy button and the next step: the link's
  redirect is `localhost` on the machine running Claude Code, so a browser
  elsewhere ends on a connection error and its address is pasted back
  into the console. The cue follows that console to the conversation it
  becomes (`pinConsoleCue`, by the key it was born with), never another;
  a new conversation or its × drops it. A row known only by its tool-name
  id names no server a sentence could ask for: its door (`menu`) is
  «/mcp in a console ›», the same console with `/mcp`, the engine's own
  menu of its servers, beside it. `link` — «Connect in claude.ai ›», a
  claude.ai account connector, which is connected in claude.ai ›
  Settings › Connectors and never from a conversation (a new tab,
  `rel=noopener`). The door shows on every row whose
  line says it waits, folded or flat (`loads-view.ts signInDoorOf`): a
  plugin row whose server waits carries that server's door, several
  waiting unfold to them. A problem carries its row's door, and the
  alert's sign-in line and the «need your sign-in» chip take the one
  outside page when every sign-in goes there (`sharedLink`) — a mixed set
  goes to Tools narrowed, each row with its own door.
- **At start's MCP list.**
  Knows › At start's MCP list (`GET /api/agents/:id/loaded`) is the
  inventory too (`loaded-at-start.ts mcpOfInventory`): the rows that load,
  an account's only on the agent's login (a batch no start matched only
  when it is the only one), then the agent's own servers. The login
  helpers live in `loads/start-logins.ts` (shared, no import cycle).
- **Started with, placed by the inventory** (`started-with.ts
startPlacer`). The route hands the measure the folder's inventory rows
  (`StartedWithContext.loads`, cached 20 s per folder beside Loaded at
  start). A tool-name id is resolved against the known names — the rows,
  what loads at start, and the names the transcript lists (server
  instructions, failed and pending servers) — through `loads/names.ts`,
  never cut at an underscore; an id no name has, or one two names share,
  keeps the id as its label. A resolved name takes its row: its owner
  (an account plugin's server is the account's), its label, its plugin
  (`group`) and its key (`item`); of two copies of one plugin, the one the
  inventory says loads. A plugin's skill and subagent listing lines and its
  start hook are their plugin's part, owned the same way. The servers'
  instruction blocks (`mcp_instructions_delta`) join their server's part —
  the measured total is unchanged, only its split moves. `StartedWith`
  carries `loadedNames`, the exact names its first turn carried.
- **Weight** (`GET /api/folders/:folder/loads/weight`, owner-only, in
  `routes/agents.ts` beside the follower): the newest measured start in the
  folder (one transcript, the same followed feed), its tokens summed per
  `item`. Tools rows show it (a plugin: its own parts plus its servers',
  `web/src/lib/loads-weight.ts`), the opened row what each piece took.
  Nothing measured shows nothing, never an estimate in its place.
- **Projected weight** (`POST /api/folders/:folder/loads/projected {key}`,
  owner-only — a POST because it starts the engine's CLI, so it needs the
  owner's identity, and agent-authz refuses a bearer; neutral
  `folder-loads.ts projectFolderLoad` → `Harness.loads.projected`,
  `projectedBy`). A plugin row this project does not load (not `active`),
  opened, with no measured weight: «Would add about 2.1k tokens to every
  start — Claude Code’s estimate». On Claude Code
  (`harnesses/claude-code/loads/projected.ts`): `claude plugin details
<id>` — documented, no session, no prompt — run like `claude auth status`
  (the PATH `claude`, an env built from nothing plus the row's login's
  `CLAUDE_CONFIG_DIR`, in the folder), killed at 8 s, ONE at a time
  machine-wide. Its output is a table for people, so Silos reads one line —
  «Always-on: ~N tok added to every session», right under «Projected token
  cost» — and only on an engine version that line was confirmed on
  (`PROJECTED_CONFIRMED_ON`, 2.1.330); any other version, an unreadable
  output, a refusal or the bound shows nothing. Every count stays the
  manifest's (`carries`) — its MCP count includes placeholders and leaves
  out tool schemas. A figure is kept in memory per login, plugin id,
  version (the install entry's; an account copy's manifest version) and
  engine version; a timeout or refusal is not kept.
- **The check** (`harnesses/claude-code/loads/check.ts`, neutral
  `loads-check.ts`; `Harness.loads.check`, `checkCost`, `sends`; as one
  agent on its page: «The agent's page», above). «Check
  now» in the head of Project › Tools — the owner's click and only that:
  no timer, no cadence, never at a birth or after a switch, never from an
  agent's bearer (`GET|POST /api/folders/:folder/loads/check`, owner-only
  through the agent-authz allow-lists; managed folders only). One button
  per login the folder's live agents run on by default (their provider,
  fallback not applied), naming it (the account's email when Settings knows
  it, else the provider's name) with its cost beside it; one check at a
  time per folder (409). The engine starts ONE `claude` through the SDK
  `query()` in the folder: the prompt is a stream that never yields (no
  turn, no model request, no tokens), `persistSession: false` (no
  transcript), `disableAllHooks` in the flag-tier settings — the hooks an
  organization's managed settings impose still run, the engine runs them
  under any `disableAllHooks` a user can set —, the login's env
  (`envForProvider`) and the given agents' role plugins (their own tools
  are read too). It asks `initializationResult()` (the login it really
  runs on: `account.email`) and `mcpServerStatus()` — again every 750 ms
  while a server is `pending` — and closes the process on the answer or at
  the 20 s bound (no answer: refused; servers still connecting: kept as
  pending, said «some were still connecting at 20 s»). Its cost: one
  `claude` for some seconds, every server of the project dialed once
  (OAuth discovery and client registration included, stdio servers
  spawned and killed), the login's connector list fetched. The reading
  lands in the ledger as `from: 'check'` («read …, in a check» on the rows).
  **«See what it sends ›»**: on a Claude login whose account sends things
  (`sends().account`) that this folder doesn't fetch (`disableClaudeAiConnectors`
  in a layer it reads) and with no account row in the inventory — an
  account group off with nothing to list — the same check runs without the
  folder's local layer (`settingSources` user + project): the engine fetches
  the connectors (and downloads the account's plugins and skills to its own
  tree), nothing is written to the folder, and the reading is no reading of
  the folder — only the login's connector list is kept (`logins.json`,
  `ToolHealthLedger.recordSends`). Its wall time and memory are to be
  measured once by hand; until then the cost sentence is a placeholder
  constant (`CHECK_COST`).

**How the plugin reaches a session** — never as one plugin: Silos does not
pass `plugin/` to any engine as a plugin. The only `--plugin-dir` (console)
or SDK `plugins` entry (chat) is the agent's own role plugin
(`~/.silos/agent-state/<id>/plugin`, its role skills and its
**own MCP servers**: the plugin's root `.mcp.json`, which Claude Code reads
from every plugin it loads — SDK `SdkPluginConfig.skipMcpDiscovery` unset;
`agent-tools.ts`). Active
servers sit in `.mcp.json`, held ones in Silos' `.silos-held.mcp.json` beside
it (no engine reads it) — the folder's active/held grammar; `rolePluginFor`
passes the plugin when it has a skill OR an active server, so console, SDK
chat, automation runs and rounds with tools get them with no new plumbing; a
heartbeat without tools keeps `strictMcpConfig` (none). OpenCode gets the
same servers in its `OPENCODE_CONFIG_CONTENT` `mcp` as `<id>_<name>`, refs as
`{env:NAME}`. A config never holds a secret: env/header values are
`${VAULT_NAME}` (a `validateEntryName` name, never `SILOS_*`), expanded from
the Vault env every launch already carries. Fenced with no new rule (other
agents' state dirs; `OWN_PLUGIN_DIR` Edit-denied to the agent itself); the
routes `/api/agents/:id/tools` are the owner's. Each piece arrives
by its own door:

- **Claude Code hooks** — Settings › Engines › Claude Code › _Silos hooks_ ›
  Install hooks writes the SessionStart and the CronCreate entries into the
  machine's `~/.claude/settings.json` (`harnesses/claude-code/settings.ts`
  `installSilosHooks`), each command the shell-quoted absolute path of
  `plugin/hooks/<script>` in this checkout (`server/src/repo-paths.ts`);
  **Uninstall**, on the same row, removes exactly those commands and
  nothing else (`uninstallSilosHooks`, `DELETE /api/claude-settings/hooks`).
  A `settings.json` that is a symlink is written through to its real file,
  never replaced (`editUserSettings`, the file's one writer);
  extra Claude accounts follow that file key by key (`accounts.ts`). Every
  `claude` on the machine then runs them — Silos' consoles and SDK chats
  like one started by hand. Until the owner clicks it no Claude session
  gets the hooks' briefing, birth marker, inbox or cron gate (a console's
  own `--settings` carries only Silos' `/clear` rotation and context-news
  hooks). The row reads _installed_ only when the command points at a
  script that exists; a moved or re-cloned checkout reads _broken_, says
  so, and Repair rewrites the path in place. `plugin/hooks/hooks.json` is
  used only when someone loads `plugin/` by hand (`claude --plugin-dir`).
  Unattended SDK turns that run with hooks off get the briefing from the
  server in their system-prompt append instead (`headless.ts`).
- **Claude Code skills** — a copy in `<folder>/.claude/skills/<name>`,
  made when the owner adds a Silos skill to the folder (the agent's skills,
  state _available_ › Add — `skill-states.ts addSkill`) or by hand. A new
  agent's folder has none until then. Copies follow each release while
  nobody edited them (`skill-install.ts`: a copy whose directory hash is in
  `plugin/skills/releases.json` is an untouched release — the hash covers
  every file a sync replaces, and a SKILL.md-only skill hashes as that file;
  `scripts/skill-releases.mjs` only ever adds to that list, so a squashed
  history never orphans an install); a personal copy in `~/.claude/skills`
  is the operator's — Silos only names a stale one. A skill entry that is a
  symlink to a directory counts as the folder's skill, as the engine loads
  it, and is never replaced by a copy (this repo links its own
  `.claude/skills/team-plan` to `plugin/skills/team-plan`).
- **OpenCode** — nothing to install: every OpenCode process Silos launches
  gets `plugin-opencode/silos.ts` as its plugin and `plugin/skills` as a
  `skills.paths` entry through `OPENCODE_CONFIG_CONTENT`, and the briefing
  as an `instructions` file (`harnesses/opencode/launch.ts`, `assemble.ts`).
  The Claude hooks do not run there; the plugin is their twin for births
  and asks, and the CronCreate gate has no counterpart.

**Secrets in an agent's environment** — the rule: what a launcher hands
an engine PROCESS for the engine itself never reaches the agent's shell
with a value, and the owner's credentials reach no process at all.
`SILOS_TOKEN` (the owner's token, read once at boot) leaves `process.env`
right after (`env.ts` `OWNER_CREDENTIAL_ENV`, `scrubOwnerCredentials`),
`cleanEnv` never passes it, and a tmux server that still holds it in its
global env loses it before the next console (`terminal-service.ts`). On
OpenCode the plugin's `shell.env` keeps only the agent-facing `SILOS_*`
names (`AGENT_SHELL_SILOS_ENV`) and blanks every other `SILOS_*` — the
provider key `SILOS_PROVIDER_KEY` among them — and the TUI server password
(`plugin-opencode/README.md`); Vault entries may not be named `SILOS_*` so
they are never caught by that rule. Known limits: on Claude Code a
gateway's key rides `ANTHROPIC_AUTH_TOKEN` in the `claude` process and so
reaches its Bash tool (Claude Code's own `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`
would also strip `SILOS_AGENT_TOKEN` and Vault entries, so Silos does not
set it); and on both engines a shell of the same Unix user can read the
engine process's `/proc/<pid>/environ` (the fence denies the file tools
that path, not an interpreter) — blanking keeps secrets out of dumps and
transcripts, it is not isolation.

**Reading transcripts and listing sessions — never a freeze** (Silos).
The server is one event loop that also relays the owner's live
consoles, so no read of a transcript runs as one long synchronous stretch:
every whole-file or large-range read (a refresh, the first read after boot,
a subagent track, the conversation's turns, Usage's records, the audit's
tool calls, the document viewer, Started with) goes through
`server/src/jsonl-lines.ts` — slices of at most 128 KB of lines or ONE line
(a heavy line crossing the mark goes alone in the next slice), cut at
newline bytes, decoded once, the loop released (`setImmediate`: timers and
I/O run between two slices — a stretch is one slice's cost) between slices;
a range of one slice or less stays synchronous (the common few-KB refresh).
Started with (`Harness.startedWith()` → a feed, contract.ts) is FOLLOWED:
each conversation keeps its feed and the offset fed, a request feeds only
what was appended (the reading equals one pass over the whole file), and
concurrent requests share one read (`routes/agents.ts`). Each line
is parsed once and the record fed to both accumulators. What a reader sees
mid-read is the LAST COMPLETE state: the Claude reader publishes the meta
(and keeps the context frozen) only when a read completes; a transcript
first seen is unknown (no row, `getMeta` null) until its first read ends;
a caller that needs the new state awaits `refresh()`. One read per file at a
time (a watcher event, a request and warm-up coalesce into one queued run).
The listing is kept, not rebuilt: the reader's `list()` and the index's
`allSessions()` are one array per reader `revision()` (contract.ts), and
`SessionIndex.metaById` is an O(1) read of it — the walk every surface shares
(ancestry, owners, thread root) looks ancestors up there. The session cache
(`<dataDir>/cache/sessions.json`) re-serializes only the entries that changed
and is written asynchronously. Still synchronous by design: a buried
transcript's facts (`trash.ts buriedFacts`, read at most once per buried
conversation per process — `trash-read-once.test.ts` — inside the
synchronous owner rule) and the first write-down of each continuation's
owner (`lineage.json`, once per session ever).

**Muted folders** (`server/src/muted.ts`, `~/.silos/muted.json`) — a
hand-edited JSON array of projects-dir names (the engine's encoding of a
path) whose sessions never reach the product: not indexed, not watched,
never listed. Absent = nothing muted; Silos never creates or writes it
(`GET /api/muted` reads it; a corrupt file mutes nothing and is left as
is). The typical use is a plugin that runs its own `claude` sessions in a
folder of its own — e.g. claude-mem's observer sessions:
`["-home-<user>--claude-mem-observer-sessions"]`. Read at boot.

**Working** (one rule, `server/src/work-live.ts` ⇄ `web/src/lib/live.ts`)
— work a conversation started is live while it WRITES (within
`liveMs`, 120 s) or has a TOOL IN FLIGHT (a tool_use with no result, bounded
by `TOOL_MAX_MS`, 30 min): the main turn (`toolSince`, only while its turn is
open) and its background work alike — subagents at any depth, workflow
agents in subfolders of `<session>/subagents/`, a resumed subagent. The
Claude reader follows each FRESH subagent transcript with the main
transcript's own accumulator and puts the newest open tool on the meta
(`subToolSince`, beside `subMtime`) and on each census row
(`DiskSubagent.toolSince`); OpenCode's meta carries `toolSince` from a
running tool part (a `task` subagent runs inside its parent's tool call).
Working ⇒ the column says Working («N subagents at work»), the sidebar dot
blinks, Home's Working now lists it, its task says «X is working on it now»
(`conversation-live.ts`), Task mode holds a wake (`busyWhy`:
`BACKGROUND_BUSY`). An open question (AskUserQuestion unanswered, a plan
awaiting approval) still outranks it; the question's tool_use id is kept in
the context state so its answer closes it after a restart too. A background
_shell_ (`Bash` with `run_in_background`) is not a tool in flight — its tool
call returned — but while the conversation still awaits it, it is work with
the turn closed (`shellSince`, bounded by `SHELL_MAX_MS`, 2 h): the column
says «a command running», the sidebar dot blinks slow and the Processes
block opens itself; the System silo's process table lists the process. A
parked conversation is the third state: Monitor, ScheduleWakeup and
Workflow are not tools in flight either (`PARKING_TOOLS`,
`harnesses/claude-code/parser.ts`) — it reads «waiting» until one of its
subagents writes or the tool returns.

**Context files** (server, `context-service.ts`): three scopes under a
territory's `context/` — `shared/` (every agent of the folder), `<agent>/`
(every conversation of that agent) and `<agent>/conversations/<thread id>/`
(ONE conversation, its whole thread). The append's «# Context files» note
(`ChatService.contextNote`, both engines' start) lists the TOP level of the
first two plus the conversation's own folder; deeper files (an agent's
deliverables, which the briefing puts in `context/<id>/<topic>/`) are never
announced, and `conversations/` is never walked as the agent's. Only the
server names a conversation's folder: the thread ROOT from any session id
(`task-threads.ts makeThreadIdOf`, one resolver for chat and the routes),
in the territory of its cwd (else the primary); only the owner's gestures
write there (upload, «Give to the agent» = a link-then-unlink move up).
News: top-level files by mtime against a per-THREAD «last turn» moved only
when a real SDK turn's `system/init` arrives (a console open never moves
it); the console's own UserPromptSubmit hook keeps its `<key>.ctx` marker.
A given file is QUEUED, never discovered: one line in
`<dataDir>/context-news/<thread id>` (`context-news.ts`), printed by the
thread's next turn — the console hook drains it (rename, read, delete; the
queue path is baked in at launch), an SDK turn drops what it printed at its
init. OpenCode's role file is per agent and has no per-prompt hook: an
OpenCode conversation is not told of given files (the web says so).

**Hooks** (plugin, `plugin/hooks/hooks.json`):

- **SessionStart** (`startup|resume|clear|compact|fork`, timeout 15 s) — for
  an agent's session (`SILOS_AGENT_ID` + `SILOS_AGENT_STATE` set) writes the
  birth marker (`$SILOS_AGENT_STATE/births/`, zero tokens: who gave birth to
  what), then injects what the session's context does not carry yet:
  - the **briefing** composed from `context/briefing.d/` for the skills the
    session surely has: from the hook, only the plugin root's (a plugin's
    skill takes no `skillOverrides` entry). A folder copy or a personal
    skill is not counted: whether it loads depends on every settings tier,
    the launch's own `--settings` among them, which a hook cannot see — and
    the only claude the hook briefs with a bearer is one started from a
    shell inside a Silos session, whose launch Silos never saw (no channel
    hands the hook that answer), so its briefing is composed neutral (the
    `.without` recipes). Every `claude` Silos launches carries it in its
    **system prompt** instead (console `--append-system-prompt-file`, SDK
    `systemPrompt.append` — `consoleAppend` in `claude-code/server-hooks.ts`,
    `withBriefing` in `claude-code/headless.ts`) and says so with
    `SILOS_BRIEFING=system-prompt`: there it survives `/clear` and
    compaction, is never cut, and the hook never repeats it (a `claude -p`
    run from a shell inherits the variable, not the prompt: a startup whose
    session id is not `$SILOS_SESSION_ID` is briefed by the hook). A
    `claude` started by hand gets it on startup, clear and compact, and on
    resume/fork only when its transcript since the last `compact_boundary`
    holds no earlier injection (`compose.py --carries`). A session with no
    Silos identity (`SILOS_AGENT_TOKEN` empty — a `claude` a person started
    by hand) cannot act on the API recipes, so it is sent the **slim
    briefing** instead (`context/hand-started.md`, about 1,700 characters:
    what Silos is, where deliverables go, tasks in `plans/`, durable work
    as an automation; `compose.py --slim`). What a rule needs only now and
    then lives in `context/reference/` (`automations.md`: the other
    triggers, command runs, limits; `tasks.md`: the file format, asks and
    the claim/release recipes for a folder without `team-plan`) and the
    rule names the file — a fragment writes `{{context}}`, which both
    composers fill with the real path of `plugin/context`;
  - the **roster** (same «already carried» test on resume/fork; at most 12
    agents, lines cut at 160 characters, then «N more»), the **unread
    messages** always (`inbox.py` GETs the server's store with the bearer
    and `$SILOS_TURN`; a failed fetch says so in one line and marks
    nothing), and after `/clear` the tasks the console still works with the
    release recipe (at most 3, then «N more»).
    **Always under the cap**: Claude Code keeps a hook's `additionalContext`
    only up to 10,000 characters (beyond it the model gets a file path and a
    2,000-character preview). `compose.py --hook --cap 9500` gives the
    dynamic part its room first and composes the briefing in what is left:
    whole when it fits, else each rule's first line with its detail (recipes,
    formats) inlined while it fits and otherwise named by the file that holds
    it, then whole rules folded to their title + file, last rule first; a last
    guard cuts at a line boundary. `server/test/session-start-cap.test.ts`
    holds it for every combination. The server's own routes (system prompt,
    OpenCode's context file) are uncapped and carry the whole text. Never
    blocks: any failure degrades to less context, exit 0.
- Both commands quote `"${CLAUDE_PLUGIN_ROOT}"` (a path with a space
  exited 127); Silos' own install into `settings.json`
  (`installSilosHooks`, `SILOS_HOOK_ENTRIES`) writes the same matcher and
  timeout with the path shell-quoted (`shell-quote.ts`: a path made only of
  plain characters is already one word and is written bare). An entry
  installed by an older Silos keeps its old shape (`startup|resume|clear`, no
  timeout) while its script exists: it reads _installed_ and the installer
  leaves it alone. Only a _broken_ entry is touched — its command rewritten
  in place and a missing timeout added, its matcher kept.
- **A tool missing** — `session-start.sh` without `python3` prints one
  stderr line and exits 0 with nothing on stdout (no briefing, roster,
  inbox or birth marker). It needs nothing else: the server is asked in
  Python (`plugin/hooks/silos_http.py` — the bearer in a header, never in a
  command line; no proxy for a loopback Silos; a redirect is a failure).
  `pre-cron.sh` allows with one line the same way
  (`plugin-prerequisites.test.ts`, `pre-cron-hook.test.ts`).
- **PreToolUse on CronCreate** (timeout 10 s) — in a Silos agent's session
  (`SILOS_AGENT_ID` or the bearer `SILOS_AGENT_TOKEN` in its environment)
  recurring or durable native crons are denied with the recipe to propose a
  Silos automation (owner-visible state); a one-shot, non-durable self-ping
  passes. In a session a person started by hand (neither variable) only a
  `durable: true` cron is denied, with the automation page, and only where
  a Silos answers `GET $SILOS_API/healthz` within a second; a recurring
  session-scoped cron (a fixed-interval `/loop`) passes. Without python3 it
  allows with one line on stderr. `ScheduleWakeup` (a self-paced `/loop`, session-scoped) is the
  one-shot case and is not gated; `RemoteTrigger` (cloud scheduled tasks on
  claude.ai) is not gated either — a known gap (`plugin/README.md`).

**Skills** (plugin; one source per rule):

- `team-plan` — the ONE source of how an agent handles Silos tasks
  (schema, claim/release, waits, closing). `SKILL.md` is the core — both
  recipes and the conduct, under the 5,000 tokens Claude Code re-attaches
  after a compaction; `reference/*.md` holds formats and every answer, read
  when a step names it.
- `heartbeat` — the heartbeat turn: it decides, it does not work —
  messages, a task left to it, what it considered, sleep.
- `vault-secrets` — credentials only through the Vault, never in the
  transcript.
- `support-inbox` — case files for a support mailbox.
- `silo-author` — writing a silo for the owner: when it is one, the questions
  in order, a manifest that validates, `POST /api/silos/validate` on a draft,
  first records, `POST /api/silos/submissions` (pending until the owner approves);
  the format itself is `docs/standard/authoring.md`.

**Plan** (project file, read by the Plans silo) —
`plans/<slug>.plan.json`. The file is the truth. `plans/tasks.plan.json`
(title `""`) is the project's list, rotated monthly; a named plan closes and
moves to `plans/closed/`. These files are the project's only task list (no
BACKLOG.md, TODO file or Notion base beside them; a one-way mirror is fine),
they live in the main checkout (never edit a worktree's copy) and stay out
of git. A task is said `<project>#t3` (or
`<project>/tasks#t3` when a plan is named like the project) —
`silos/task-ref.ts`, read back by the claim/release API with `<plan>#t3`.
A closed plan's tasks are in no reading; `plans-closed.ts` reads
`plans/closed/` through the silo's own rules only to resolve old keys and,
for Tasks › Done's Plans strip, to LIST the finished plans — `GET
/api/tasks/closed-plans` (owner-only): key · title · folder · file · mtime
(when it closed) · done/dropped/open counts, newest first, the project's
list's monthly archives left out. Read-only; the web reads it per Plans WS
tick while Done is open (`hooks/useTasks.ts useClosedPlans`).

**Task** — one entry of a plan's `tasks[]`: `owner` (an agent id, `owner`,
or a person), `status`, `dependsOn`, `waitingOn {owner, action, asked?,
options?, binding?}` (binding: see Binding asks), `nextCheckAt`, `due`, `parent`, `conversations`, `notes`.

- **Claim** (`POST /api/tasks/claim`; the curl template, with `<slug>`
  and `<id>` to fill, is `context/recipes/claim.sh`) sets `in_progress` and
  links the conversation in one write — a `blocked` task that still waits
  (a `waitingOn`, a dependency not done) is linked and stays blocked (the
  verb's `keep`); 409 if another live conversation works it.
- **Release** (`POST /api/tasks/release`) lets go; only from `in_progress`
  and when it was the last current conversation, the same write disposes
  the state (`pending` by default; `in_review`, `blocked` or `done` when
  asked). The task's own `releases[]` records it. Leaving an AGENT's task
  `in_review` needs its reviewer named (below): an agent's bearer without
  one gets 409 «name who reviews first» and no mark is written; the owner
  leaving it in review is its reviewer — `waitingOn {owner: 'owner', action:
'review it'}` rides the same write (`appendRelease`) — all of this only
  when the disposition applies.
- **Drop** (the owner's, or an agent's per team-plan) = `cancelled` + a
  `Dropped:` note: finished, but it resolves no dependency.
- **The owner's gestures on one task** (`POST /api/tasks/act {key, verb,
…}`): `answer {text, asked}` · `approve {text?,
asked}` · `done {state}` · `drop {state, text?}` · `reopen` · `park
{until, day?}` · `resume` · `remove-dependency {dep}` · `hand {to, owner,
state, outside}` (below), each ONE write by
  `siloActions.taskGesture`. The owner's only (the owner's credential, no
  bearer, no `X-Silos-Agent` naming an agent — 403). The mutator reads the
  file and normalizes it INSIDE the write and judges the verb's condition on
  the task there — never on the file's version, so another task of the plan
  written meanwhile refuses nothing — against what the surface painted
  (`asked` for answer/approve: the question, '' when none; `state` for
  done/drop): a different question is 409 «it asks something else now», a
  different open state «it changed — it is <state> now». A verb whose effect
  is already there answers 200 `already: true` and writes nothing (done on
  done, drop on cancelled, reopen on an open task, resume with no check,
  remove-dependency of one it does not have; `answer` has none — no wait is
  409 «it no longer waits on you»). What it writes: `answer` the note, the
  wait out, `in_review` → `pending`, `blocked` → `pending` when nothing else
  holds it (`blockedHolds`); `approve` (an agent's review waiting on the
  owner) «Approved.» or the words + the wait out + `done`; `done`/`drop` the
  state with the wait and the check out (drop's note «Dropped: …»); `reopen`
  `blocked` while something holds it, else `pending`; `park` the check, and
  «Parked until <day>.» only on a task whose owner is no agent (a note would
  wake one); `resume` the check out (+ `pending` when nothing holds a
  blocked one); `remove-dependency` the list without it (+ `pending` the
  same way). Each verb needs the manifest to let the owner every field it
  PUTS; the fields it clears go when the role declares them. Its events are
  its parts': the note's `append-item` first (its exact `at` and digest —
  the owner-note provenance), then one `set-field` per field; a note of a
  verb that CLOSES (approve, drop) carries `closes: true`, which the ledger
  keeps (`OwnerSaid.closes`), the engine seals on the note and
  `ownerNotesOf` leaves out: it neither reopens the task nor wakes a bound
  agent (it reads it on the task next time). The answer is set-field's (the
  record, `nowReady` with each owner's wakes) plus `already` and `holds`
  (what still holds it — the web's «Answered — but it still waits on …»).
  A task rotated out with its month is a 404 in those words. Only for a
  kind declaring `roles.task`: another silo's Home rows keep their own
  set-field/note (`web/src/lib/task-drop.ts`). In the web ONE function per
  gesture, `lib/task-gesture.ts act` — the task page, Home's rows (Needs you
  and Yours to do), Tasks' `d`, ⌘K, the column and the plan viewer — which
  marks the task seen; a refusal is said beside the control that caused it.
- **Give to… — `hand`** (only on the
  task page, beside Drop): `to` is you or an agent IN PLAY whose territory
  holds the plan's project (`bearerMayReadLocation` — an agent without a
  folder never; a person by name never: their task is their file's);
  `GET /api/tasks/mode` lists them (`handTo`). It is no verb of the manifest:
  `owner` stays out of set-field and `hand` is the one writer of it, exempt
  from `writableBy` for that field alone. The guard lives in the ROUTE, judged
  with no await before the write: a current conversation that is not `to`'s
  working it by the claim's rule (`othersOnTask`) → 409 naming it; a Task mode
  turn running or starting on it (`view(key).live`) → 409 naming its
  conversation, or its agent while it has none; «is it `to`'s» is one reader
  (`sessionFacts`). An origin still provisional → 409; an unknown one only
  with `outside: true`, as the page painted it. ONE write: the owner, the note
  «Handed from X to Y.» (the owner's, with its provenance), the current
  conversations that are not `to`'s released, Silos' wait and a wait naming
  `to` out (any other stays, with its ask fact), `in_progress` → `pending`
  unless a conversation of `to` stays current, `in_review` stays while its
  reviewer's wait stays, `blocked` → `pending` when nothing holds it, the next
  check kept. Only after it landed: the blessing (whatever `to`'s control),
  the creation leaving its creator's open count (`Creation.handedAt`), and
  the owner's Give for a bound `to` (`assign` in the answer); a repeat is
  `already`. An ask its previous owner armed keeps its fact; its answer's wake
  says «Y answered what X asked on this task» (`ArmedAsk.by`).
- **New task — `POST /api/tasks/new {folder, plan, title, owner, details?,
session?, give?}`** (the owner's only): the
  project's list made first when `plan` is it, then ONE write
  (`siloActions.newTask`): the id from the RAW file (unreadable tasks and
  rotated ids count), the owner's birth stamp inside the write
  (`initiative.prepareTask` — refused, nothing registered), the details as its
  first note (born with it: a baseline, they wake nobody on a save without
  Give), with `session` that conversation listed and the task in progress;
  the events of its parts, no set-field of a birth. `owner` is you or an agent
  in play whose fence holds `folder`. With `give`: bound → the owner's assign
  (blessed), told → nothing starts, yours → «it is yours». GiveDialog,
  FirstMeeting («new» before the mission goes) and the record page's
  make-task all create through it.
- **The owner's note that reopens**: in the
  note's OWN write, for every door (`siloActions.appendItem` when the owner
  appends to a task's notes): an agent-in-play's task, closed or blocked with
  nothing holding it but Silos' wait, goes `blocked` while something holds it,
  else `pending`, the `unstick` wait out in the same write; never a person's,
  an archived agent's or nobody's. Task mode writes no reopen (its owner-note
  wake carries the note). The two-minute dedupe never swallows a reopening
  note. A note written while the task was open that the agent closes a moment
  later does not reopen it (the wake still goes).
- **Every owner write on a task is the stamper's**:
  `SiloActionsOptions.ownWrite` registers the shape inside the mutator of
  every gesture, note, release, link, set-field and new task of the owner (an
  undo when the write did not land), so an unattended turn that touched the
  same plan never has it reverted as its own. A verdict restores only the
  fields it judged, over the task as it is now (the whole task only when it
  was removed), and an owner steal reverted cancels everyone's turns and
  queued wakes but the restored owner's (`stopTask(key, why, {keep})`).
- **Release with a wait**: the owner's
  release to `blocked` (the owner's only; a bearer sending `wait` is 400) carries
  `wait {owner, action, asked?}` in the same write — bounded like an ask's,
  never Silos' `unstick` prefix, replacing the wait there — only when the
  dispose does leave it blocked; without one, `{owner: 'owner', action:
'unblock it'}` only when nothing else would hold it. «Unlink…» and ⌘K send
  one release.
- **Respond** closes the gate FIRST (its Done judged on the painted `state`,
  no file version), then writes the answer on each waiter (whose note's
  own write reopens it); a note that fails answers `closed: true, missing`
  and Home's row comes back with it; respond sent again over the done gate
  writes only the missing ones. What an answer IS is one pure choice
  over the painted task (`lib/answer-wait.ts answerKind`): a person's gate
  that agents wait on is `record/respond` («Answer & done» — the notes on
  the waiters, then the gate closed with the owner's Done, an archived agent
  read as an agent), anything else `answer`; on the task page, while the
  task waits on the owner, the note box IS the answer; on an agent's review
  waiting on the owner it is «Send back» beside «Approve» (Needs you too). A
  Vault save that resolves a binding ask answers with the same verb.
- **Assign** (`POST /api/tasks/assign`, the task named by `{key}` or by
  `{plan, task}` like claim and release) and **link**
  (`POST /api/tasks/link`) are explicit, never inferred: the owner's assign
  is a gesture; an agent's bearer starts only ITS OWN task, On its own,
  under its ceiling. What it refuses comes back as `{queued:false, why}`.
- **A conversation's tasks** (`GET /api/sessions/:folder/:id/tasks`,
  `server/src/session-tasks.ts`): the inverse of `conversations[]`, closed
  over the thread, each line with `current` and its plan `file`. The
  header's «Working on» reads it, and so does the column's Plan block: its
  plans are the ones the conversation authored (Write/Edit, or the path
  named in a command) together with the plans of the tasks it is linked
  to, one line per plan file, wherever the plan lives.
- **Continue in a new conversation** (`POST /api/tasks/work
{key, instead}`, owner-only) — the task's own door with `instead` = a
  conversation current on the task: ALWAYS a new conversation of the task's
  agent, briefed from the task (`TaskModeEngine.work`, the same briefing as
  any new one), linked through `ownerLink` FIRST and then `instead`
  released (`appendRelease`, no state asked): with the new thread current
  the release never disposes, so the status is what the link leaves. A
  refused link releases nothing; no running-turn refusal (the old
  conversation keeps its process). The column offers it on the «outgrew its
  work» line: context ≥ half of the window «% context» is measured against
  (`web/src/lib/context.ts knownWindow · pastHalfWindow`; no model or an
  engine without `ui.contextPercent` → no line).

**Not Silos tasks** (the engine's; Silos reads, never converts):

- the **checklist** (TaskCreate/TaskUpdate/TodoWrite) — steps of one
  conversation, read from the transcript into the context column (off on
  5.x models unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` — the owner's switch
  in Settings › Engines writes that documented key under `env` in
  settings.json (`writeTodoTools`); Silos never sets it by itself);
- **plan mode's proposal** — `$CLAUDE_CONFIG_DIR/plans/<slug>.md`;
- an **execution document** (an engineering plan executed step by step) —
  wherever the project's planning skill writes it, plus its SDD ledger
  `.superpowers/sdd/<plan>/progress.md` (copied to `~/.silos/executions`);
  it gets ONE task «Execute …».

**Control** (`server/src/control.ts`) — the ONE
setting that decides whether something happens without the owner:
`Agent.control` «Only when told» (`told`) · «On its own» (`own`), set on the
agent's Now (`ControlSwitch.tsx`). `own` needs a mission AND the territory:
the PATCH answers 409 otherwise, and an `own` whose fence goes
off — or whose mission is gone — operates as `told` (`controlOf`, the one
reader), `agents.json` intact, with a Needs you row; turning the fence back
on brings it back with no gesture. The owner's knobs: `ownTurnsPerDay`
(the day's ceiling: charged task wakes + runs of its own recurring work
without `acceptedFrom` — never a heartbeat turn, «Run now» included: its
period is its ceiling) and `unattendedSpendPerDay`
(its spend cap when the provider prices — heartbeat turns DO add to it),
«Let it continue today» (`ownExemptDay`) lifting both — one count,
`own-turns.ts`, which returns both sums broken down by kind (`starts`:
wakes · self; `spent`: wakes · heartbeat · self). The Needs you row at the
max or the cap says why with that breakdown under its head (`inbox.ts`
`ownCapWhy`: «7 task starts · 3 runs of its own automations. The max keeps
one agent from spending the day by itself.» / «$3.10 task starts · $1.90
heartbeat · $0.40 its automations») and «See today ›» — one door function,
`web/src/lib/usage-door.ts`: Usage, that agent, today. ONE source per row: the head and the breakdown under it
are the same records `own-turns.ts` counts — starts by kind add up to the
count, spend by kind to the money — and Usage's transcript reader is never
consulted for them (it dates and prices a turn its own way); the head says
the count really used («started 8 times … — its max is 5» after the owner
lowers it). Measured says «Started N times today · max C ›» and, apart,
its heartbeat's day by class («Heartbeat: looked twice today» —
`heartbeat-store.ts` `turnsOfDay`, turns that had their turn). Silos' cut of its capability of creating work (`Agent.cut`)
is lifted by the owner («Allow again»). **Every birth is told except the
owner's explicit gesture** — `POST /api/agents` with a mission (owner-only:
no bearer reaches it) is born `own`; a role-pack install, or any other
path that creates an agent, is born `told` (`AgentRegistry.create`
defaults to told) and the owner turns it On its own. The flip to told supersedes its
queued wakes in the same request and answers what still runs (the sheet:
`POST /api/agents/:id/stop`).

**Task mode** (silo, built in) — its producers are DERIVED: every agent On
its own, in play, with a folder (the operator's PATCH of producers is
a 409). Silos wakes the owner agent **in the task's own conversation** on an
EVENT: its dependencies finish (unblocked), its subtasks finish, the owner
writes a note, its `nextCheckAt` passes, it is assigned, or it stalls (one
wake; if that changes nothing Silos marks it blocked with a `waitingOn` up
the chain). The owner's assign and notes are GESTURES: never held by the
ceiling or the throttle, never charged to the agent's day; an agent's bearer
starts its own task through the same pipe (`POST /api/tasks/assign` with its
turn; 403 another's, 409 when told). The first look at a task is a baseline.
State: `~/.silos/task-mode/state.json`. A told agent's ready task waits for
the owner («Not started · Open with X ›»).
**The live caps** (`turn-slots.ts`): `OWN_TURNS_LIVE` per agent and
`UNATTENDED_TURNS_LIVE_GLOBAL` for the fleet, shared by task wakes and the
resident's agent runs — excess is QUEUED (a due cron stays due, a wake stays
queued), in two classes: an owner's gesture ahead of everything inferred.
A heartbeat's look asks for room with `wouldStart`, a probe that queues
nothing: without room it is skipped `busy` and holds no place in the line; a think queues like everything else.
`UNATTENDED_TURN_TIMEOUT_MS` caps every unattended turn, wakes included.
**Rule 1 on screen** (`web/src/lib/give.ts`
says every word): the owner's gestures say what will happen BEFORE the click
and the live line says what happened AFTER it. New task is **Give**
(`GiveDialog.tsx`): «Give to X» (own: create + assign), «Give and open
console ›» / «Give and open chat ›» (told: create + open), «Add to my list»
(yours), «Save for later» (the task alone). **Open** goes to the agent's
console only when it HAS a console in the index (`SessionMeta.console`, the
transcript's `entrypoint: "cli"`; the first console is always the owner's
to open by hand) and its engine's console takes the briefing — chat
otherwise (OpenCode: always chat); the button names the surface. One source
of those facts: `server/src/open-surface.ts`, carried as `open` on
`/api/overview` and `hasConsole` on the task door (`GET /api/tasks/mode`);
the overview also carries `controlNow`, the derived control every web door
reads. The task page's composer by control: own «Write to X» · Send (the
note wakes it); told Send + «Send and open ›» (the note stays, then you go
in); held «your note waits: …» + «Open ›»; closed «reopens it» (the
server reopens it in the note's own write — the record page's box says the
same). A task
nobody is on: «Start X ›» (own, the assign gesture) or «Open console|chat ›»
(told). **The live line** (`TaskLive.tsx`): the server's facts —
`TaskModeEngine.liveOf` (`live` on `GET /api/tasks/mode`: a turn running,
queued on the agent's cap or the fleet's — `TurnSlots.standing` —, a start
that did not start, a console holding it) — read with what the WS stream
says of the running turn (`store.turnPulse`, every `chat-*` event by
turnId): «Starting X…» → «X is on it · <tool> · <n>s ago» · Stop (`POST
/api/agents/:id/stop {turns}`, its own live turns only) → or «X couldn't
start: <why>»; «X is running <n> things already — it starts when one ends»
/ «the fleet is running <n> things — X starts when one ends»; «Your console
is on it · Open ›» (no Stop). **Silos never types into a console** for a
gesture: Give, Write and Open never call `consoleSendLiteral` (only the
explicit `POST /api/console/:key/send`, an answer to an open question and
the `/model` pick do — `server/test/no-typing-into-consoles.test.ts`).
And even those never press Enter into an open dialog: `consoleSendLiteral`
is the one guard of every typed prompt — it reads the screen (tmux
capture-pane) and asks the engine (`HarnessConsole.dialogOnScreen`, Claude
Code's in `harnesses/claude-code/dialogs.ts`: «❯ n.» choice list + its known
trust/permission/question/plan words, conservative — an unknown screen
passes); on a dialog nothing is typed: `/send` answers 409 `{ dialog }`, the
`/model` pick waits for the next launch. Only `/answer` (digit + Enter,
`consoleSendKeys`) answers a dialog, on purpose.
A note counts as the **owner's** only when Silos recorded the owner writing
it (the kernel's append-item event on that task, `silos/events.jsonl` —
`task-mode/owner-notes.ts`); a note an agent signs "owner" in the file is an
agent's. A wake is **charged** (the day's ceiling, the throttle) only when its
turn starts working (produces output — a turn that ends with nothing, such
as an API error, never started): a turn refused by a usage limit or failing
to start puts the wake back in the queue, held until the reset or a retry —
never «delivered», never the stalled wake that «changed nothing». A start
that keeps failing is retried with a backoff and, after 5 tries, escalates
like a stall («Silos could not start X's turn»). An engine Silos refuses
(outdated, missing) holds every unattended turn — task wakes, automation
beats (they stay due and run once) —
spending nothing; the one engine row in Needs you says it. Silos signs its
own notes and messages `Silos` (`system-author.ts`), never the agent id
`silos`. An escalation hop goes to an agent only when it is On its own and
its next heartbeat falls in the window; otherwise up the chain, and
at the end the owner. A hop to an agent arms the same ask fact an agent's
ask arms (below: `asked: ''`, Silos' own
`unstick <ref>` action, its wait and `blocked` in one write the stamper
expects): the hop sees it in its start briefing and its heartbeat packet
instead of a message, and its answer (`POST /api/tasks/ask/answer`) takes the
wait off the task — the case closes.

**The free period** (`server/src/period.ts` — pure, the
web imports the same file): `{ every, unit: minutes|hours|days|weeks, at?,
day?, between?, since? }`. Its 400s carry the prefix of where it lives
(`heartbeat.period.` / `trigger.period.`); floors `HEARTBEAT_PERIOD_MIN` (5
min) and `AUTOMATION_PERIOD_MIN` (1 min). The server stamps `since` (moved
only when unit or every change) and, on minutes/hours with no `at`, the
agent's staggered minute from the band's start. Slots are local wall time:
a minutes/hours cycle starts daily at `at`, its last slot dropped when less
than half an interval before the next `at`, slots outside `between` don't
exist; days count from `since`, weeks from the Monday of `since`'s week; a
missing hour fires at the first valid minute, a repeated one once.
`nextSlot` · `slotsPerDay` · `inWindow` · `periodWords` («every 3 hours from
08:22 · 08:00–20:00»). Its clock is NEVER cron's (nothing piles up, at most
one slot due): an owner's automation moves to `nextSlot(now)` only when a
run STARTS (`executeRun`'s `onDispatch`) — due stays due while it can't
start, survives a restart, and at boot follows cron's recovery rule; a
heartbeat moves at every slot, run or skipped, and recovers nothing at boot.
An owner's create with a period is born with `maxRunsPerDay = max(24,
slotsPerDay)`; a proposal keeps 24 and its sheet says «≈ n runs a day,
outside X's daily max». Cron stays, as the advanced form.

**Heartbeat** = when an
agent On its own looks and thinks:

- `Agent.heartbeat` — `{ period | null, sleepUntil?, sleepWhy? }`; the field
  absent is the default (every Monday at `09:<hash(id) % 60>`), `null` is
  never, and any shape `heartbeatOf` does not recognise reads `period: null` — never a beat from data Silos does not
  understand; `sleepUntil` the agent sets from its heartbeat;
- the automation `heartbeat-<agent>` (`origin: 'heartbeat'`, `heartbeat.ts`)
  — derived by `reconcile` on every tick and every PATCH: trigger `{ kind:
'period' }`, `keepAlive: false` (an account at its limit waits for the
  next slot), NO budget (`maxRunsPerDay` never consulted: its period is its
  ceiling); its shape is refused on PATCH/DELETE/pause with the door that
  works (the agent's page) — and a bearer naming its `trigger` or `runsOn`
  gets a 403; hooks off FIXED, no `runsOn` (the provider resolves at send
  time); a heartbeat never resumes a session a restart cut;
- the fire (`resident/heartbeat.ts`), zero tokens until a turn is worth it:
  kind (think when the period is a week or more, or no think had its
  turn in 7 d − 1 h and none was tried today; else a round if proactive —
  see Proactive below — else look), its band
  re-checked, then skips in their words — `sleeping`, `engine` (one row a
  local day, then silence), `busy` (a look; a think waits — its own previous
  run alive says «its runs take longer than its period»), `spend`,
  `account`, `empty` — never the day's ceiling. A skip's instant (a sleep's
  end, an account's reset; and the Run-now 409's) rides apart as `until`
  (ISO): the words stop before it and the web says it in local time; the packet «since the last
  time» (`heartbeat-packet.ts`: a delta with keys, suppressed by what it
  considered); a think skipped by spend, account or engine, or failed, is
  re-armed after midnight (inside its band), once;
- its state (`heartbeat-store.ts`, `heartbeats/<id>/state.json`): the last
  turn (the packet's `since`), the last think, the think pending to re-arm,
  the re-arm of the day, today's counts and the engine refusal said —
  written as each heartbeat run is written (`ResidentCore.appendRun`), never
  re-derived from the run history on a tick. In ORDER: a row of an older
  day never resets today's counters (a round closed after midnight counts
  on its start's day), and only the newest think decides what is pending
  (`thinkNotedAt` — an older think's audit re-write never re-arms it);
- a run is found BY ITS ID (`AutomationsStore.runById`/`openRuns`, an index
  warmed with the latest-run cache): its terminal row, its sessionKey, its
  audit, «busy», shutdown and run-cause read the run by id or by the open
  runs, never as «the last line» — a skip row written while a round is in
  flight changes nothing of the round's sealed regime or cause, and a
  re-write of an older run never becomes «the latest». At boot EVERY
  `running` row with no live turn closes interrupted and is audited by its
  own seal (`Schedule.reconcileStaleRuns`);
- the prompt (`heartbeat-prompt.ts`) per engine (the tools line says what
  that engine's heartbeat really blocks: `HarnessTraits.heartbeatBlocks`)
  and per stage (`HEARTBEAT_STAGE` — the complete variant: create
  ONE thing from the mission in a think, propose apart, the plan-file path);
- the turn: Claude `disallowedTools` (CronCreate, WebFetch, WebSearch,
  Agent, Task, AskUserQuestion, Workflow, RemoteTrigger, ScheduleWakeup,
  SendMessage, and the skills `schedule`/`loop` by name), no MCP (`strictMcpConfig` + no servers),
  `maxTurns` 30; OpenCode `tools`/`permission` deny webfetch/websearch/task
  (trusted only after `scripts/opencode-heartbeat-smoke.sh`); the agent
  records what it considered (`POST …/considered` →
  `heartbeats/<id>/considered.jsonl`) and may sleep, both only from a
  heartbeat turn (its `SILOS_TURN` class);
- the audit (`heartbeat-audit.ts`) of EVERY unattended run and wake at its
  end — and of a turn a restart interrupted, at boot: `readOutside`, memory
  and config edits, and the USE of the owner's credential, which cuts.
  `claude`/`opencode` count as network only in command position (`cat
CLAUDE.md` is a read); memory counts only what a command WRITES; a
  session it cannot read is `transcript unreadable` — tainted, with its
  Needs you row (fail closed): a run's hangs from its automation, a Task
  mode turn's from its TASK (the task's newest audited turn in
  `task-mode/state.json`, ref + session). Known limitation: a NEW headless OpenCode
  run gets no `SILOS_SESSION_ID` (only a resume does), so a `claude -p` /
  `opencode run` launched from an OpenCode heartbeat's shell leaves a birth
  marker with `parent: null` and its own calls are not followed — the
  launch itself still marks the run (`Bash: opencode`, tainted);
  «Run now» (`POST …/heartbeat/run-now`) is the owner's gesture (cause
  `manual`, a think, outside its band and its sleep), held by the spend cap,
  the account and its margin (a 409) — never by the ceiling, which does not count it; its cost adds to the day's spend like any heartbeat.
  The page's Heartbeat row says the period's words with «change», which opens
  the period editor (`web/src/components/PeriodEditor.tsx`, also the
  automation editor's first schedule field, «or a cron expression ›» under
  it): «Every [n] [unit]», «on»/«at»/«only between», «Never» on a heartbeat,
  a 24-hour ruler of its slots and the consequence in words. `CronCreate` and `RemoteTrigger`
  are withheld from every unattended turn of Claude, heartbeat or not —
  both schedule standing work the owner cannot see.

**Proactive** = «On its own» plus a setting, never
a third `control`: `Agent.proactive = { perDay, tools }` (1–50, default 5;
tools default on), written ONLY by the owner's PATCH (an agent bearer never
patches an agent), its 409s judged on the state the PATCH leaves (own, a
period, a period under 7 days), cleared by «Only when told» in the same
write (`AgentRegistry.update`, whoever writes `control: 'told'`). The ONE
reader is `control.ts proactiveOf(agent, fenceOn)`: own (derived) ∧ a valid
setting ∧ a period ∧ no `Agent.cut`; `positionOf` gives the switch's three
positions (rosters carry `positionNow`). The fire (`resident/heartbeat.ts`):

- kind — think as for any heartbeat; otherwise `round` when proactive, else look; a
  proactive think is a round with the weekly header;
- the regime is SEALED at start on `run.heartbeat = { kind, tools, perDay }`
  and on the live turn (`LiveTurn.regime`): the engine's options, the judge
  and the audit read it there, never from the agent (a mode changed
  mid-round, or a restart, changes nothing — `runVerdictOf` taints only a
  run sealed `tools: false`);
- the order: the plan reading is ASKED for (`planUsage.get`) BEFORE
  the run's lock — a second fire meanwhile is a no-op — then, at once:
  sleep · engine · busy (look and round skip; a think waits) · spend ·
  `share` (a round past half the day's cap; «Let it continue today» lifts
  it) · `account` (the limit of the account the turn RUNS ON — a window at 100 %
  with no reset said is at its limit too, `proactive.ts limitOf`: it goes
  at its next slot) · `headroom`
  (round and think on a provider that does not price: any window ≥ 85 % of
  a reading ≤ 15 min old by its hour; no fresh reading fails CLOSED except
  the earliest slot OF TODAY — one carried over from a previous day is
  not; a provider with no price and no reading — an engine's own login —
  at most 12 round/think turns a day) · `empty`
  (look) / `quota` (round, the day's count spent and nothing new). The
  account is resolved exactly as `ChatService.send` will
  (`ChatService.unattendedTurnProvider`: runsOn, the install's switch, the
  fallback — `turn-account.ts turnAccountOf`; a Claude account is
  «readable» only when the agent's engine runs Claude accounts — the
  harness contract's `providers.kinds` — so an engine on its own login gets
  no reading and the unmeasured cap); the re-armed think uses it too and
  re-arms on spend/account/headroom/engine/failure; a skipped round never.
  «Run now» (`Resident.runNowManual`, async) passes spend, account and the
  margin — at the margin a 409, without a fresh reading it runs;
- the turn (Claude `headless.ts unattendedSdkOptions`): with `tools` —
  skills, connectors, the web, `maxTurns` 60; without — the heartbeat's
  options, 30. ALWAYS: hooks off, `Agent`/`Task`/`AskUserQuestion`/
  `CronCreate` and the scheduling skills `Skill(schedule)`/`Skill(loop)`
  disallowed, and with them the engine's other ways to delegate or
  schedule (`Workflow`, `RemoteTrigger`, `ScheduleWakeup`, `SendMessage`).
  `scripts/smoke-heartbeat-vetoes.mts` measured it on a real claude: the name vetoes hold; a skill with `context: fork` DOES run
  in its own context — no documented mechanism withholds the fork — but one
  level deep and under the same vetoes (said on the Proactive sheet as residue). OpenCode: with tools, its runs' regime with `task` denied;
  without, its heartbeat deny. And EVERY unattended turn of Claude (rounds,
  wakes, runs) carries the settings files it does not read in its
  flag-tier settings (`harnesses/claude-code/local-holds.ts`) — a heartbeat
  only what they switch off (see «Unattended turns load what the screen
  says, and never more»);
- the prompt (`heartbeat-prompt.ts roundPrompt`), its packet plus two STATE
  blocks that are no signal (`proactive.ts`): «Yours, open» (its open tasks
  with root `mission`) and «Yours, undone» (owner undo, Silos' taint undo,
  the owner's Drop — only when Silos recorded it: `task-cancellations.ts`
  reads the kernel's `set-field … → cancelled` by `owner` — else withdrawn;
  30 days from the cancellation when the plans journal dates it, else from
  the creation; never a refusal); 60 considered lines
  (`CONSIDERED_PROMPT_ROUND`; the file keeps 2000).
  The judge (`plans-provenance.ts judgeCreation`, API and file alike):
  every own creation stores its `root` (`'mission'` for signal mission, or a
  `task:`/`message:` whose root is — `Initiative.rootOf`; a message carries
  the root of the turn it was sent from, `messages.ts root`, stamped by the
  server: round/think ⇒ mission, look none, wake its task's, run its
  automation's creation's). Under a proactive regime (the sealed one; in a
  wake or run, `proactiveOf` now) a mission-rooted creation spends `perDay`
  (429 in its words — a wake's own), counts in `PROACTIVE_OPEN_MAX` (10)
  open, is never a literal duplicate of an open or undone one (409, the whole
  ledger), and on a round is ITS task (403 another owner, 400 a wait); a
  message of its own is no signal (403). By file the reader cancels with the
  same phrase. Editing an EXISTING task holds the same: a mission task the
  owner dropped (`ownerDrop`, Silos' record of the Drop) that its creator
  reopens is a resurrection — cancelled again and cut, as an undone one; its
  own done/cancelled one reopened from a proactive turn is a creation of that
  day (`Creation.reopenedAt`, counted by `madeFromMissionToday`; over the
  count or the open cap it goes back to what it was, with the API's words).
  A bearer has no reopen by API (claim and assign refuse a closed task;
  set-field is the owner's). Its own recurring work: with tools proposed only (403);
  without, `SELF_RECURRENT_PER_WEEK` apart from the day's count — never in
  the day's count nor the open cap. The audit
  (`initiative.ts afterAudit`, `resident/runs.ts`) reads `tools`: false —
  taint undoes and cuts; true — marks creations, proposals,
  messages, notes and the considered lines, never undoes or cuts, and bounds a
  sleep asked after reading outside to 3 days; the owner's credential cuts in
  both. What the agent page reads: `GET /api/agents/:id/heartbeat` → `proactive`
  (`index.ts proactiveViewOf`: position, setting, effective, why off, today's
  count/open, rounds a day, what holds it, the connectors a round would have),
  `skips` (today's, with their cause), `last.cause`/`last.tools`, `beats.rounds`,
  `lastTurn` (the last fire that took a turn, said apart from a later skip)
  and `staggerMinute`; what a run created is counted from the ledger
  (`initiative.createdOfRun`), the run's own record carrying no list.

**The proactive screen** — web only; words and
gestures in ONE module, `web/src/lib/proactive.ts`. `ControlSwitch` draws the
ladder [Only when told] [On its own] [Proactive] — three steps, the filled one is the
position the OWNER chose (`shownPosition`: stored `control` + `proactive`);
the markers (sidebar `MovesGlyphs`, Map › Org) read the server's derived
`positionNow` (`useAgentPositions`). Each touch's PATCH is `switchGesture`:
Proactive opens `ProactiveSheet` («Make X proactive»; on a task's page,
compact, a door to the agent's page), On its own from Proactive sends
`proactive: null`, Only when told sends the control (today's sheet).
The sheet sends `sheetBody` — period, `{perDay, tools}`, and `control:
'own'` from told so own's 409s come back with their doors. Its «≈ n rounds
a day, from HH:MM» and the period editor's ruler and consequence are
`stampPeriod` + `slotsPerDay` over the agent's `staggerMinute` (the period
the server will keep), never a reckoning of the screen. Rows: Heartbeat
(`heartbeatLines`: last turn · a later skip in the page's voice,
`skipRowWords` · Next), Proactive (count today, tools, or «Rounds are off ·
Allow again» on `off: 'cut'`); Measured adds «Heartbeat: n rounds today»
(`initiative.ts heartbeatDayLine`); Decided/Since mark « — after reading
<tool>» (`decidedRow`); Automations lists each beat «X's heartbeat · <period
words> · Run now» (`POST …/heartbeat/run-now`). e2e: `proactive.spec.ts` on
the stub claude (its round creates a task through the API; the undone one
is refused by the duplicate rule).

**The unattended provider** (`platform-settings.ts`) —
`~/.silos/settings.json` (0600, restore seal) holds `unattendedProvider`: a
provider id, or `null` = each agent's own account. Settings › Accounts & providers
«Unattended turns run on» (`GET/PATCH /api/settings`, owner only; 400 «no
such provider», or «<provider> runs on none of your agents' engines» when no
engine in use can run it). `ChatService.send` applies it to every
`unattended` turn that names no provider of its own — an automation's
`runsOn.provider` wins — and is not the owner's own chat resent at its
reset (class `chat`): it rides as the TURN level of the cascade, so both
engines honor it and the agent's `fallback` chain applies to the effective
provider. Per engine: an agent whose engine cannot run it (or an id that
no longer exists) keeps its own cascade, and Settings names those engines.
The conversation's column says «on <provider> · unattended setting» for the
last unattended turn the switch placed (session detail `unattendedOn`,
in memory). **The spend cap counts money only**: ChatService stamps every
turn's `chat-done` with `priced` (`providerPrices`: an API key —
anthropic-compatible or an engine key — prices; a Claude account or an
engine's own login is a plan), runs and wakes keep it, and `own-turns.ts`
sums `costUsd` (and counts «unpriced») only for turns not recorded
`priced: false`; the ceiling still counts every start it covers. The accept sheet's
brake words (`proposals-view.ts`) follow the same resolution.

**Automations** (Silos, `/automation/:id`) — the durable scheduler: agent
turns or plain commands without Claude, with history and an outcome per
run. Native cron only for one-shot self-pings. Every agent automation with
a folder runs with `projectSettings` (its folder's skills load; hooks stay
off). An agent's bearer creates (`POST /api/automations`, a template's
`use`) ONLY from its heartbeat's think turn (the turn token):
validated «self» (`automations-validate.ts validateSelfAutomation`: a cron
whose next 3 fires are ≥ 7 d − 1 h apart, a prompt never a command, no
`runsOn`/`inheritHooks`/`keepAlive`/`thread` in the body; Silos forces
`maxRunsPerDay: 1`, `approval: false`), judged by the ledger
(`Initiative.judgeAutomation`: the cut, a signal, `SELF_RECURRENT_MAX`,
then `judgeCreation`'s weekly initiative and `INITIATIVES_OPEN_MAX` — shared
with tasks), stamped `origin:'self'`, `createdBy`, `createdIn {run,
session}`, `signal`, `missionLine` and entered in `creations.json`; a
refusal enters as `rejected`, never a cut. Any other turn — attended
included — gets the 403 of its control's row (`control.ts
selfRecurringRefusal`) and proposes instead. On its own recurring work a
bearer's PATCH is an allow-list — only `paused: true`, registered
(`action:'paused'`); unpausing and every other field are the owner's — and
its DELETE (turn in `x-silos-turn`) withdraws it to
`~/.silos/trash/automations/` (`action:'withdrew'`, the owner's Restore ›).

**Proposals** (Silos, `server/src/proposals.ts` + `routes/proposals.ts`) — what an agent proposes and only the owner
decides: `POST /api/proposals` `{ kind: automation | skill | mission,
reason, input, turn }` by bearer, for itself; `~/.silos/proposals.json`
(restore-sealed). The server stamps `run` from the turn token (never the
body) and `inputHash` (every accept re-verifies it: 409 «it changed since
it was proposed…»); at most `PROPOSALS_PENDING_MAX` (3) pending per agent —
outside the weekly initiative; the resident expires a pending one at 14 d
(`decidedBy:'silos'`), and the agent hears every outcome in its packet's
`decided`. Accept (owner): an automation goes through the SAME create path,
stamped `createdBy`/`origin:'self'`/`acceptedFrom` (the owner's later edit
of its trigger/prompt/run makes it the owner's); a `run.command` one and
every mission are «Review ›» only (409 on accept) — the editor the row opens
carries the proposal id and its save resolves it (`edited and saved by the
owner`). A skill lives in `$SILOS_AGENT_STATE/proposed/<name>/` (outside
the plugin): its accept renames the tree into `~/.silos/skill-staging/`
FIRST (fenced from agents), validates what was moved (slug, real dir, no
link/hardlink/device inside, containment, collision, `contentHash`), gives
it back to `proposed/` on any failure, else renames it into
`plugin/skills/<name>` (+ manifest) — it loads at the next conversation.
Home's rows carry the server's words (`proposals-view.ts`: the brake of the
effective provider, «it starts when X's territory is on», «written after
reading the web») and fold per agent past `AGENT_INBOX_BUDGET`. The
end-of-turn audit's hooks are `restampRun`, `dismissTainted`, `byRun`.

**Initiative — the plans reader stamps and judges** (Silos,
`plans-provenance.ts` + `initiative.ts` + `creations.ts` +
`plans-origins.ts`) — agents create tasks by
append-item OR by editing `plans/*.plan.json`; both are judged by the
piece that READS the plans. Every reading of the plans silo
(`kernel.onReading`) and the kernel's journal of the convention (cursor in
`~/.silos/plans-provenance.json`) feed the stamper: an appeared task is
attributed ONLY by a WRITE in a live turn's transcript (Write/Edit path or
a shell write — never a read, never an mtime), the verdict waits for the
candidates' turns to end; one unattended writer ⇒ adopted and judged by
`judgeCreation` (the same function append-item calls before writing:
signal by turn class, `mission` only in a think, one initiative a week,
`INITIATIVES_OPEN_MAX`, the cut — reactive work has no numeric quota);
invalid ⇒ Silos cancels it with a note; adopted after its heartbeat turned
out tainted ⇒ undone at adoption. None or a tie ⇒ `by:'unknown'`: it stays,
is never startable by a bearer (`assign` 409), and only the owner's
explicit gesture blesses it («Keep it — it's mine», Give, the baseline's
«Keep them all» per folder). On a task that is not the actor's, an
unattended change is reverted field by field except appended notes
(`judgeTransition`, an allow-list); a creation for another owner is born
pending and clean; the restoration of what Silos cancelled or the owner
undid is re-cancelled + cut when the agent's unattended turn wrote it, else
adopted with its real author's label. The ledger of own creations is
`~/.silos/heartbeats/<agent>/creations.json` (quota, Decided, Measures,
Undo, Keep's `keptAt`); the ORIGIN of every task is
`~/.silos/plans-origins.json`; both restore-sealed. The file's
`createdBy`/`origin`/`signal`/`run` are a mirror re-stamped from them on
every reading. At the end of every unattended turn `afterAudit` re-stamps
the run's creations and proposals with `readOutside`; a tainted heartbeat
undoes them and is cut only when it created or proposed (an engine gap
alone never cuts). Doors: `POST /api/creations/undo`,
`GET /api/agents/:id/measures`, `/api/plans/origin[/keep]`,
`/api/plans/baseline[/keep-all]`, `POST /api/automations/withdrawn/:id/restore`.
Needs you: one due row per folder for the baseline («<n> tasks existed
before Silos watched this folder — Keep them all ›», kind `plansBaseline`),
a plan task's question marked «asked after reading the web (<tool>)» from
its run's 'ask' mark (the `silo` row's `readOutside`), and the cut row.

**Needs you** (Silos, Home; composed in the server, `server/src/inbox.ts`)
— what blocks on the owner: owner tasks, `waitingOn` the owner (quoting
`asked`, `options` as one-tap answers — and «Answer and open ›» for an
agent Only when told; also from ⌘K), messages that need the owner, what
sits untouched; «Coming to you» names what is on its way.

**Since** (Silos, Home; `server/src/home-since.ts`, `GET /api/home/since`) — what moved while the owner was away, counted
from the server's own records at zero tokens: plan tasks done (the kernel's
journal), automation runs, tasks stuck after their one wake (task mode),
what agents decided alone (the creations ledger — creations and lone acts
while they still hold), Needs you's count, the plan's weekly use by Claude
ACCOUNT (plan-usage's cache) and, on an API key that prices, today's
unattended $. «Since» is the owner's previous visit: `~/.silos/visits.json`
`{ homeAt }`, stamped by that GET only under the owner's credential (an
unknown GET has no effects) — the band counts from the value BEFORE
the stamp, and the web reads it once per tab.

**What a step re-reads** — in a conversation the Started with row
is «Context size» (`StartedWith.contextNow`: the latest reply's real input,
input + cache write + cache read) and says its consequence under it: two short lines, «Each
step re-reads about this much.» and «X re-read so far.», X = the cache-read tokens
of this conversation's own replies (`SessionContext.cost.byModel[].
cacheReadTokens`, the transcript's usage; its subagents are the Agents
block's). Only measured numbers: no re-read total → the first half alone;
an engine without `startedWith` (OpenCode) has no Context size row at all,
so nothing is said there. A relaunch says its cost before it is confirmed:
`rereadSentence(meta.contextTokens)` (`web/src/lib/context.ts`) — «The next
message re-reads the whole conversation, about N tokens.» — on «Restart
console»'s confirm (`Chat.tsx`) and in the Run on footer of a started
conversation (`ProviderPanel.tsx`: another account, model or output style
reuses no cache); no measured size (OpenCode's meta carries none) → null,
nothing said.

**Fan-out tokens** — the column's Subagents block (the disk census,
`ClaudeReader.listSubagents`) says on its header «N started · X tokens» and
each row its own tokens: a row's tokens are Usage's records for that
subagent's file, read through the SAME `UsageFileCache` the Usage page reads
(`usage-records.ts subagentBill`: one message id once, input + output +
cache read + cache write) — so the census and the conversation's Usage row
never disagree, and a file is parsed once for both (finished files are
remembered by bytes+mtime, a live one pays only its appended bytes; in
memory, never in the session cache — no `CACHE_VERSION` bump). Usage's
`usageRecords` reads the same file set as the census: every
`agent-*.jsonl` under `<session>/subagents/`, nested workflow folders
included. Measured on 5 × 40 MB subagent transcripts: first census
~0.7 s, again ~10 ms, and Usage's read after it ~2 ms (no second parse);
worst loop stall 32 ms on the heavy-lines bench.
OpenCode has no census (its reader is not file-backed: a `task` subagent is a
child session inside its parent's tool call): it lists them from the session's context in the same «Subagents» block, without tokens and without a door to a transcript the server cannot serve.

**Usage** (Silos, `/usage`) — what the fleet spent,
from two sources never summed twice. The TOKENS come only from the
transcript: the harness contract's `usageRecords(folder, id)` gives a
conversation's assistant records (time, model, tokens, and the price by the
engine's own table — neutral code never names `model-prices.ts`), one per
message id, subagents included; an engine without it is «not measured on
<engine>»; `silosOwnUsage` reads the titler's tmp-folder turns («Silos
itself»). The WINDOWS — `~/.silos/usage/<YYYY-MM>.jsonl`
(`usage-ledger.ts`, 0600, in `DATA_DIR_DENIED`, out of the seal) — say who
and why: `ChatService.send` opens a turn's window at its chat-init (class,
heartbeat kind as data, task, automation, run, gesture, provider, account,
priced; a run's `runOf` — own · accepted · yours — SEALED there from the
automation as it is then, so deleting or accepting it later never rewrites
a past day) and closes it at its end (done · failed · cancelled; `timeout`
stamped first by the resident, which decides it); a boot closes what a
dead process left open `interrupted` at the conversation's last record; a
console's window (`TerminalService` `consoleLife`) lives while its tmux
does — consoles survive a restart — and matches by THREAD, so a `/clear`
stays inside it (the thread root walks the WHOLE chain, cycle-guarded); a
live console found without a window at a listing (boot and every periodic
one) gets one opened then, under the agent Silos knows it by — what it
used before stays unattributed. The ledger's append starts a fresh line if
the file ends mid-line, and its loader salvages every whole event of a
glued line. `usage-attribution.ts` drops each record in the window of
its thread that held it (the latest-opened wins an overlap: a console and a
wake on one file are split); subagents ride their conversation, nested
sessions (birth marker) their parent's thread; dedupe by message id is per
thread (a `--resume` copies records); ONE day rule — a record in a TURN's
window counts in the local day its window OPENED (rows, bars and the caps'
line alike; a turn across midnight is the day it started); a console's
records (its window lives for days — Today shows what it spent today) and
what falls in no window go by their own time; By conversation names each row's agent, classes and day (the 20 largest, the rest one «N more conversations» row with their sum); what falls in no window is
«Unattributed» (with its conversation), before the register «before
<date>», never backfilled — its money (and «Silos itself»'s) is its
conversation's provider's (the thread's latest window), else the machine's
default; a plan stays without dollars. The LEDGER is the list of what ran:
each window's transcript is read by its own {folder, id} — a muted or
ephemeral folder, the trash while it is there (`ClaudeReader` looks in
`<dataDir>/trash`) — so hiding or trashing a conversation never changes a
past day; a window whose transcript is gone stays a counted turn «not
measured — its transcript is gone»; a conversation the sidebar does not
list is «Hidden conversation», no title, no path. The transcript cache is
bounded (least recently read files forgotten past 150k records) and a read
builds one id → meta map for its thread walks. One money: a turn that ended without its price
(failed, cancelled, timed out, cut) gets its transcript's cost written where
`own-turns.ts` reads it (`AutomationsStore.patchRunCost`,
`TaskModeEngine.costFromTranscript` — never over a price the engine said).
`GET /api/usage?period=today|7d|30d&by=agent|kind|task|automation|conversation|account
[&agent]` (or `from&to`) is the owner's read (outside every bearer's); a
named period's range is the SERVER's local days — the page never computes
a day, and names them by the report's `today`/`sinceDay`. A turn on a plan
shows tokens and «on plan», never dollars. A record whose model has no row
in the engine's table is counted (`unpriced`) AND named (`unpricedModels`
on each row and the totals; the conversation's `cost.unpricedModels`):
Usage and the column say «no price for <model>» (`web/src/lib/usage.ts
noPriceWords`, the one wording), never a bare «unpriced».

**Vitals** (Silos, `server/src/vitals.ts`, `routes/vitals.ts`) — derived backwards, never
sampled. `GET /api/vitals` (the owner's read, outside every bearer's):
`runs` = 30 local days of automation runs that ran (ok · failed · running,
on their start day; the runs files folded by id and read incrementally —
only appended bytes, sliced), `executions` = the kernel kind `execution` on
its ledger's last-write day, `fleet` = today's agents at their derived
position (`control.ts positionOf`) plus 90 days built from the birth markers
(born on the first marker's day) and the control log
`~/.silos/fleet/control.jsonl` (`fleet-events.ts`: the owner's PATCH writes
each move with its `from`; every vitals read reconciles a move made by
another path — a cut, the fence off — and writes a `seen` baseline for an
agent never logged; before an agent's first change it sits at that change's
`from`). The owner's `GET /api/automations` carries `usage30d` per
automation (null: a command) and `usageTotals30d`: each finished run's
conversation → the engine's usage records (the index's `usageRecords`, the
same reader and price table as Usage) inside the run's [start, end], read
ONCE per run and cached in `~/.silos/vitals/run-usage.json`; a run on a plan
(`priced: false`) counts tokens, no dollars.

**Messages** (Silos API `/api/agents/<id>/messages`, `routes/messages.ts`;
store `server/src/messages.ts`) — between agents
(and from the owner). No message wakes anyone: there is no urgency (an
`urgent` field is a 400 that says why) — a message is read at the
recipient's NEXT conversation, any conversation starts with its inbox; work
that cannot wait is a task and its start (`assign` of one's own, or the
owner's gesture). The store is the server's, `~/.silos/messages/<to>/<id>.json`:
fenced from every agent (`messages` in the fence's data-dir deny list) and
under the seal's _restore_ regime — memory is the truth, a file forged or
edited on disk is never served until «Keep the edit».
The store is keyed by recipient; `GET /api/agents/<id>/messages/sent` is its
one read by sender (`sentBy`): what that agent sent, across every inbox, with
each message's live state and answer — the agent page's Messages tab merges it
with the inbox into one list (`web/src/lib/messages-view.ts`: direction,
filters, date bands; a settle lands in the recipient's inbox). Same readers as the inbox (owner or the agent
itself), and a pure read: it marks nothing.

- _The reader_: a turn WITH hooks (a console, the owner's chat, an
  `inheritHooks` run) lists its inbox at SessionStart (`inbox.py`); a Claude
  turn WITHOUT hooks (wakes, runs, heartbeats) gets the same text in its
  append (`claude-code/headless.ts withBriefing`, `harnesses/inbox-text.ts`
  — the byte-for-byte twin of `inbox.py`), and every OpenCode launch in its
  context file (`opencode/assemble.ts`) — never twice.
- _Read is the server's mark, by the CLASS of the turn served_
  (`message-reads.ts`): a console or the owner's chat marks
  `read` at serving (the GET's `$SILOS_TURN`, or an attended OpenCode launch
  composing its context); an unattended turn (wake, run, heartbeat) is served
  WITHOUT marking — its briefing, its packet's `message:` keys and its GETs
  are noted on the live turn and marked only when the turn ends WITH output
  (`ChatService.send`, both engines); a bare bearer, the owner or an unknown
  reader never marks. The recipient still closes a message itself
  (`answered` with its answer / `needs_owner`).
- _Provenance_: a bearer's message carries its turn's `run` (stamped by the
  server); at the end of that turn its `readOutside` is re-stamped
  (`initiative.ts afterAudit`) and painted in the briefing line, the packet
  line and the Needs you row («— sent after reading the web (<tool>)»).
- _Needs you_ (`inbox.ts unreadMessagesRow`): one due row per recipient ·
  sender at the recipient's next chance to read — no heartbeat that looks
  (told, own·never): 24 h unread (`MESSAGE_UNREAD_ROW`); a heartbeat that
  looks (own·day/week): only once its next heartbeat after the message
  passed without marking it, with why («it hasn't looked yet: …»). Folded
  per agent with failed runs, the ceiling, spend and the cut.
- In a silo record, «Make it a task for X ›» (`POST
/api/silos/:id/record/make-task`) turns a template into a task of the
  producer in its project's list (assigned when it is On its own).

**Silo Standard** (`docs/standard/`) — a kernel plus installable silos
(the set Silos ships in `docs/standard/reference/`), each declaring its own
rules and producer agents (`~/.silos/silos/registry/`). Silos is built of
silos, every one removable, in two tiers (`silos/native.ts` + `catalog.ts`
`shippedLineup`, sent as `lineup` on `GET /api/silos`): **recommended** —
Plans, Task mode, System: the `builtin` rows, installed at boot
(`installBuiltins`), each with a `loses` sentence the uninstall confirmation
and the first run say; an uninstall is respected forever — and **optional**
— Support, Hierarchy, Executions, Heather: every other reference file, offered
by the catalog, installed only by the owner. Everything else is the owner's
own (submitted or pasted). A recommended silo that is not active is named
where its feature would be by ONE quiet door (`web/src/components/silo/SiloDoor.tsx`:
Tasks, the new agent's «also on its own», System's Vitals) landing on its
install dialog; an installed silo's feature is never labelled as a silo.
The standard's tests use the shipped manifests plus generic fixtures
(`server/test/fixtures/silos/`) for what no shipped silo exercises (a sync
producer with an owner overlay, a project-anchored source). A manifest's `producer.role` is a word, never
an agent id: who produces is only the binding — the owner's at approval
(`operator.json`), or, for a built-in, the agents whose state already holds
its files (an install that had Support or Executions while they were
built in keeps them, provenance and all; the boot no longer visits them).
A silo nobody is bound to has no producer yet: its page says
«No producer yet · Bind ›», Home never routes its rows, «Make it a task»
has nobody to give it to. With several bound, the
producer of a RECORD is the agent that wrote it while bound and in play,
else the first in play (`surfaces.ts` `recordProducer`, read by Home's
board, `GET /api/board`, and by the record's message and make-task): one silo serves several
projects with one bound agent each. The binding is changed on the silo's
page («Change who writes it») and named on each bound agent's Who card
(«Writes Support ›»).
**A silo can bring a look** (`docs/standard/conformance.md`, check 12 and «Looks») —
`spec.theme` = `{name, light, dark}` in the standard's own token words
(`catalogs.md` «Theme tokens»), `#rrggbb` only; a silo may be nothing but a
look (the reference `heather`). The rule — vocabulary, thresholds, contrast
maths — lives ONCE in `server/src/silos/theme-rule.ts` (pure, no imports):
the validator's check 12 rejects a failing pair with its figures, the
registry offers a theme in `GET /api/silos` (`theme`, accent-soft derived)
only while its silo is active and only if it still holds the rule, the
installer's consequences carry `derived.look` (name + resolved colours) and
an update's line for it (`validator.ts lookChange`); the web imports the same
module (`web/src/lib/theme-contrast.ts` re-exports it) to measure its
built-in themes. The words become theme.css's names in ONE place,
`web/src/lib/themes.ts` (`WEB_TOKEN`, `siloTheme`: shimmer, dark console
frame and selection derived; never fonts, status colours or the ANSI
palette). Choosing stays per browser (`lib/look.ts`): a silo look's id is
`silo:<id>`, its resolved tokens are cached in `silos-look-cache` so the
bootstrap paints it before `/api/silos` answers, and `reconcileSiloLooks`
(after every silos load) refreshes the cache or drops it — a look whose silo
is gone falls back to the default silently.
**Silo and role pack stay two packages**: a silo is the work —
protocol, records, views — and never carries an agent's identity; a role pack
is who — name, mission, skills — and may NAME silos. They meet in one install:
a role pack binds its agent to the silos it names, or submits them for the
owner's approval (`routes/role-packs.ts`).
An agent's own submission proposes its author as the producer (the
dialog's default; the owner still binds).

What a silo route reads or renders on behalf of an agent bearer is bounded
by that agent's territory — ONE bound, `server/src/silos/bearer-scope.ts`:
its own state (`agent:<self>`) and the project folders inside its
territories, never another agent's state, drafts or folders, before or
after approval; the owner's credential keeps the full view. Validate and
submit read only the bearer's own draft and dry-run over that bound (the
preview of a glob aimed elsewhere falls back to the examples); the merged
view, proposals and append-item judge the record KEY before any lookup
(the same 403 whether the record exists or not). Append-item bounds
agent-state keys only: plan files in project folders stay shared by
convention (below). The id rule (a dimension Silos serves natively or the
engine owns) lives in the validator, check 2, so validate, submit (409
`native`) and `silo-check` answer it alike.

A kernel silo presents data Silos keeps itself (kernel kinds,
`docs/standard/catalogs.md`): its producer is the kernel and nobody is bound.
**System** (recommended, pulse born off) is the processes conversations
left on this machine: every 30 s `silos/processes.ts` reads `/proc`
(asynchronously, bounded; no `/proc` = no data), attributes each process tree
to its conversation by the session variables it inherited (`SILOS_SESSION_ID`
and each engine's `traits.sessionEnvKeys`), never lists an engine's own
process, says `left running` when nothing of that conversation runs (no turn,
no live console of its thread, no holder, no engine alive in the table) and
stores the command REDACTED. Its one mutation is the first **kernel-verb**,
`stop-process` (closed catalog in `silos/kernel-kinds.ts`
`KERNEL_VERBS`, the kind's `verbs` names it): the owner only
(`POST /api/silos/system/record/kernel-verb {key, name}` — an agent bearer is
refused, it stops its own processes from its shell); the engine re-reads the
table, verifies the root by pid AND start time, signals the tree as it is now
(SIGTERM, then liveness re-read every ~100 ms and the answer as soon as the
whole tree is gone — up to ~5 s grace, SIGKILL survivors re-verified), never Silos'
own tree (`origin: silos`) nor another user's (`origin: other-user`), and the
record reads `exited` «stopped by you» at once. Every record carries the
guard `stoppable`. A conversation's live processes are
`GET /api/sessions/:folder/:id/processes` (its whole thread,
`conversation-thread.ts` — the same resolution the engine attributes by);
deleting a conversation stops them only with `stopProcesses: true` and only on
the thread's tip (the console rule) — on EVERY engine: the delete route
(`routes/sessions.ts`) asks the engine only what deleting means
(`traits.deletion`: the fallback's trash, another engine's hide); the rest is
one neutral path for both — the tip measured once, the conversation's live
Silos console(s) closed (its own id, the ancestor `consoleKeyFor` names, the
Silos key bound to its native id), the processes named before the index
forgets it and stopped after the delete succeeded, the same
`processes: {stopped, notStopped, says}` beside `hidden: true`. A records read after a scan re-reads the
silo once (`freshenSilo`): numbers at most one scan old, no journal line.
The pages draw a kernel-verb generically from the descriptor (`views.ts`
`kernelVerbsOf`): the records page's `kind.verbs` ({name, says, pending,
guard} — the door's word is the catalog's `says`, and from the click until the
answer and the re-read records it reads the catalog's `pending`, «Stopping…»),
each row's `verbs` (the names whose `when` holds now), and the record's action
`{name, says, pending, guard, applies}`;
the guard field is the door's bookkeeping, kept out of the record page's
fields. Where the owner meets them: the conversation's column «Processes»
(folded, absent with none; one read on opening, then the `silos` signal —
no poll of its own), Stop on the System list's rows and record page, and the
sidebar's Delete, which names the live ones and offers «Also stop them»
unchecked.

System's second kind (System 0.3.0 — its manifest has TWO kernel
sources, each feeding the kind named like the kernel kind it presents,
`kernel-kinds.ts kernelFeeds`; the page switches between `list` views by
their `label`, `/silo/system/v/worktrees`) is the **worktrees** conversations
left: every 60 s `silos/worktrees.ts` runs `git worktree list --porcelain` in
every project folder that is a git main checkout (`siloLocations.projects()`),
and per linked worktree `git status` (the commit counts cached by HEAD and
the default branch's tip) — all async (`execFile`, a timeout, 4 at a time, a
tick that never overlaps itself). Each record says `ahead` and `landed`
(`git cherry`: a cherry-picked branch is not unmerged work), `changes`,
`leftovers`, the processes inside (`ProcessRecords.inside` — the `process`
kind's last scan; `/proc` is read once), and the conversation: the sessions
an engine places in it (`HarnessReader.worktreeSessions` — Claude Code: a
transcript moved under the worktree's folder key, a subagent's
`agent-<id>.meta.json` `worktreePath`), a conversation whose cwd is inside, a
process's session. States `in-use` (the one liveness rule above, or a process
inside) · `merged` · `unmerged` · `removed` (quiet). The kernel-verb
`remove-worktree` (owner only, guard `removable`) re-reads every fact live,
writes a `git bundle` of a branch that landed only by patch and MOVES every
untracked and ignored file into `~/.silos/trash/worktrees/<moment>-<name>/`
(the trash's 30-day purge empties it), then `git worktree remove` (never
`--force`) and `git branch -d` (or `-D` after the bundle); never the stash.
**Silos closes merged worktrees by itself**: merged, removable and idle 6 h
(`WORKTREE_IDLE_CLOSE_MS`, from the latest of the last commit, the `.git`
file's birth and the last time Silos saw it in use or changing) → the same
path, `removedBy: silos`; an unmerged one never. Always on;
`SILOS_NO_WORKTREE_SCAN=1` turns the scan off (and `SILOS_PROC_ROOT` points
the process table at a fixture `/proc`: an isolated server reads none of the
machine's processes). It raises nothing in Needs you:
a silo's needs-you entries read ONE kind (the pulse's, `voice.ts
needsYouKind` — System's is `process`) and System declares none, so «N
worktrees hold unmerged work nobody touched» stays on the view (its `first`).

**The machine's vitals** (`server/src/machine-sampler.ts`, `GET /api/system`
in `routes/system.ts`) — disk and RAM cannot be
derived backwards, so they are sampled: the resident's tick (the titler's
lane) samples at the first tick of each process and then hourly, appending
`{at, disk:{capBytes,usedBytes,bytes}, mem, load}` to
`<dataDir>/machine/<YYYY-MM>.jsonl` (UTC month; 12 months kept, older files
deleted on write). Disk attribution: `transcripts` = the roots of the
file-backed readers (`SessionIndex.transcriptRoots`), `trash`, `worktrees`
= the live `worktree` records' dirs, `agentState`, `other` = used − sum.
Sizes from `du -sb` children (bounded timeout; a timeout leaves the group at
0, its bytes in `other`), the disk from `statfs` on the dataDir — never a
walk in-process. The route serves the last sample per local day (30 days),
the last per UTC hour of memory (7 days; an hour with no sample is absent —
a gap the web draws, never interpolated), `now`/`trash` from the latest
sample, load and total memory live.

## A task's life

1. The owner gives a task to an agent in New task («Give to X» starts an
   agent On its own; «Give and open …» opens one Only when told with it;
   «Save for later» leaves it pending). An agent may also write one in `plans/` for another agent;
   a message to that agent is read at its next conversation, and starting
   it is the owner's gesture.
2. Given to an agent On its own: Task mode wakes it in the task's
   conversation. Only when told: it waits for the owner to open it.
3. The session's briefing tells the agent who it is; it claims the task and
   works.
4. Needing the owner, it leaves `waitingOn` with its question → Needs you
   with buttons.
5. The owner's answer (`POST /api/tasks/act` `answer`: the note, the wait
   out, the state — one write) wakes the agent in the same conversation.
   Its finished work waits in `in_review` on whoever it names; the owner
   Approves (done, nothing woken) or Sends back (answer → pending).
6. It releases with `done`; what depended on it is unblocked and a bound
   owner of it wakes; repeat.
7. Needing another AGENT — a question or a review, not work (work is a task
   of that agent and a `dependsOn`, in the same plan file) — it asks through
   Silos (`POST /api/tasks/ask`): the request wakes nobody, the other agent
   sees it at its next heartbeat or conversation start, and its answer
   (`POST /api/tasks/ask/answer`) lands on the task and wakes the one who
   asked.

**Every open task has a next** (`silos/task-flow.ts` is the one source, held by
`server/test/task-flow-invariant.test.ts`): a guard — a LIVE conversation (`taskLive`, the 2 h
rule), a wake on its way, a person owning it with nothing open below, a next
check someone fires, a guarded blocker chain — or a stall, or one of the
owner's rows. `own()` is written once, in order (closed · live, a wait or a
check ahead (an AGENT's `in_review` before that: guarded only by a reviewer
named — a `waitingOn` whose owner is not the task's own, Silos' `unstick`
wait included; a next check reviews nothing, a wait on itself is
`review-without-reviewer` and no relay row — `reviewerNamed`) · nobody owns it → `unowned` · a bound owner's past
check · a person's review · open dependencies → walked, a PERSON's too, except without the
request's live facts · a person's → guarded · blocked naming nothing →
`blocked-on-nothing` · the agent's own). Nine causes, one meaning each
(among them `unowned`, `blocked-on-nothing`, `blocker-missing`,
`blocker-cycle`). The walk has no depth cap and looks at
each task once per call. Every stall has a SEAT (`stalledAt`, by position:
the bottom of the chain, the task that declares a dead link, each member of a
cycle — its `stalledBy` the next member — or the first member a task reaches)
and through it ONE way out (`stallExit`): a bound seat whose owner can clear
it is Task mode's `stalled` wake (a cycle's names the other member); every
other seat is one of the distinct seats Needs you's «N tasks sit untouched»
counts (nobody's, a person's, an unbound agent's, owner-cannot-run); a task
seated elsewhere has its seat's way out — no wake, not counted, and in «Coming
to you», the turn sentence («Waiting — waits on …») and `view=untouched` it is
not «stalled» (they read `stalledAt === id`). A dependency on an id the plan's
file holds but can't build (`KindRecord.unreadableSiblings`, from the reader's
remarks — `voice.baseRecordOf`) is guarded by the «can't be read» row: no
stall, «waits on <ref>, which Silos can't read». The stall episode's shape
carries its blockers' states (a chain cause that goes and comes back is a new
episode). `idle` («Not started
— nobody is on it») asks for no conversation LIVE, not for none listed; a
past `nextCheckAt` guards only a bound owner's task (Task mode fires or
clears it — anyone else's falls to the owner's start or `owner-cannot-run`);
a `blocked` task whose declared dependencies are all done, with no wait and
no check ahead, reads as `pending` in every reader (`taskStateRead`). The
kernel's `idle` / `waitsStart` / `live` ride Task mode's snapshots with the
stall (`voice.taskFlowRecords`): the heartbeat's «yours» reads `idle`, and the
owner's «Start X ›» is refused only by a live conversation (a bearer's assign
keeps its lock on any current one). A wait naming an agent is one of two: Silos carries it — an ASK linked and in reach, a guard
(`flow.asked`) — or it is `waitsOnRelay`, the owner's to relay, its row in
Needs you «X waits on Y — <action>» (the task page says which: «Y sees it at
its next beat» / «you relay»). Task mode supersedes a
`stalled` wake whose episode no longer exists («the task moved on first»);
every hold on a queued wake carries its class (`Wake.holdClass`); «Open chat»
marks the wakes it folds in delivered when its turn starts. A console hold
writes the conversation holding it (`holdSession` — absent when the tmux probe
failed: `CONSOLE_UNSURE`, never said open) and its first pass (`heldSince`),
both carried over a pass that stops earlier at the engine, a retry or the
limit; Needs you reads them from the store alone (never a tmux probe) for
«X's console on «title» is open and idle — N wakes wait for it» (due, one per
conversation, its thread not live past the 2 h rule, Seen by conversation +
heldSince). A read that fails never lets go of a hold: a limit hold keeps its
`until`; an engine hold is kept at most `LIMIT_RETRY_MS` from the first failed
read (`engineUnreadSince`, «Silos couldn't read its engine»), then it goes. Two more rows:
«N closed plans still have open tasks» (routine, read from `plans/closed/`
through `plans-closed.ts`, never a list) and «N tasks in <plan> can't be
read» (due, the reader's why — the same why the 404 of claim / assign /
release gives for an id the file holds but can't build).

**Agent ↔ agent: ONE fact per task** (`server/src/task-asks.ts`). Two fixed rules: the REQUEST never wakes the other agent, the ANSWER wakes the one who
waits. For work nothing is built (a task of the other agent + `dependsOn`).
For questions and reviews:

- _The fact._ `POST /api/tasks/ask {plan+task | key, to, action, asked?,
review?, turn}`, the bearer of the task's OWNER (another's task 403; the
  owner's credential 403 naming its own verb, `act answer`), stores in Task
  mode's store `armed[key] = {to, action, asked, at}` (action ≤ 80, question ≤
  500 — exactly what the file gets) and writes the plain wait of today, no id
  in the file: `waitingOn {owner: to, action, asked}` + `blocked` (`in_review`
  with `review`). Every judgement happens inside the write's mutator on the
  file read now; 409s in their words (closed, `to` itself / not in play / the
  owner, another wait already, a review with an open dependency, Silos'
  `unstick` prefix, the daily `ASKS_PER_DAY`, and «asked N times today on
  this task» once `ANSWERS_PER_TASK_DAY` `answered` wakes of that answerer on
  that task were delivered in 24 h — the cap is at arm time, nothing held). A
  repeat is idempotent and never renews `at`; re-arming over its own linked
  wait replaces it keeping `at`; a hand-written identical wait is adopted. An
  ask from an unattended turn carries the existing `ask` mark. `armed` and
  `armsToday` are copied field by field in the store's `load()`.
- _Linked is derived._ At read time the file's wait matches the fact in
  owner, action and `asked ?? ''` (`task-flow.ts askLinked`, `TaskEnv.askOf`;
  a reader without the key reads the relay). A fact goes only when answered,
  replaced by the task's next ask, or `WAKE_KEEP_MS` old — never by
  comparison: a wait that stops matching (edited by hand, the store reset, a
  plan unreadable or `plans()` null at boot) simply reads as the relay, and a
  read that fails changes nothing.
- _Reach._ Linked on an AGENT's open task and the asked agent's next
  heartbeat counted FROM the ask (`askSeenByOf` → `period.ts nextSlot`, never
  from now — it does not flicker) within `ASK_REACH_MS` (24 h), and only until
  then, it is a guard (`flow.asked`) and no relay row; an asked agent not
  bound, Only when told, archived, without a period or asleep past it is the
  relay from minute zero. Silos' own wait is never relay; a task of the owner
  (or a person) waiting on an agent always is.
- _Seen._ The asked agent sees its linked, open asks — the text from the
  store, never the file — at a start (`inbox.py` GET
  `/api/agents/<self>/asks`, and its byte-pinned twin `inbox-text.ts asksText`
  for every turn without hooks and every OpenCode launch) and in its
  heartbeat packet (`ask:<taskKey>`: enters when armed, relisted after
  `PACKET_RELIST_MS`, past its reach too; `later`/`dropped` suppress it; a
  listing in a failed run does not count; `ask:<key>` is a signal of that
  heartbeat). The ASKER's packet lists its own wait once, at birth, as carried
  («<Agent> sees it at its next beat — nothing to do», `flow.asked` riding
  Task mode's snapshots as `TaskSnap.asked`), never weekly; flipped to the
  relay, the weekly `wait:` line returns.
- _The answer._ `POST /api/tasks/ask/answer {key, text, turn}`, the bearer of
  `to`: judged inside the mutator on the file read now (open, linked NOW),
  then ONE write — the note `by: to` (≤ 8000), the wait out, `in_review` →
  `pending`, `blocked` → `pending` when nothing else holds it; only when it
  landed does one store update consume the fact and queue an `answered` wake
  for a bound owner (its text in `wake.notes`, under the day's ceiling, never
  a gesture nor a bypass). A write that fails keeps the fact; answering twice
  is 409. An answer from an UNATTENDED turn: its wake is held with the
  existing `turn` class until that turn's audit is registered (the note then
  carries the audit's readOutside), or — the turn gone and no audit
  `MISSING_KEEP_MS` after — it goes marked «transcript unreadable»; its note
  is marked with its run (`markNote`).
- _Silos' write._ Every write of the ask and its answer is Silos' own, registered with the stamper
  (`PlansProvenance.ownWrite`: expected, and the snapshot's base for that
  key), so an unattended turn that answers and edits the same plan never
  reverts it.

**Read once per pass** (`server/src/pass.ts` — the event loop the
owner's consoles ride on must never freeze for seconds): a task's flow is evaluated ONCE
per synchronous pass, whichever readers ask — the inbox's lines, Task mode's
snapshots and look, the escalation, Home's board, a records page (`taskFlow`
memoizes on the reading's own objects, the clock, the agent test and the
live facts; `taskFlowEvaluations()` counts the work). A pass ends at the next
microtask, so nothing survives an await; a writer of what a flow reads ends
it early (`endPass()`: Task mode's store and its turns in flight, the agent
registry, the territory store, the kernel's refresh, the thread cache's drop).
`index.ts` keeps its per-pass task map (`tasksThisPass`, also behind
`taskNowOf`) the same way. A task's liveness asks its own thread's
conversations — `threadMembership.sessionsOf` is `belongs` indexed once per
membership (5 s, like the chains) — never every conversation of the install.

**Silos writes in plan files too** (team-plan lists it for agents): claim
and release (the owner's with its wait), the owner's gestures (`act`: Done /
Drop / Reopen / Park / Resume / Remove the dependency / answers / Approve /
Give to…), the owner's note and the reopen it carries in the same write, a
task the owner creates through Silos (`new`: born with its note and
conversation), Task mode's cleared `nextCheckAt`, an escalated stall
(`blocked` + `waitingOn`), an ask through Silos and its answer (the asker's
wait and state; the answerer's note, the wait out, the state), the project's
list's rotation. An agent re-reads
before it writes. Plan files are protected by convention only: the fence
does not stop an agent editing another project's `plans/`.

## The API and the environment

**`/api` is the web client's private API.** Its routes change with the UI
and carry no compatibility promise, with two exceptions that are contracts:

- **The agent-facing subset** (`server/src/agent-authz.ts`) — what a request
  with an agent's bearer token may do. Reads: the roster and the agent's own
  record (`/api/agents`, `/api/agents/<self>/…`), automations (without run
  logs), its own silo merges and proposals, its tasks by session. Writes:
  messages (`POST /api/agents/<id>/messages`, `PATCH` its own), its own vault
  bindings, its own automations (`POST`/`PATCH`/`DELETE /api/automations…`,
  templates' `use`/`preview`), proposals, tasks (`claim`, `release`,
  `assign`, `ask`, `ask/answer`), its heartbeat (`considered`,
  `heartbeat/sleep`), silo records (`record/append`, `validate`,
  `submissions`, its own `records`/`proposals`), and every verb on the signer
  route `/api/egress/<NAME>/…`. The plugin's hooks and skills use only this
  subset.
- **Webhooks** — `POST /api/hooks/<automation id>`, authenticated by the
  automation's secret in `x-hook-secret` (no token, no session).

**Environment.** Everything is optional; the defaults are a local install.

_Operator settings:_

| Variable                            | Default                              | What                                                                                                                                                       |
| ----------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SILOS_DATA_DIR`                    | `~/.silos`                           | Silos' own state (agents, token, trash, cache, silos…)                                                                                                     |
| `SILOS_ROOT`                        | `~/.claude/projects`                 | where Claude Code's transcripts are read                                                                                                                   |
| `SILOS_HOST`                        | `127.0.0.1`                          | bind address (`0.0.0.0` only in a container behind its proxy)                                                                                              |
| `SILOS_PORT` / `PORT`               | `3210`                               | listening port; `PORT` is the PaaS fallback, `SILOS_PORT` wins                                                                                             |
| `SILOS_TOKEN`                       | generated into `<data>/token`        | fixes the owner's access token (and rotates it when changed)                                                                                               |
| `SILOS_PUBLIC_URL`                  | Railway's domain, if any             | this instance's public origin (its Silos ID registration); may also live in `<data>/server.env`                                                            |
| `SILOS_ID_URL`, `SILOS_OWNER_EMAIL` | —                                    | remote sign-in through a Silos ID broker (`docs/deploy/railway-template.md`); may also live in `<data>/server.env` (the environment wins)                  |
| `SILOS_TELEMETRY`                   | on                                   | `off` stops telling the Silos ID broker this instance's daily use (hours open, turns, version — `instance-usage.ts`); may also live in `<data>/server.env` |
| `SILOS_OPENCODE_BIN`                | `opencode` on `PATH`                 | the OpenCode binary                                                                                                                                        |
| `SILOS_OPENCODE_DATA`               | `$XDG_DATA_HOME` or `~/.local/share` | where OpenCode's database is read                                                                                                                          |
| `SILOS_TMUX_SOCKET`                 | `silos`                              | the tmux socket name the consoles live on                                                                                                                  |

_Test-harness switches_ (the e2e harness and isolated servers; not product
settings): `SILOS_HOME` (the home whose `~/.claude` is read),
`SILOS_CLAUDE_MANAGED_DIR` (Claude Code's managed-settings dir),
`SILOS_WEB_DIST` (the served bundle), `SILOS_PROC_ROOT` (a fixture `/proc`),
`SILOS_NO_EPHEMERAL=1` (show sessions under the OS tmpdir),
and the background readers each turned off with `=1`:
`SILOS_NO_AUTOTITLES`, `SILOS_NO_DIGEST`,
`SILOS_NO_PROCESS_SCAN`, `SILOS_NO_WORKTREE_SCAN`,
`SILOS_NO_TASK_WAKE_DELIVERY`, `SILOS_NO_ACCOUNT_LOAD`,
`SILOS_NO_MODEL_CATALOG`.

The other `SILOS_*` names (`SILOS_API`, `SILOS_AGENT_ID`,
`SILOS_AGENT_TOKEN`, `SILOS_SESSION_ID`, `SILOS_TURN`, …) are set BY Silos
inside the agent processes it launches, for the plugin's hooks and skills;
an operator never sets them.

## Where to look

| Concern                                                                                                                               | Code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| plan files read/watch                                                                                                                 | `server/src/silos/reader.ts`, `server/src/knows-watcher.ts`, `server/src/plans-closed.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| whose turn a task is                                                                                                                  | `server/src/silos/turn.ts`, `task-flow.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| claim/release/assign/link                                                                                                             | `server/src/routes/console.ts`, `plugin/context/recipes/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Task mode wakes                                                                                                                       | `server/src/task-mode/`, `conversation-live.ts`, `turn-slots.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| agent ↔ agent asks                                                                                                                    | `server/src/task-asks.ts`, `silos/task-flow.ts` (`askLinked`, `askReaches`), `routes/console.ts` (`/api/tasks/ask`, `/api/tasks/ask/answer`, `/api/agents/:id/asks`), `heartbeat-packet.ts`, `plugin/hooks/inbox.py` + `harnesses/inbox-text.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| control and heartbeat                                                                                                                 | `server/src/control.ts`, `heartbeat*.ts`, `resident/heartbeat.ts`, `own-turns.ts`, `routes/heartbeat.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Needs you                                                                                                                             | `server/src/inbox.ts`, `harnesses/inbox-text.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Usage                                                                                                                                 | `server/src/usage.ts`, `usage-ledger.ts`, `usage-attribution.ts`, `routes/usage.ts`, `harnesses/claude-code/usage-records.ts`; web `components/UsagePage.tsx`, `lib/usage.ts`, `lib/usage-door.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Home's Since, Welcome and an agent's first minute                                                                                     | `server/src/home-since.ts`, `routes/board.ts`, `slug.ts`, `routes/agents.ts`; web `lib/since.ts`, `components/home/SinceBand.tsx`, `components/Welcome.tsx`, `components/agent/FirstMeeting.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| fence                                                                                                                                 | `server/src/territory.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| what a conversation loads (Tools, Skills' account rows, Memory's personal switch, the alert, the starting set)                        | neutral `server/src/folder-loads.ts`, `tool-health.ts`, `start-health.ts`, `switch-proof.ts`, `loads-check.ts`, `folder-personal.ts`, `starting-set.ts`; Claude Code `harnesses/claude-code/loads/`, `local-settings.ts` (the one writer), `local-holds.ts`, `turn-status.ts`, `personal-instructions.ts`; OpenCode `harnesses/opencode/loads.ts`; web `lib/loads-view.ts`, `lib/loads-weight.ts`, `lib/starting-set.ts`, `components/knows/OriginHead.tsx`                                                                                                                                                                                                                                                                                           |
| instruction files (Memory's rows, the write boundary)                                                                                 | neutral `server/src/folder-instructions.ts`, `memory-service.ts`, `routes/files.ts`; Claude Code `harnesses/claude-code/instructions.ts`, `instructions-record.ts` (the one transcript reader, also Started with's); OpenCode `harnesses/opencode/instructions.ts`; tests `memory-service.test.ts`, `memory-api.test.ts`, `loaded-at-start.test.ts`, `started-with.test.ts`, `harness-conformance.test.ts`                                                                                                                                                                                                                                                                                                                                            |
| the packaged command (`silos doctor · service · update · uninstall`)                                                                  | `scripts/pack-npm.mjs` (the bin: no subcommand = start the server, after checking that `node-pty` loads — it ships as an optional dependency so a failed native build never aborts the install, and the bin names the toolchain fix), `server/src/cli/` — a second program entry beside `index.ts`; decisions are pure functions (`doctor.ts`, `service.ts`, `update.ts`), `main.ts` reads the machine. The service is a systemd USER unit / LaunchAgent that stops the server process only (consoles are tmux sessions and survive) and carries PATH + `SILOS_PORT/HOST/DATA_DIR/ROOT`, never the shell's engine variables                                                                                                                           |
| seals (integrity of `~/.silos` and engine config)                                                                                     | `server/src/seals.ts`, `seal-regimes.ts`, `seal-hooks.ts`, `routes/seals.ts`; what the engine changed in its own configuration (page lines: engine-keys-only settings diffs, plugin version moves) is kept in `seals.json` (the newest 50) and listed under Claude Code in Settings › Engines (`web/src/components/settings/Engines.tsx`) — never Needs you                                                                                                                                                                                                                                                                                                                                                                                           |
| the event loop (one loop relays every live console)                                                                                   | no synchronous child process in the server: tmux is called async and bounded (`terminal-service.ts tmuxExec`, 5 s, SIGKILL; acts that change one console run on its key's promise chain; `;`-chained tmux commands where one call does), guarded by `server/test/no-sync-spawn.test.ts` (allowlist: the CLI, two bounded git calls). Stalls are measured permanently by `server/src/loop-stalls.ts` (a 100 ms unref'd timer that measures its own lateness): counts and worst over 200 ms for the last minute / hour / since the listen, one log line per stall over 500 ms (at most one per 10 s, swallowed ones counted into the next) — `curl -s 127.0.0.1:3210/healthz` from the machine shows them (`loop`; a remote caller gets `{ ok: true }`) |
| engines                                                                                                                               | `server/src/harnesses/`, `docs/harnesses.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| transcript reads and the session listing (no event-loop freeze)                                                                       | `server/src/jsonl-lines.ts`, `harnesses/claude-code/reader.ts`, `harnesses/claude-code/started-with.ts` (`TranscriptStartedWith`), `server/src/session-index.ts`; tests `transcript-yield.test.ts`, `started-with-follow.test.ts`, benchmarks `perf-transcripts.bench.test.ts`, `heavy-lines.bench.test.ts` (`SILOS_BENCH=1`)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| processes conversations left (the System silo, kernel kind `process`)                                                                 | `server/src/silos/processes.ts` (records, attribution, redaction), `silos/proc-table.ts` (async bounded /proc reader), `harnesses/contract.ts` `traits.sessionEnvKeys`; manifest `docs/standard/reference/system.silo.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| worktrees conversations left (the System silo, kernel kind `worktree`, kernel-verb `remove-worktree`, Silos closing merged idle ones) | `server/src/silos/worktrees.ts` (git reads, states, removal, the auto-close), `harnesses/contract.ts` `HarnessReader.worktreeSessions` (Claude Code: `harnesses/claude-code/reader.ts`), `ProcessRecords.inside`; manifest `docs/standard/reference/system.silo.json` (second view)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| skills sync                                                                                                                           | `server/src/skill-install.ts`, `plugin/skills/releases.json`, `scripts/skill-releases.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
