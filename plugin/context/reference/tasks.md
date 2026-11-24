# Silos tasks — the file, the asks and the claim

The reference behind the briefing's Tasks rule: read it before you write in `plans/` or work a task.

## The file

The project's list is `plans/tasks.plan.json`; create it if missing as `{"title": "", "tasks": []}` — the empty title is on purpose, don't fill it. A named plan is `plans/<slug>.plan.json`, only when several tasks coordinate.

Its shape: `{"title": "<plan title>", "tasks": [{"id": "t1", "title": "<what>", "owner": "<agent id | owner | a person's name>", "status": "pending", "dependsOn": [], "notes": [{"at": "<ISO>", "by": "<you>", "text": "<what is done, what is left>"}]}]}` — `status` is `pending` · `in_progress` · `in_review` (only when the task itself is under review) · `blocked` (only with an open `dependsOn` or a `waitingOn {"owner","action"}`) · `done` · `cancelled`; new ids go above every id in `tasks` and `retired`; never reuse or renumber one; notes are append-only. Always valid JSON: read → modify → write the WHOLE file, then read it back. Silos writes in these files too — the claim and release, the owner's Done / Drop / Reopen and answers, Task mode, a stall it flags, the project's list's `rotatedAt` and `retired` — so re-read right before you write and keep what it wrote. From a git worktree, edit the main checkout's `plans/` — `"$(git rev-parse --path-format=absolute --git-common-dir)/../$(git rev-parse --show-prefix)plans/"`, run from the project's root — never the worktree's copy: Silos reads only the main one. A finished named plan moves to `plans/closed/`; the project's list never moves (Silos rotates its old finished tasks itself).

## Other agents and people

Work from another agent of this project is a task it owns (`dependsOn` it if you wait): creating it wakes nobody — a message to that agent is read at its next conversation, and starting it is the owner's gesture. A wait on a person is their task plus `dependsOn`, or `waitingOn` on yours; when you wait on the owner, always write `"asked"` (your question, one sentence) and, when the answer is a choice, `"options"` (1 to 4 short answers). A question or a review for another agent goes through Silos from your task: `POST /api/tasks/ask` with `{"plan":"<slug>","task":"<id>","to":"<agent id>","action":"<what you wait on it for>","asked":"<your question>","turn":"$SILOS_TURN"}` (`"review":true` for a review) — Silos writes the wait for you and wakes nobody; the agent sees it at its next heartbeat or conversation, and its answer lands on your task as a note. An ask you were given (an `ask:<key>` line) you answer with `POST /api/tasks/ask/answer` and `{"key":"<key>","text":"<your answer>","turn":"$SILOS_TURN"}` — «not mine — ask the owner» is an answer too. Without a bearer (a claude started by hand), write the `waitingOn` naming the agent yourself: the owner relays it.

## Unattended turns

In an unattended turn (a heartbeat, a task wake, an automation run) a task you create is your own creation: create it with append-item (`POST /api/silos/plans/record/append` with `{"key":"folder:<project folder>/tasks","collection":"tasks","values":{…,"signal":"<what it answers>"},"turn":"$SILOS_TURN"}`) — or, editing the file, write `"signal"` in the task object: Silos registers and judges it the same, and cancels what names no signal or is over your quota.

## Dropping a task

A dropped task is `cancelled` with a note that starts `Dropped:` and says why — never deleted; `cancelled` resolves no dependency, so fix what depended on it.

## Claim and release

Before you work a task, claim it — Silos links this conversation and sets `in_progress` in one write (a `blocked` task stays blocked):
```
curl -s -X POST ${SILOS_API:-http://127.0.0.1:3210}/api/tasks/claim \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $SILOS_AGENT_TOKEN" \
  ${SILOS_AGENT_ID:+-H "X-Silos-Agent: $SILOS_AGENT_ID"} \
  -d '{"plan":"<slug>","task":"<id>","session":"'"${SILOS_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-$SILOS_CONSOLE_KEY}}"'","turn":"'"$SILOS_TURN"'"}'
```

A 409 with `live` means another conversation works it now: don't start it (`"takeover":true` only when you were told to take it over). `"linked":false` means Silos doesn't know this conversation yet: the task is `in_progress`, the owner links it from ⌘K. When you switch this conversation to something else, release the task first (the owner sees it as Unlink) — it stays in its history and goes back to `pending`; add `"state":"done"`, `"blocked"` or `"in_review"` to the body to leave it so (it applies only while the task is `in_progress` and this was the last conversation on it). In a Silos console of Claude Code, `/clear` keeps the conversation and its tasks (Silos reminds you of them, with this recipe filled); anywhere else — OpenCode's `/new`, a claude you started yourself — the next conversation is a new one with a new id, nothing reminds it, and it cannot release for the old one: release before you switch.
```
curl -s -X POST ${SILOS_API:-http://127.0.0.1:3210}/api/tasks/release \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $SILOS_AGENT_TOKEN" \
  ${SILOS_AGENT_ID:+-H "X-Silos-Agent: $SILOS_AGENT_ID"} \
  -d '{"plan":"<slug>","task":"<id>","session":"'"${SILOS_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-$SILOS_CONSOLE_KEY}}"'","turn":"'"$SILOS_TURN"'"}'
```

If Silos does not answer, claim by hand: add your session id to the task's `conversations` (after the ids already there) and set `"status": "in_progress"`; if the last entry for your session in the task's `releases` says `"released": true`, also append `{"session": "<your session id>", "released": false, "at": "<ISO now>", "by": "<your agent id>"}` to `releases`. Never touch `releases` otherwise.
