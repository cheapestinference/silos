# Changelog

All notable changes to Silos are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

The first public release.

### Added

- **Install with one command**: `npx silosplatform` installs the npm package
  `silosplatform` and starts Silos; the command `silos` starts it from then on
  (`silos doctor`, `silos service install`, `silos update`, `silos uninstall`).
  The terminal module installs as optional: without a C/C++ toolchain the
  install finishes and `silos` names the fix.
- **Home**: a one-sentence pulse of what is true right now and one inbox,
  _Needs you_, for agent questions, approvals, plan tasks assigned to you,
  failed runs and escalations; a daily digest at the hour you choose and
  optional push notifications.
- **Agents as identities**: each with a name, a role, its skills, a working
  folder, its permissions and its conversations.
- **Conversations in two modes**: the agent's real terminal console (the
  unmodified CLI in a tmux session, in the browser) or a chat view, with a
  switch between them.
- **Standing duties and automations**: missions with a heartbeat, and
  automations that run once, on a schedule, by webhook, on file changes or
  when a conversation finishes — as an agent turn or as a plain command that
  spends no tokens. Every run says what happened in plain words.
- **What each agent knows and can do**: memory, skills, files, deliverables
  and what loads at the start of every conversation, each with who sees it;
  skills, MCP servers and plugins can be turned off per folder.
- **What every conversation loads, by origin**: a project's Tools lists each
  plugin, MCP server and claude.ai connector its conversations load — from
  the project, your machine or your Claude account (per login) — with its
  health and how it was read (connected, needs your sign-in, didn't start
  with its reason and count, still connecting), its weight at the last
  start (or, for a plugin not loaded, Claude Code's estimate), «Check now»,
  «Sign in ›» / «Connect in claude.ai ›», and a switch per item and per
  account origin that writes only documented keys of the folder's
  `.claude/settings.local.json`; a switch that didn't take says so. Skills
  gain on · name only · off for personal and account skills, Memory can keep
  your personal instructions out of one project, a conversation folds its
  tool problems into one alert, and new projects start with what your
  Claude account sends off for plugins and connectors (Recommended,
  changeable in Welcome and Settings › Accounts & providers).
- **Where it loads — one switch, five places**: every plugin, MCP server,
  connector, skill and your personal instructions can be switched for this
  machine, this project, one agent or one conversation,
  with your Claude account's own page one click away. Each row's ▾ shows
  its places with whom each reaches and the narrower one winning, in
  Claude Code's own order; one phrase says when they disagree («off on this
  machine», «only Builder loads it»). A plain click acts where you are: the
  project's page for the project, an agent's page for that agent; one
  conversation is a line on its agent's page opened from it, saying when
  it takes effect. «Turn all off / on» with Undo,
  a switch that didn't take named per place, runs that load exactly what
  the screen says, and OpenCode's places too. Silos writes your
  `~/.claude/settings.json` only when you click its «This machine» line,
  only that entry, and the same switch undoes it.
- **Memory, every instruction file at every place**: Project › Memory and
  Agent › Memory list every instruction file Claude Code loads — your
  machine's `CLAUDE.md` and rules, a folder above, the project's files and
  rules, `AGENTS.md`, subfolder files, imports, `CLAUDE.local.md`, auto
  memory, the agent's own memory — grouped by origin, each row saying whom
  it reaches, when it loads and what it weighed. A row opens in place and
  Save names its reach (your machine's files ask first, from any page that
  shows them); «+ Write instructions» creates a file at a fixed place and
  says the one `.git/info/exclude` line it adds. Each file switches per
  project, agent and conversation, auto memory too (with a machine line),
  and a conversation's own record proves the switch. One label per place
  everywhere («This machine», «Your Claude account · login», «Project ·
  name», «Agent · name», «Conversation · title»), one «From» filter plus an
  «Only» row, group heads that say origin only, bulk buttons that name
  their place; the conversation's column is one summary line and a door
  per kind, and its tools alert counts only live failures — a thing you
  turned off is never a problem.
- **Plans you can read at a glance**: the sidebar lists each project's
  plans first, each with its full name, a progress bar (done over all its
  tasks) and how many are yours to do, then the tasks in no plan under
  «No plan». A plan's own view opens with its name, progress and the one
  thing it waits on you for; finished plans are listed in Tasks › Done
  («Finished plans ›» at the sidebar's foot). A conversation's column
  labels what each block is — «Plan · name», «Checklist · this
  conversation», «Plan mode · Claude's plan» — and the Tasks head counts
  tasks in plans and in no plan apart.
- **Territory**: an optional per-agent fence and a per-agent API token.
- **Vault**: secrets delivered to agents through their environment, scoped
  to the agents you choose.
- **Silos**: Silos is built of installable ways of working (modes, views,
  functions or your own records). Recommended silos come installed — Plans,
  Task mode, System — and each can be removed, saying first what goes with
  it; optional ones — Support, Hierarchy, Executions (for users of the
  superpowers plugin), Heather — install in one click; your own install from
  a manifest, with `npm run silo-check` to validate one. Where a recommended
  silo is missing, a quiet door says so and installs it.
- **Engines**: Claude Code (default, console and Agent SDK chat, with extra
  accounts per conversation) and OpenCode (optional).
- **Deployment**: run from source on your own machine, with Docker, or on
  Railway; remote sign-in through Silos ID, its settings in the environment
  or in `server.env` in the data folder.

[0.1.0]: https://github.com/cheapestinference/silos/commits/main
