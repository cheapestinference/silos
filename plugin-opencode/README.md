# Silos plugin for OpenCode

`silos.ts` runs inside every OpenCode process Silos launches (console TUI
and headless `opencode run`). It is the OpenCode twin of the Claude Code
plugin's birth marker (`plugin/hooks/birth.py`), plus a permission bridge to
Silos' _Needs you_ that has no Claude Code hook counterpart in `plugin/`:
file-borne, zero tokens, no network. Plain TypeScript loaded by OpenCode's
Bun runtime; it uses only `node:fs`, `node:path` and `node:crypto`.

**Minimum: OpenCode 1.19.4** (`server/src/harnesses/opencode/version.ts`
`OPENCODE_MINIMUM`). Silos refuses consoles and turns on an older OpenCode
with one line naming the installed version and `opencode upgrade` — it never
runs one with fallbacks. See _Verified against the minimum_.

**Plugin API it is written against:** `@opencode-ai/plugin` **1.19.4** — the
same release as the minimum (pinned in `package.json`; a server test holds
the pin equal to `OPENCODE_MINIMUM`, so they move together). The shape: a
module whose default export is `PluginModule` `{ id, server }`, `server`
returning `Hooks` with `event` and `shell.env` (listed
below). What the minimum check guarantees: the installed `opencode
--version` is 1.19.4 **or newer** — nothing else. There is no upper bound:
a newer OpenCode that renames an event or changes a hook's input is not
refused, and the plugin then degrades silently (no hook ever throws), so a
version bump is re-verified by hand (_Verified against the minimum_) and
the pin moved with it.

## Env it reads

| Variable               | Use                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SILOS_AGENT_STATE`    | the agent's state dir; every file below lives under it                                                                                                                             |
| `SILOS_AGENT_ID`       | the agent the session belongs to                                                                                                                                                   |
| `SILOS_SESSION_ID`     | the session that launched this process (birth `parent`) — a headless resume only; a console never carries it, so a `/new` in a resumed console is no child of the old conversation |
| `SILOS_CONSOLE_KEY`    | the console key Silos minted for a new console (birth `consoleKey`)                                                                                                                |
| `SILOS_ASK_TIMEOUT_MS` | how long a permission ask waits for Silos (default `600000`)                                                                                                                       |
| `SILOS_PLUGIN_DEBUG`   | any value: print permission-reply failures to stderr                                                                                                                               |

Without `SILOS_AGENT_STATE` **or** `SILOS_AGENT_ID` (an operator running
`opencode` by hand with the plugin configured) every hook is a no-op. No
hook ever throws: a marker that cannot be written never breaks a session.

## What it writes

Session and permission ids are used as path segments only when they match
`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`. Directories are created `0700`, files
`0600`, written atomically: an exclusive temp file in the same directory is
**renamed** into place (never hard-linked: a file with two names reads to
Silos like a link into another agent's state), and an existing file is
never overwritten.

- **Births** — `births/<sessionID>.json`, first wins:
  `{ sessionId, agentId, parent, cwd, source: 'startup', harness: 'opencode', consoleKey, at }`.
  `source` is always `'startup'` (the only value `server/src/session-owner.ts`
  trusts). `parent` is OpenCode's own `info.parentID` when the session is a
  subagent session, else `SILOS_SESSION_ID`, never the session itself.
  `cwd` is `info.directory` (fallback: the plugin's `directory`).
  `consoleKey` is `SILOS_CONSOLE_KEY` (null when empty or unset), and always
  null for a subagent session (it runs in its parent's console).
  Written on `session.created`, and on the first `session.updated` of a
  session whose `info.time.created` is after this process started — see
  _Verified against the minimum_ for why. A resumed session (created earlier)
  is never claimed.
- **Permission asks** — `asks/<sessionID>/<permissionID>.json`:
  `{ id, sessionId, type, pattern, title, metadata, askedAt }`; Silos answers
  with `$SILOS_ASKS_REPLIES/<sessionID>/<permissionID>.reply.json`
  `{ "status": "allow" | "deny" }` — a Silos-owned dir
  (`<dataDir>/asks-replies/<agentId>`, fenced for every agent), never the
  agent's own state dir: the agent can write there, and a reply it planted
  would approve its own ask. A reply file beside the ask is never read;
  without `SILOS_ASKS_REPLIES` no reply is read at all.
  On the `permission.asked`
  event the plugin writes the ask file and starts a non-blocking poller
  (setTimeout chain, unref'd, 500 ms, up to `SILOS_ASK_TIMEOUT_MS`). On a
  reply it answers OpenCode through the SDK client the plugin receives
  (`allow` → `once`, `deny` → `reject`) and deletes both files — also when
  OpenCode answers 404 (already answered). When the client fails it deletes
  only the reply file: the ask stays in Silos' Needs you and the poller
  keeps waiting for a new reply. On timeout it deletes
  the ask file (and a reply that landed at the deadline) and does nothing else (the TUI's own dialog stays open). A
  `permission.replied` event (answered in the TUI) stops that poller and
  deletes the files. Concurrent asks are independent (one poller per id).
  Client errors (thrown, or a resolved `{ error }`) are swallowed; with `SILOS_PLUGIN_DEBUG` set they are
  printed once as `silos: permission reply failed (<id>): …`.
  The plugin type also declares a blocking `permission.ask` hook; OpenCode
  never calls it (the string occurs nowhere in the 1.19.4 or 1.19.6
  binary), so the plugin does not implement it.
- **Shell env** — `shell.env` sets the env of the agent's `bash` tool and
  PTY shells by one rule: a shell keeps the **agent-facing** `SILOS_*`
  variables (`AGENT_SHELL_SILOS_ENV`: `SILOS_API`, `SILOS_AGENT_ID`,
  `SILOS_AGENT_STATE`, `SILOS_AGENT_TOKEN`, `SILOS_TURN`,
  `SILOS_SESSION_ID` — what the recipes, skills and hooks read), and every
  other `SILOS_*` variable the process carries — `SILOS_PROVIDER_KEY` (the
  provider's API key), `SILOS_CONSOLE_KEY`, `SILOS_ASKS_REPLIES`, any name
  added later — plus the engine credentials in `ENGINE_CREDENTIAL_ENV`
  (`OPENCODE_SERVER_PASSWORD`, with which a shell could answer its own
  permission asks through the TUI server) is set to **empty**. Blanked, not
  omitted: OpenCode spreads its own process env under the hook's output, so
  an omitted name would come through with the process's value. The Vault's
  entries are not `SILOS_*` (the Vault refuses that prefix) and pass as the
  owner meant; OpenCode's own non-secret wiring (`OPENCODE_DB`,
  `OPENCODE_CONFIG_CONTENT`…) passes too. `SILOS_SESSION_ID` is the calling
  session (`input.sessionID`, else the process env). A nested `opencode run`
  started from the console's shell thus writes a marker whose `parent` is
  the TUI's session and whose `consoleKey` is null: Silos folds it as a
  nested run, never as a new conversation that would take the console's
  binding — and it has no provider key: it runs on what OpenCode itself is
  signed in to, or fails. This keeps secrets out of `env` dumps, logs and
  transcripts; it is not isolation — a shell of the same Unix user can still
  read the OpenCode process's own `/proc/<pid>/environ`.

**No `/clear` reminder (on purpose, 09-11).** `/new` inside an OpenCode
console is a NEW conversation (the registrar seals it and moves the
console's binding; the previous one stays a finished conversation), and
its shells get the new `ses_…` as `SILOS_SESSION_ID` — so it cannot claim
or release for the previous one, and the Claude Code SessionStart reminder
(«this console was working on …», `session-start.sh`) has no twin here.
The plugin API could inject text (`experimental.chat.system.transform`),
but knowing the console's tasks needs the API, and this plugin has no
network of its own. team-plan (and the briefing's Tasks rule) say it
instead: outside a Claude Code console, release before you switch.

## OpenCode API names used (plugin types 1.19.4; routes present in the 1.19.4 binary)

- Module shape: `export default { id: 'silos', server: SilosPlugin }`
  (`PluginModule`). OpenCode loads a module by that default export or,
  failing it, calls **every exported function** as a plugin — which ran the
  exported helpers as plugins and failed (`undefined is not an object
(evaluating 'info.id')`). A path plugin must also name its `id`
  (`Path plugin … must export id`).
- `event: ({ event }) => Promise<void>`, matched on the `event.type` string:
  - `session.created` / `session.updated` → `properties.info` (`Session`:
    `id`, `directory`, `parentID?`, `time.created` in ms).
  - `permission.asked` → `properties` is the v2 `PermissionRequest`:
    `id`, `sessionID`, `permission` (e.g. `"bash"`), `patterns[]`,
    `metadata`, `always[]`, `tool?` (`messageID`, `callID`). The ask file maps
    `permission` → `type`, `patterns` → `pattern`, `title: null`.
  - `permission.replied` → `properties.sessionID` plus `permissionID` (v1
    type) or `requestID` (v2 type / what the binary emits); both accepted.
- The SDK client in `PluginInput.client`: on the 1.19.4 minimum it is the
  **v2** `OpencodeClient` — the only generated client embedded in the
  binary (09-11 smoke: `strings` finds no `postSessionIdPermissionsPermissionId`
  at all; the v2 `permission` class has `reply` and `respond`). The plugin
  answers with `client.permission.reply({ requestID, reply })`
  (`POST /permission/{requestID}/reply`) and questions with
  `client.question.reply` / `client.question.reject`. Verified end to end the
  same day: a console ask (`external_directory`) answered Allow through
  `POST /api/asks/…/reply` and OpenCode wrote the file. (1.14.22 handed
  plugins the v1 client; that fallback went with the version gate.)
- `'shell.env': (input: { cwd, sessionID?, callID? }, output: { env: Record<string, string> })`.

## How Silos injects it

Per process, through `OPENCODE_CONFIG_CONTENT` (a JSON string OpenCode
merges over the operator's config); `plugin` is a `string[]`:

```sh
OPENCODE_CONFIG_CONTENT='{"plugin":["file:///abs/path/plugin-opencode/silos.ts"]}'
```

Both forms load (verified 26-10, before the 1.19.4 minimum):
`file:///abs/…/silos.ts` and the bare absolute path `/abs/…/silos.ts`. The
`~/.config/opencode/plugins/` symlink fallback was **not** needed.

The same `OPENCODE_CONFIG_CONTENT` carries the rest of what Silos sets per
process (`server/src/harnesses/opencode/launch.ts` + `assemble.ts`): the
agent's context file and role prompt as `instructions` (files in its state dir), the
provider (`{env:SILOS_PROVIDER_KEY}` — the key rides the env file, never the
config text or argv) and, for a fenced agent, the territory as `permission`.
The env comes from the console's env file (never argv): `OPENCODE_DB`
(one database per agent, `<dataDir>/agents/<id>/opencode.db`),
`SILOS_API`, `SILOS_CONSOLE_KEY`, `SILOS_ASKS_REPLIES` (the reply dir), the
agent's `SILOS_*` state and Vault.

In the container image (`Dockerfile`) this directory ships at
`/app/plugin-opencode/` next to `plugin/`; the `opencode` binary does not —
install it in the image if the instance runs OpenCode agents.

## Territory (fenced agents)

The fence (`server/src/territory.ts` `fenceFor`, Settings › Territory) is
translated to OpenCode's `permission` config by
`server/src/harnesses/opencode/fence.ts`. Today's fence emits Read/Edit rules only, so on
OpenCode it denies `read` and `edit` (a `bash` rule would map to `bash`; a
path a bash subprocess opens is not fenced on either harness).
`edit` asks with the worktree-relative path (each edit rule is
written relative and absolute), `*` crosses `/` (the agent's own state dir
is allowed by keys written last — the last matching key wins), Glob/Grep/LS
have no path permission (reported unmapped). A fenced agent runs with
`OPENCODE_DISABLE_PROJECT_CONFIG=1` and edit-denied OpenCode config files, so
it cannot reorder those rules from a project `opencode.json`; since that
flag also skips the project's `AGENTS.md`/`CLAUDE.md`, Silos lists them
itself as absolute `instructions`. A refused call comes back as an errored
tool part (`…a rule which prevents you from using this specific tool call.
Here are some of the relevant rules [{"permission":…,"action":"deny"}]`);
Silos counts those into the conversation's refusal line
(`server/src/harnesses/opencode/map.ts`). The plugin plays no part in the
fence.

## Console auth

Silos talks to an OpenCode console's TUI through its loopback HTTP server
(`POST /tui/append-prompt` + `/tui/submit-prompt`), always protected with a
per-console basic-auth password (`OPENCODE_SERVER_PASSWORD`, user `silos`,
kept in the Silos-owned console record). The minimum's TUI authenticates
against its own password-protected server — there is no unauthenticated
mode; a TUI that cannot bootstrap with the password dies visibly at launch.

## Headless chat engine (`opencode run`)

Typed turns and automation runs on an OpenCode agent go through
`server/src/harnesses/opencode/headless.ts`: one
`opencode run --format json --dir <cwd> [--session <id> [--fork]] [--model <provider/model>] [--auto | --agent plan] --thinking`
per turn, the prompt on stdin, the same config/env as the agent's console
(`assemble.ts`), `SILOS_SESSION_ID` only on a resume. This plugin writes the
birth marker inside the run (via `session.updated`, see below); Silos also
registers a session born there as native to the agent — only once the
agent's own `opencode.db` holds that id and no other DB does (the id printed
on stdout is not trusted on its own).

Permissions: since `opencode run` auto-rejects every ask without `--auto`
(see below), an agent whose effective permission mode is
`bypassPermissions` runs with `--auto` — the fence's deny rules still bind,
the same shape as Claude's bypass + deny. The minimum's TUI and `run` both
list `--auto`, so it is always passed for bypass
(`server/src/harnesses/opencode/auto-mode.ts`); an older binary never gets
that far (the version gate refuses it). Any other
mode runs without it: its asks are auto-rejected by OpenCode, nothing reaches
Needs you, and the server logs one line per run
(`opencode run: permission mode <mode> — asks are auto-rejected by opencode in headless mode`).

## Verified against the minimum

Re-checked on **1.19.4** (09-11, read from the binary, no session run):
`permission.ask` occurs nowhere in it (21 `permission.asked`); it serves both
`POST /permission/{requestID}/reply` and the deprecated
`POST /session/{sessionID}/permissions/{permissionID}`; `--auto` is listed on
the TUI and `run` (27-10). The end-to-end smoke below ran on 1.14.22 (26-10);
the plugin contract it exercised (events, hooks, routes) is the one 1.19.4
still ships.

Smoke (1.14.22, 26-10): `OPENCODE_DB=<scratch>/smoke.db`, `--dir <scratch>/proj` (a git
repo), model `opencode/big-pickle`, `SILOS_AGENT_ID=smoke`.

- `opencode run --format json` (file:// form) → `births/ses_….json` 0600 in
  a 0700 dir with `agentId: "smoke"`, `parent: "ses_parentsmoke"`,
  `consoleKey: "ck1"`, `source: "startup"`, `harness: "opencode"`.
  In `run`, the session is created in the same request that loads the
  plugin and its `session.created` **never reaches the plugin** (3/3 runs,
  the plugin's first event is `message.updated`); the `session.updated`
  fallback is what records it. `opencode run --session <id>` (resume) writes
  no marker.
- TUI `opencode --port <p>` in tmux, prompt via `POST /tui/append-prompt` +
  `/tui/submit-prompt` (file:// form) → marker via `session.created`, with
  `consoleKey`.
- `opencode serve` + `POST /session` (bare absolute path form) → marker via
  `session.created`.
- **Event bridge, end to end**: `opencode serve` with a stand-in
  OpenAI-compatible model (a local script that answers the first turn with a
  `bash` tool call), `"permission":{"bash":"ask"}`, `POST /session/:id/prompt_async`
  → ask file `asks/ses_…/per_….json` 0600
  `{"type":"bash","pattern":["echo silos-bridge-ok > bridge.txt"],"title":null,"metadata":{},…}`;
  writing `{"status":"allow"}` → `permission.replied` published within 1 s,
  the command ran (`bridge.txt` = `silos-bridge-ok`), both files gone. With
  `{"status":"deny"}` → `permission.replied`, the command did not run, both
  files gone. No `silos:` error with `SILOS_PLUGIN_DEBUG=1`.
- **`permission.ask` is never called** (1.14.22, and still absent from 1.19.4): the binary
  triggers 19 plugin hooks (`chat.*`, `tool.*`, `shell.env`, `command.*`,
  `experimental.*`…) and `permission.ask` is not among them (the string does
  not occur in the binary at all). Permissions flow only as the
  `permission.asked` / `permission.replied` bus events and the
  `POST /permission/:requestID/reply` route. The plugin therefore does not
  implement the hook (re-checked on 1.19.6: still absent).
- **Headless `opencode run` without `--dangerously-skip-permissions`
  auto-rejects every permission request itself** ("permission requested:
  …; auto-rejecting", from the binary's run loop, which replies `reject`
  as soon as `permission.asked` arrives; with the flag it replies `once`).
  So in headless runs the bridge cannot reach Needs you: the run's own
  reply comes first (the plugin then sees `permission.replied` and cleans
  up). The headless engine must choose: the flag (bypass + fence denies), or
  run headless turns through `serve` instead of `run`.
- `opencode/big-pickle` answered `429 Free usage exceeded` during the smoke,
  so no turn completed; births are written before the first model call and
  were unaffected. `shell.env` could not be exercised end-to-end for that
  reason (unit-tested only).

## Tests

```sh
cd plugin-opencode && npx vitest run   # also part of the root `npm test`
```
