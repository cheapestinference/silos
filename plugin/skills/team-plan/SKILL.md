---
name: team-plan
description: Use when work has an owner beyond this conversation — a task for another agent or a person (the owner, a teammate), work that must outlive this session, "what's on me / who does what", "what's pending", work a message asked for, or several tasks to coordinate with dependencies or human steps. Not for your own steps inside this conversation.
---

# Team tasks

Shared, dependency-aware tasks that agents AND humans execute together. They
live as JSON files in the project's `plans/` — **the file is the source of
truth** (you edit it with your normal file tools; humans and Silos read the
same file). This skill is the one place the rules for tasks are written. The
recipes and the conduct are here; formats and the answers to every call are
in the `reference/` files beside this one — read the one a step names when
you reach that step.

Your own steps inside this conversation stay here — in the engine's checklist when it has one — never as Silos tasks. Plan mode's proposal is Claude Code's; it never goes in `plans/`.

## Claiming a task

When you pick up a task you own — before you start, before you read the file
to edit it, and ALWAYS before you launch subagents or worktrees for it —
claim it (`<slug>` is the file's name: `plans/<slug>.plan.json`; for the
project's list, `tasks`):

```
curl -s -X POST ${SILOS_API:-http://127.0.0.1:3210}/api/tasks/claim \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $SILOS_AGENT_TOKEN" \
  ${SILOS_AGENT_ID:+-H "X-Silos-Agent: $SILOS_AGENT_ID"} \
  -d '{"plan":"<slug>","task":"<id>","session":"'"${SILOS_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-$SILOS_CONSOLE_KEY}}"'","turn":"'"$SILOS_TURN"'"}'
```

Send the line as it is; don't resolve the session yourself.

- **200**: the task is `in_progress` and this conversation is linked to it,
  in one write (a `blocked` task is linked and stays `blocked`). The
  answer's `briefing` is the task as it stands: read it, then work. Say any
  `warn` to whoever asked you.
- **409 with `live`**: another conversation works it right now. Do NOT start
  it, and launch no subagent or worktree for it: tell whoever asked you.
  `"takeover":true` only when that work is abandoned or you were told to
  take it over.
- **Silos does not answer**: claim in the file by hand — the steps, and every
  other answer (`"linked": false`, 403, 404, «send folder», «done»), are in
  [reference/answers.md](reference/answers.md).

## Releasing a task

Release (the owner sees it as Unlink). While a conversation is linked to a
task it holds it — other conversations' claims get 409 and the owner's
wakes wait for it — so when you switch to something else, release the task
first. In a Silos console of Claude Code, `/clear` keeps the conversation and its tasks (Silos reminds you of them, with this recipe filled); anywhere else — OpenCode's `/new`, a claude you started yourself — the next conversation is a new one with a new id, nothing reminds it, and it cannot release for the old one: release before you switch.

```
curl -s -X POST ${SILOS_API:-http://127.0.0.1:3210}/api/tasks/release \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $SILOS_AGENT_TOKEN" \
  ${SILOS_AGENT_ID:+-H "X-Silos-Agent: $SILOS_AGENT_ID"} \
  -d '{"plan":"<slug>","task":"<id>","session":"'"${SILOS_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-$SILOS_CONSOLE_KEY}}"'","turn":"'"$SILOS_TURN"'"}'
```

As it is, the release sends the task back to `pending`, for someone to pick
up. To leave it otherwise, add `"state"` to the body — `"state":"done"`,
`"state":"blocked"` (write its `dependsOn` or `waitingOn` first) or
`"state":"in_review"` (write its `waitingOn` naming who reviews first). What
each answer means is in [reference/answers.md](reference/answers.md).

## Behavior

1. **One piece of work = one task.** Put it in the project's list (create the
   list if missing). Make a named plan only when several tasks coordinate,
   and draft that plan WITH the human: propose tasks, owners and
   dependencies, adjust to their feedback, then write the file. Do not
   seed it with the person's future OKs or reviews: ask when you reach the
   point where you cannot go on (a wait on your task), not before.
2. **Update the file on EVERY status change** (yours, or one the human
   reports) — never batch silently. This includes EVIDENCE, not just words:
   when something the human did shows up on its own — a document lands in
   the context folder, a confirmation email arrives, a receipt is pasted
   into chat — record it in the task immediately (status + a note with the
   identifiers: registry numbers, dates, file locations). The human should
   never have to say "write that down".
3. **A human's task closes on the human's word or on evidence the system
   holds — never on your guess.** The human confirms in chat, or with Done
   on the task's row in Silos (Silos sets that task's `status`; reflect it
   and recompute what it unblocks). You may close it yourself ONLY when the
   proof is in the system: the branch is merged (git), the agent exists in
   the roster, the file is in the folder, the message is in the thread — and
   you write the proof in the note (`Done — evidence: merged as a1b2c3d on
   02-11`). What happens in the world (a signature, a payment, a meeting, a
   phone call) stays theirs until they say so. A human task that no longer
   makes sense is `Dropped:` with the reason, same as yours.
4. After each update, tell the human briefly what is now on THEM (their
   pending tasks, and what each one unblocks) and which tasks are READY
   (all dependencies done) and can run in parallel.
5. When resuming work, read the task's file FIRST and continue from its
   state. The task's owner claims it first («Claiming a task»), then reads
   the file; for someone else's task, message its owner.
6. **Work asked by a message becomes a task.** When a message (from the
   owner or another agent) asks for work longer than a few minutes, it
   becomes a task — in the project's list, unless it belongs to a named plan
   that already exists (then there), or the update of the task already
   tracking that work — never just "read". Follow-ups to the same work go
   into that task's `notes`, not into a second task. The answer to the
   message names the file and the task id. When that work is done (or not
   yours), close the message with
   `{"state":"answered","answer":"<what you did / where it is / what is left>"}`
   — that answer is the reply; the sender sees it — and close the task.
7. **Close the loop wherever the work ends.** Work often finishes in a
   session that never opened the task (an incident, a quick fix, a merge).
   Before you finish ANY piece of work in a project, look in its
   `plans/*.plan.json` (the project's list included) for a task it completes
   or advances, and update it there and then, with the evidence (commit,
   file, date). Writing the outcome only to memory, a history file or the
   conversation leaves the task lying.
8. **A finished named plan leaves the list**: when every task of a named plan
   is done, move the file to `plans/closed/` (Silos only reads
   `plans/*.plan.json`). Never the project's list `plans/tasks.plan.json`:
   it stays, and Silos rotates its old finished tasks itself.

## Three things that are not the same

- **The engine's checklist** = the steps inside ONE conversation. It may not
  exist (it depends on the engine and the model). Use it for your own steps;
  it dies with the session, and Silos only reads it.
- **Claude's plan mode** (its proposals live in `$CLAUDE_CONFIG_DIR/plans/`)
  = a proposal before acting, for the person in front of you to approve. It
  is not a Silos plan and is never written to the project's `plans/`.
- **A Silos task** (this skill) = work with an owner that outlives the
  conversation: someone (you later, another agent, a person) must do it, and
  Silos shows it, wakes on it and links it to the conversations that work it.

## When to use

- A single piece of work someone must do later or elsewhere — yours for
  another session, another agent's, a person's: one piece of work = one task in plans/tasks.plan.json,
  the project's list.
- Work a message asked for (rule 6).
- Several tasks that coordinate — dependencies between them, a phase, a
  demo, steps a HUMAN must take in the middle: a **named plan**,
  `plans/<kebab-slug>.plan.json`, created as a plan from the start.
- Someone asks what is on them, who does what, or what is pending.

Not for: "plan X" or "what are the steps" inside a coding session where you
alone will do the work now — that stays in this conversation (the engine's
checklist), or plan mode if they want to approve the approach first.

## The files

- **The project's list** `plans/tasks.plan.json` — where a loose piece of
  work lands. It never finishes and never moves. If it does not exist,
  create it as `{ "title": "", "tasks": [] }` — the empty title is on
  purpose: don't fill it. Never under another name. Group related tasks
  inside it with `parent` instead of making a plan for them.
- **A named plan** `plans/<kebab-slug>.plan.json` — the unit that closes.
  Create it as a plan from the start; don't move tasks between files later
  (ids and links break).

A task of the project's list is named by its project, as the screen shows it: `<project>#t3` — say it so in notes and answers. In the API send `"plan":"tasks"` (Silos finds the project from your conversation; add `"folder"` when it asks), and `"plan":"<project>"` works too. Never name a plan like its project folder.

These files are the project's ONLY task list: no `BACKLOG.md` or TODO file
beside them — a list Silos cannot read is a second truth that drifts.
From a git worktree, edit the main checkout's `plans/` — `"$(git rev-parse --path-format=absolute --git-common-dir)/../$(git rev-parse --show-prefix)plans/"`, run from the project's root — never the worktree's copy: Silos reads only the main one.
They are live state, not code: keep `plans/*.plan.json` out of git.

A task, at its smallest:

```json
{ "id": "t4", "title": "Reconcile the Stripe fees", "owner": "finance",
  "status": "pending", "dependsOn": ["t2"],
  "notes": [{ "at": "2026-08-26T10:02:00Z", "by": "finance", "text": "What is done, what is left" }] }
```

- `id`: never reuse or renumber one; a new id goes above every id in `tasks`
  and in `retired`.
- `owner`: an agent id, `owner` for the person who runs Silos (always that
  word, never their name), or a teammate's name.
- `status`: `pending` · `in_progress` · `in_review` (only with a `waitingOn`
  naming who reviews) · `blocked` (only with an open `dependsOn` or a
  `waitingOn`) · `done` · `cancelled` (resolves no dependency). A dropped
  task is `cancelled` with a note that starts `Dropped:` — never deleted.
- `notes` are append-only, signed with your own id.
- A task owned by a person is work only they can DO in the world (a
  signature, a purchase, a filing). A decision or an OK you need is a
  `waitingOn` on YOUR task, never a task of theirs.

Every other field (`due`, `parent`, `waitingOn`, `nextCheckAt`, `binding`,
`conversations`, `releases`), a full example, and what Silos does with a
shape it cannot read: [reference/schema.md](reference/schema.md) — read it
before you write a field you have not written before.

## Writing the file

- Read → modify → write the WHOLE file, always valid JSON, then **read it
  back** and check your change is there. If the same write fails twice, stop
  and say plainly that it FAILED — never that it "should be there".
- **Silos writes in these files too** (the claim and release, the owner's
  Done / Drop / Reopen and answers, asks, stalls, the list's rotation):
  always re-read right before you write, and keep what it wrote.
- **In an unattended turn** (a heartbeat, a task wake, an automation run) a
  task you create must say what it answers in `"signal"`: the append-item
  recipe is in [reference/schema.md](reference/schema.md).

## Asking and waiting

- **Work from another agent of the same project** → a task owned by that
  agent, and `dependsOn` it if you wait (same file). Creating the task wakes
  nobody: only the owner's gesture starts it.
- **Work in a folder of another agent of your projects that is not yours**
  → a message to that agent; the receiver turns it into a task (rule 6).
  Outside your projects → the owner: there is nobody else for you to reach.
- **A question or a review for another agent** → ask it through Silos from
  your own task (`POST /api/tasks/ask`); a wait written by hand reaches
  nobody.
- **An ask you were given** (an `ask:<key>` line) → answer it once with
  `POST /api/tasks/ask/answer`; never edit their task to answer.
- **Waiting on a person** → `waitingOn {owner, action, asked}` on YOUR task.
  When you wait on the owner, ALWAYS write `asked` (and `options` when the
  answer is a choice): `asked` is your question, one sentence, answerable as
  it stands. Never leave your task `in_progress` "waiting for the OK".

Both recipes, what the owner may be asked, and what each answer means:
[reference/asking.md](reference/asking.md).

## Reference

Read the file when you reach the step — none is needed to claim, work and
release a task.

| File | Read it when |
|---|---|
| [reference/schema.md](reference/schema.md) | you write a field beyond the smallest task, create a task in an unattended turn, or the project's list rotated |
| [reference/asking.md](reference/asking.md) | you ask another agent, answer an ask, or wait on a person |
| [reference/answers.md](reference/answers.md) | a claim or a release answered something other than a plain 200, or Silos does not answer |
| [reference/reconciling.md](reference/reconciling.md) | you are asked to check that tasks are up to date |
| [reference/executing-a-document.md](reference/executing-a-document.md) | you execute an implementation plan that already exists as a document |
