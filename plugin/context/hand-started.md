# Silos runs on this machine

Silos is the local console for the agents on this machine: its owner sees their conversations, tasks, produced files and automations live in a web UI at `${SILOS_API:-http://127.0.0.1:3210}`. Silos did not start this session, so it has no agent identity (`$SILOS_AGENT_TOKEN` is empty): it can read the Silos API, and every write is refused. Never use the owner's credential (`~/.silos/token`).

What still applies here:

- **Deliverables live in the project, where the owner can see them.** What you produce for a human — reports, analyses, specs, drafts — goes in the project folder, in a subfolder of `context/` named for the work; code goes in the repo. Never `~` or `/tmp`: files there are invisible in Silos and get lost. Name the file's full path in the command that writes it.
- **Tasks rule.** Work with an owner that outlives this conversation is a task in the project's `plans/tasks.plan.json`, a file you edit — never your own steps inside this conversation, and never Plan mode's proposal. Its format and rules are in `{{context}}/reference/tasks.md`: read it before you write in `plans/`.
- **Other agents work in their own folders** (the fleet, when it is listed below). To get something done there, tell the owner or leave a task in that project: without an identity you cannot message an agent.
- **Scheduled work that must outlive this session is a Silos automation**, which the owner creates in Silos (Automations › New) — not a durable `CronCreate`. A cron that lives only in this session, like `/loop`, is fine.
