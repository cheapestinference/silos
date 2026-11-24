# Team tasks — what a claim and a release answer

Reference for the `team-plan` skill. The recipes are in SKILL.md; this is
every answer they give and what to do next. (The answers to an ask are in
[asking.md](asking.md).)

## The session a claim sends

The session is the first one set: `$SILOS_SESSION_ID` (a Silos console —
with Claude Code it stays the same across `/clear`; with OpenCode it is the
`ses_…` id Silos' plugin sets — or the conversation a nested `claude -p`
runs under), `$CLAUDE_CODE_SESSION_ID` (a Claude Code console Silos did not
launch), `$SILOS_CONSOLE_KEY` (a new OpenCode console before its id is
known). Send the line as it is; don't resolve it yourself. A command
automation (a script, no conversation) has no session: it never claims or
releases — its run's outcome is its record; a turn of yours (`onFailure:
"agent"`) claims like any conversation.

## Claim

- **200**: the task is `in_progress` and your conversation is linked to it,
  in one write. A `blocked` task is linked but stays `blocked` (its wait is
  still open — the `warn` says so): work toward what it waits on, or change
  its dependencies, then set its status yourself. The answer's `briefing` is the task as it stands (latest
  notes, who else worked it): read it, then work. A `warn` in the answer
  (the conversation is another agent's, or the task is) does not block —
  say it to whoever asked you.
- **200 with `"linked": false`**: Silos does not know this conversation yet
  (a `claude -c` / `--resume` without an id gives the startup id). The task
  is `in_progress`; nothing is linked — the owner links the conversation
  from ⌘K. Work on; don't retry.
- **409 with `live`**: another conversation is working this task right now —
  the error says whose and how long ago. Do NOT start it, and launch no
  subagent or worktree for it: tell whoever asked you. Only when that work is
  abandoned, or you were told to take it over, claim again with
  `"takeover":true` — Silos writes the hand-over note in the task.
- **409 «done»**: it is finished; more work is a new task.
- **403**: it is another agent's task (message its owner — Messages in your
  briefing), or the session is another agent's (send the line above as it
  is).
- **404 / 409 «send folder»**: the plan or task id is wrong, or several
  projects have that plan — add `"folder":"<the project's root>"`.
- **Silos does not answer** (connection refused, no server): fall back to
  the file — add your session id to the task's `conversations` (after the
  ids already there; `["<id>"]` when it has none) and set `in_progress`.
  If the task has `releases` and the last entry for your session says
  `"released": true`, also append
  `{ "session": "<id>", "released": false, "at": "<ISO now>", "by": "<your agent id>" }`
  to `releases` (that revives it). Never touch `releases` otherwise. Then
  read it back. It is the same data the claim writes.

## Release

Without a `"state"` the release sends the task back to `pending`, for
someone to pick up. To leave it otherwise, add `"state"` to the body — `"state":"done"`,
`"state":"blocked"` (write its `dependsOn` or `waitingOn` first) or
`"state":"in_review"` (write its `waitingOn` naming who reviews first — a
409 «name who reviews first» otherwise, and nothing is released). The state
changes only when the task is
`in_progress` and this conversation was the last one working it; otherwise
the status stays as it is and the answer says `"kept": "<status>"` (another
conversation still works it, or you already set it). Releasing twice
changes nothing (`"already": "released"`). The conversation stays in the
task's history; claiming the task again from the same conversation revives
the link. A 409 «not on <ref>» means this conversation was never linked to
that task: nothing to release (after an OpenCode `/new` or a hand-started
claude's `/clear`, the link is the previous conversation's).
