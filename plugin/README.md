# Silos plugin

What makes an agent work well inside [Silos](../README.md): the briefing a
session starts with, two Claude Code hooks, and five skills. Installing any
of it is always the user's choice; Silos never touches `~/.claude` on its
own.

**Linux and macOS only.** The hooks are POSIX `sh` plus `python3` (standard
library only); on Windows use WSL. On a macOS without the Command Line
Tools, `/usr/bin/python3` is a stub that opens an install dialog — install
them (or any Python 3) first.

## Who reads what

This folder is laid out as a Claude Code plugin, but most of it is not
Claude-Code-only, and Silos itself never loads it as a plugin.

| Path | What it is | Read by |
| --- | --- | --- |
| `context/briefing.d/` | the rules every agent session starts with, as fragments (`base.md`, and a `.with` / `.without` pair per skill) | the Silos server (system prompt of every Claude Code launch, OpenCode's context file) and `hooks/compose.py` — both compose the same text |
| `context/hand-started.md` | the slim briefing for a session with no Silos identity | `hooks/compose.py --slim` only |
| `context/reference/` | what a briefing rule needs only now and then (automation triggers, the task file's format); the rule names the file | the agent, with its file tools, when the rule sends it there |
| `context/recipes/` | the claim and release `curl`s — the one source of each | the server (its prompts), `hooks/session-start.sh`, and the texts that quote them |
| `skills/` | the five skills (`SKILL.md`, plus `reference/` files for `team-plan`) | Claude Code, from the copy in a folder's `.claude/skills/`; OpenCode, straight from here (Silos passes it as a `skills.paths` root at every launch) |
| `skills/releases.json` | the tree hash of every skill version shipped | the server, to tell an untouched copy (which it updates) from an edited one (which it leaves alone) |
| `hooks/` | the SessionStart briefing and the CronCreate gate | Claude Code only, once installed (below). OpenCode's counterpart is [`../plugin-opencode/`](../plugin-opencode/) |
| `.claude-plugin/plugin.json`, `hooks/hooks.json` | the plugin manifest | Claude Code, only when you load this folder yourself with `--plugin-dir` |

`plugin.json` carries no `version` on purpose: nothing consumes one. Silos
installs the hooks by path and the skills by copy, and what tells one skill
version from another is its content hash in `releases.json`; loaded as a
plugin from a git source, Claude Code versions it by commit. Installing
from a marketplace is not a supported route — there is no
`marketplace.json`.

## How it reaches a session

- **Hooks** — Settings › Engines › Claude Code › *Silos hooks* › **Install hooks**
  writes the SessionStart and CronCreate entries into the machine's
  `~/.claude/settings.json`, each pointing at the script here by its
  absolute path (quoted). Every `claude` on the machine then runs them —
  Silos' consoles and chats, and one you start by hand. Until that click,
  no Claude session gets the hook's briefing, the birth marker, the inbox or
  the cron gate. The row says *installed* only when the scripts it points at
  exist; after the Silos folder moves it says *broken* and **Repair**
  rewrites the paths. **Uninstall**, on the same row, removes those two
  entries and nothing else (by hand: delete the `SessionStart` command
  ending in `session-start.sh` and the `PreToolUse` › `CronCreate` command
  ending in `pre-cron.sh` from `~/.claude/settings.json`). Do it before
  deleting the Silos folder, or every session logs a hook error.
- **Skills** — copied into a project's `.claude/skills/` when the owner
  adds them to that folder from Silos (or by hand, below). Silos keeps a
  copy current while nobody has edited it (`releases.json`). A skill entry
  that is a symlink is read but never rewritten.
- The only `--plugin-dir` Silos passes is each agent's own role plugin
  (`~/.silos/agent-state/<id>/plugin`), never this directory.
- **OpenCode** agents get `skills/` and `../plugin-opencode/` from Silos at
  every launch; nothing here needs installing for them.

The hooks need `sh` and `python3`; the skills' recipes use `curl`, and the
vault-secrets recipe `jq`. A hook without `python3` never blocks the
session: it says so in one line on stderr and exits 0.

## The skills

- **team-plan** — the one source of how an agent handles Silos tasks: work
  with an owner beyond the conversation (another agent, a person, later) is
  one task in the project's list `plans/tasks.plan.json`; a named
  `plans/<slug>.plan.json` only when several tasks coordinate. The agent
  claims a task before working it and releases it when the conversation
  moves on, asks and waits through `dependsOn` / `waitingOn`, and closes a
  human's task only on their word or on proof the system holds. `SKILL.md`
  is the core — both recipes and the conduct, small enough to survive a
  compaction (Claude Code re-attaches only a skill's first 5,000 tokens) —
  and `reference/` holds the file format, asking, every answer of a claim
  or release, reconciling, and executing an engineering document.
- **heartbeat** — the agent's heartbeat turn: it decides, it does not work.
  It answers or closes its messages, starts a pending task someone left it,
  records each idea it weighs and sleeps when nothing of its mission needs
  it. Whether and how often it thinks is the owner's setting — never the
  agent's.
- **vault-secrets** — when a task needs a credential (or the user starts
  to paste one), the agent refuses the paste and asks for it in the Vault
  with an exact name + scope; it then verifies the env var is present
  without ever printing it. Secrets never enter the transcript.
- **support-inbox** — when in charge of a support mailbox, keeps one case
  file per customer under `$SILOS_AGENT_STATE/support/`, reads the mailbox
  by delta only, drafts but never sends. Silos shows the cases and the
  owner edits them there. Product policy stays in your own skill.
- **silo-author** — when the owner wants something kept as records
  («keep track of our supplier contracts and tell me before one renews»),
  the agent settles the record, its folder, its producer, states and what
  reaches Home with the owner, writes a `silo.json` from a worked example,
  checks it with `POST /api/silos/validate`, writes the first records and
  submits it — pending until the owner approves what Silos derived.

## The hooks

- **SessionStart** (`session-start.sh`) — `birth.py` writes a zero-token
  birth marker for an agent's session (so Silos knows who gave birth to
  what, and a nested `claude -p` folds under its parent). Then it injects,
  as additional context, what the session's context does not carry yet:
  - **the briefing**, composed from `context/briefing.d/` for the skills
    the session has. A `claude` Silos launches already has it in its system
    prompt (`SILOS_BRIEFING=system-prompt`) and is not sent it again. A
    session **with no Silos identity** (`$SILOS_AGENT_TOKEN` empty: one you
    started by hand) cannot act on the API recipes, so it gets the slim
    briefing instead (`context/hand-started.md`, about 1,600 characters);
  - the live **fleet roster** and, for an agent, its **unread messages**
    and the asks waiting on it;
  - after `/clear` in a Silos console, the tasks the console still works,
    with the release recipe filled.

  Always under Claude Code's 10,000-character cap for a hook's context
  (`compose.py --hook`: a rule's detail that does not fit is named by the
  file that holds it). It asks the Silos server in Python
  (`silos_http.py`): the bearer is never in a command line, a loopback
  server is asked without the environment's proxy, a redirect is a failure.
  It never blocks a session: any failure degrades to less context, or to
  nothing, exit 0 always.
- **PreToolUse on CronCreate** (`pre-cron.sh`) — scheduled work belongs in
  Silos automations (owner-visible state). What it denies depends on whose
  session it is:
  - **A Silos agent's session** (`$SILOS_AGENT_ID` or the agent's bearer
    `$SILOS_AGENT_TOKEN` in its environment — Silos sets both on every
    launch): a native cron is denied with the recipe to propose the visible
    equivalent unless it says `recurring: false` (the field defaults to
    true) and is not `durable: true`. A one-shot, non-durable self-ping
    passes untouched.
  - **A session you start by hand**: only a `durable: true` cron is denied
    (it outlives the session — that is what an automation is for), with the
    link to Silos' automation page, and only on a machine where a Silos
    answers (`$SILOS_API`, default `http://127.0.0.1:3210`, `GET /healthz`,
    1 s). Everything session-scoped passes, recurring or not: a
    fixed-interval `/loop` keeps working.

  Input it cannot read allows. Without `python3` it allows and says so in
  one line on stderr.

  *What it does not gate*: `ScheduleWakeup` — the next iteration of a
  self-paced `/loop`, one-shot and session-scoped like the self-ping that
  passes — on purpose. `RemoteTrigger` — cloud scheduled tasks on claude.ai,
  durable and invisible to Silos like a durable cron — is **not gated**: its
  input shape (which action creates a schedule) could not be verified
  against a binary, and a gate on a guessed shape would either block
  harmless `list`/`run` calls or let creation through. Desktop scheduled
  tasks (the Desktop app's) are not covered either.

## Try it locally

```sh
claude --plugin-dir /path/to/silos/plugin
```

On a machine where the hooks are already installed (above), this runs both
copies — Claude Code keeps a plugin's hook separate from the same command
in `settings.json` — so the session gets the briefing twice. Uninstall the
hooks first, or try it under another `CLAUDE_CONFIG_DIR`.

## Install the skills anywhere

The skills are plain, self-contained directories — they work in ANY folder
Claude Code runs in, agent-operated by Silos or not. Copy them into that
folder's own skills (per-project) or your user skills (everywhere):

```sh
# per-project: only this folder's sessions get them
cp -r plugin/skills/* <folder>/.claude/skills/

# everywhere: every session on this machine
cp -r plugin/skills/* ~/.claude/skills/
```

Copying just one is fine too — `cp -r plugin/skills/team-plan ~/.claude/skills/`
(the whole directory: `team-plan` reads its `reference/` files).
