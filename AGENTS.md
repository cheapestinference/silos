# Silos — instructions for coding agents

Silos is a local web console that runs coding agents (Claude Code, OpenCode)
as identities: name, role, skills, working folder, permissions, and their
conversations. Node 22 + TypeScript, Fastify server, React + Vite + Tailwind
UI, no database — the filesystem is the source of truth.

Read before changing anything:

- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, rules, tests, pull requests.
- [docs/product.md](docs/product.md) — what the user sees and why. Every UX
  change must name the moment it serves and where the user reaches it from.
- [docs/architecture.md](docs/architecture.md) — how each mechanism works.
  Update it when you change one.

## Layout

- `server/` — Fastify server: routes (`server/src/routes/`), engines
  (`server/src/harnesses/`, one folder per engine), the resident scheduler
  (`server/src/resident/`), the silo kernel (`server/src/silos/`). Tests in
  `server/test/`.
- `web/` — the UI. Unit tests in `web/test/`, Playwright in `web/e2e/`.
- `plugin/` — hooks, skills and briefing that Silos puts inside every Claude
  Code agent; `plugin-opencode/` — the same for OpenCode.
- `silos-id/` — the Silos ID login broker, a Cloudflare Worker (own
  `wrangler.toml`; tests in `silos-id/test/`).
- `docs/standard/` — the Silo Standard (installable packages) and its
  reference manifests.

## Commands

```bash
npm install
npm run dev                 # server on 127.0.0.1:3210, reload on save
npm run dev:web             # UI with hot reload
npm run typecheck
npm run lint                # CI fails on any error: run it before every merge
npx vitest run server/test/<file>.test.ts   # while iterating: only what you touch
npm test                    # full suite, once before a PR
npm run e2e:changed         # Playwright specs of the zones you touched
```

Develop against throwaway data: `SILOS_DATA_DIR=$(mktemp -d)
SILOS_ROOT=$(mktemp -d)`, and a temporary `HOME` when your change can start
agent turns — otherwise the server runs real turns on your own account.

## Rules

1. **The engine is not ours to bend.** Use Claude Code and OpenCode only
   through documented mechanisms (flags, settings files, hooks, `CLAUDE.md`,
   the SDK). Neutral code never names an engine; engine code lives in its
   harness folder.
2. **Read-only on what Silos did not create.** Never modify sessions started
   outside Silos. Deleting moves to `~/.silos/trash/`, never `rm`.
3. **Safe by default.** Bind `127.0.0.1`, data directory `0700`, every write
   carries an identity. Transcripts contain secrets: never log, echo or
   commit them.
4. **Fix the class, not the case.** Find the rule that covers every variant
   and test the variants.
5. **Tests protect behaviour, not looks.** Test engine, data, security and
   actions. No tests of layout, copy or CSS (no snapshot of markup, no
   `getByText('sentence')` as the main assertion, no timing assertions).
6. **Generic data only** in code, tests and fixtures: `/home/user`,
   `example.com`, agents like `builder` or `finance`.
   `server/test/no-install-data.test.ts` enforces it.
7. **Some text is pinned.** Tests read parts of `docs/product.md`, the
   plugin's skills, briefing fragments and recipes verbatim. If a test in
   `server/test/protocol-sources.test.ts` or
   `server/test/recipes-identical.test.ts` fails after a wording change,
   change both sides on purpose.
8. **Everything in English** — code, comments, docs, commit messages.
