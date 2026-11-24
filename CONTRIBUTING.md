# Contributing to Silos

Thanks for wanting to help. Silos is a local console for running a fleet of
coding agents as identities; it is used every day to run real work, so the
bar is "does this make an operator's day clearer", not "does it add a
feature".

## Before you start

- **Bugs:** open an issue with what you did, what you expected, what
  happened, and your OS, Node version and `claude --version`. Logs help;
  transcripts usually contain secrets — redact before pasting.
- **Features and UX changes:** open an issue first and say _which moment of
  the product it serves_ (see [docs/product.md](docs/product.md)) and where
  the user reaches it from. A change that cannot name its moment is unlikely
  to be merged, however good the code.
- **Security issues:** never in a public issue — see [SECURITY.md](SECURITY.md).

## Setting up

Prerequisites are in the [README](README.md#prerequisites) (Node 22.13+,
tmux, a C/C++ toolchain on Linux for `node-pty`, the `claude` CLI).

```bash
git clone https://github.com/cheapestinference/silos.git && cd silos
npm install
npm run dev        # server on 127.0.0.1:3210, reloads on save, restarts itself if it stops answering
npm run dev:web    # UI with hot reload, proxies /api and /ws to the server
```

To run the built product from source (what the npm package ships):

```bash
npm ci                     # installs from the lockfile; compiles node-pty
npm run build              # builds the web UI and the server
npm start                  # http://127.0.0.1:3210
```

`npm run pack:npm` assembles the npm package `silosplatform` (command
`silos`) into `.pack/`; it never publishes. Releases publish it from
`.github/workflows/release.yml`.

Use a throwaway data directory while you develop, so your real agents and
transcripts are never touched:

```bash
SILOS_DATA_DIR=$(mktemp -d) SILOS_ROOT=$(mktemp -d) npm run dev
```

If your change can start agent turns (automations, heartbeats, task wakes),
also give the server a temporary `HOME`: otherwise it runs real turns on
your own Claude account.

## How the code is laid out

- `server/` — Fastify server, engines (`server/src/harnesses/`), the
  resident scheduler, the silo kernel. Tests in `server/test/`.
- `web/` — React + Vite + Tailwind UI. Unit tests in `web/test/`,
  Playwright end-to-end tests in `web/e2e/`.
- `plugin/` and `plugin-opencode/` — what Silos puts inside every agent:
  hooks, skills, briefing fragments.
- `silos-id/` — the Silos ID login broker (one Google sign-in for any
  instance), a Cloudflare Worker deployed on its own.
- `docs/` — [product.md](docs/product.md) (what the user sees and why —
  binding for UX), [architecture.md](docs/architecture.md) (how each
  mechanism works — keep it current when you change one),
  [harnesses.md](docs/harnesses.md) (adding an engine),
  [standard/](docs/standard/) (the silo standard).

Older comments may still allude to the maintainers' design notes; those
are not part of the public repository — the rule the comment states is
what counts.

## Rules the codebase keeps

1. **The engine is not ours to bend.** Silos uses Claude Code (and OpenCode)
   only through documented mechanisms: flags, settings files, hooks,
   `CLAUDE.md`, the SDK. No patching, no scraping of private state.
2. **Read-only on what Silos did not create.** Sessions started outside
   Silos are read, never modified. Deleting moves to `~/.silos/trash/`.
3. **The filesystem is the truth.** No database: transcripts, JSON files and
   plan files under the user's folders and `~/.silos`.
4. **Safe defaults.** Bind to `127.0.0.1`, `0700` data directory, every write
   needs an identity. Transcripts contain secrets — treat them that way in
   code, logs and tests.
5. **Neutral code names no engine.** Engine-specific code lives in its
   harness folder; a boundary test enforces it.
6. **Fix the class, not the case.** When something breaks, find the rule
   that covers every variant and test the variants — two ad-hoc patches in
   the same place mean the rule is missing.

## Tests

- While iterating, run only the files you touch:
  `npx vitest run server/test/<file>.test.ts`.
- Before opening a PR: `npm run typecheck`, `npm test` once, and
  `npm run e2e:changed` (runs the Playwright specs of the zones your branch
  touches). On Linux, Playwright may need system libraries — see its docs.
- Run `npm run lint` and `npm run format` before pushing.
- **Write tests for what can break silently:** engine behaviour, data,
  security, actions. **Do not** write tests for layout, wording or CSS (no
  snapshot of markup, no `getByText('some sentence')` as the main assertion,
  no timing assertions) — attach a screenshot to the PR instead.
  `SILOS_SHOTS=1 npm run e2e` makes the specs that take evidence
  screenshots write them to `web/test-results/shots/<spec>/` (gitignored).
  The README's images (`docs/images/`) come from the same seeded demo data:
  `SILOS_README_SHOTS=1 npx playwright test readme-shots` (in `web/`, after
  `npm run build:e2e -w web`) writes them to `web/test-results/readme-shots/`.
- **Real-binary smokes** (`scripts/`) check what no unit test can: the
  real `claude` / `opencode` binary honouring what Silos hands it. They
  cost a few cents of real turns and never run in CI — run the one for the
  mechanism you changed:
  - `territory-smoke.sh` — a `--settings` deny rule refuses Read and a Bash
    `cat` under `--dangerously-skip-permissions`;
  - `territory-smoke-loads.sh` — the fence rules Silos generates for what
    an engine loads, on the real binary under a temporary HOME;
  - `smoke-held-connector.mts` — each key a folder's local settings switch
    off (servers, connectors, account plugins and skills, skill overrides)
    holds in an unattended turn as it does in an attended one; with
    `scopes` (`smoke-scopes.mts`) it measures each key from each settings
    tier (user, repository, local, `--settings`) at a session start, in a
    config dir of its own — `$SILOS_SMOKE_CONFIG_DIR`, default
    `~/.silos-smoke/claude`, never `~/.claude` nor an account Silos runs —
    signed in once with `CLAUDE_CONFIG_DIR=<that dir> claude auth login`
    (not signed in: every case is skipped, and said);
  - `smoke-memory.mts` — which instruction files a start loads (each
    `CLAUDE.md` kind, rules, imports, `AGENTS.md`, worktrees, additional
    directories, on-demand loads) and what `claudeMdExcludes` and
    `autoMemoryEnabled` keep out per settings tier, read from the
    transcript's `instructions` records and `getContextUsage()`; it runs
    on your default login in place but writes only in temp folders
    (never under `~/.claude`: auto memory is pointed at a temp folder),
    so the cases that need a personal file are skipped;
  - `smoke-silos-places.mts` — the acceptance smoke: Silos itself, on
    isolated servers (temp data, root, HOME), through its API — a clean
    install (Welcome's starting set written as designed, Tools, Memory,
    Skills and a real «Check now» on an empty machine), then each place
    (project, «Only <agent>», conversation, This machine, the account's
    connectors head, «Turn all off» + Undo) switched and read back with
    «Check now» (no prompt, no tokens); the places run in the bed above,
    the clean install in a second one with its own login
    (`$SILOS_SMOKE_CLEAN_DIR`, default `~/.silos-smoke/clean`, reset to its
    credential alone at each run) — never a credential linked between two;
  - `smoke-heartbeat-vetoes.mts` — a heartbeat's subagent and scheduling
    vetoes reach forked skills;
  - `opencode-heartbeat-smoke.sh` — OpenCode's heartbeat config really
    removes the `task` and web tools from `opencode run`.
    (`skill-releases.mjs` is not a smoke: it regenerates
    `plugin/skills/releases.json` from git history when a shipped skill
    changes.)
- Tests and fixtures use generic data only (`/home/user`, `example.com`,
  agent ids like `builder`, `finance`). Never a real path, name, email or
  transcript; `server/test/no-install-data.test.ts` checks real-looking
  home paths and emails, plus — when you keep one — your own
  installation's names from a gitignored `internal/install-data.json`
  (`{ "patterns": ["regex", …] }`).

## Pull requests

- One coherent change per PR, branched from `main`, rebased before merge.
- Say what moment it serves (UX), what rule it enforces (fixes), and how you
  verified it. UI changes need before/after screenshots, in light and dark.
- Keep commits readable: `type(scope): what and why` (`fix(auth): …`,
  `feat(automations): …`).
- Update `docs/architecture.md` when you change how a mechanism works, and
  `README.md` when you change how Silos is installed or configured.
- By contributing you agree your contribution is licensed under the
  [MIT License](LICENSE).

## Conduct

Everyone taking part in the project follows the
[Code of Conduct](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1). In short:
be kind, be concrete, assume good faith. Report conduct problems to the
maintainers privately, as the Code of Conduct explains, never in a public
issue.
