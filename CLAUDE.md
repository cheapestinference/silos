@AGENTS.md

## Claude Code specifics

- The repo carries the `team-plan` skill in `.claude/skills/`; multi-task
  work in this repo can keep its shared tasks in `plans/*.plan.json`
  (gitignored — live state, not code).
- Never launch `claude` from a shell inside a session started by Silos: at
  best it folds under your conversation as a nested run; without the Silos
  hooks it shows up as a top-level conversation of the person running
  Silos. Use subagents instead.
- A save under `server/src` restarts a running `npm run dev` server, which
  drops the consoles open in its browser tabs.
