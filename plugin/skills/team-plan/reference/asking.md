# Team tasks — asking and waiting

Reference for the `team-plan` skill: how to get work, an answer or a review
from another agent or a person, the two recipes, and what each answer means.
What you may ask the owner, and the shape of `waitingOn`, are in
[schema.md](schema.md) (`waitingOn`).

- **Work from another agent of the same project** → a task owned by that
  agent, and `dependsOn` it if you wait (same file). Creating the task
  wakes nobody that Silos wakes on its tasks — only the owner's gesture does
  (an agent watching its plans finds it on its own). A message to that
  agent is read at its next conversation (Messages in your briefing); to
  move your OWN task now, assign it (POST /api/tasks/assign with
  `{"plan":"<slug>","task":"<id>","turn":"$SILOS_TURN"}`; `queued:false` in the
  answer comes with a `why` — nothing started).
- **Work in another agent's territory** → only the message; the receiver
  turns it into a task (rule 6).
- **A question or a review for another agent** (not work it must do: that
  is a task of its own, above) → ask it through Silos, from your own task:
```
curl -s -X POST ${SILOS_API:-http://127.0.0.1:3210}/api/tasks/ask \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $SILOS_AGENT_TOKEN" \
  ${SILOS_AGENT_ID:+-H "X-Silos-Agent: $SILOS_AGENT_ID"} \
  -d '{"plan":"<slug>","task":"<id>","to":"<agent id>","action":"<what you wait on it for>","asked":"<your question, one sentence>","turn":"'"$SILOS_TURN"'"}'
```
  Add `"review":true` when it reviews your finished work. Silos writes the
  wait on your task for you — `waitingOn {owner, action, asked}` and
  `blocked` (`in_review` for a review) — keeping action and question as
  sent (at most 80 and 500 characters). The ask wakes nobody: the other
  agent sees it at its next heartbeat, or when its next conversation starts.
  The answer says which: `"sees":"beat"` (its next heartbeat comes within a
  day) or `"sees":"relay"` (none does — the owner relays it, Needs you says
  so). Its answer lands on your task as its note, clears the wait, leaves
  the task `pending` (still `blocked` while a dependency is open), and wakes
  you if your tasks wake you. Asking again the same thing changes nothing;
  asking again something else replaces the ask. To withdraw it, remove the
  `waitingOn` from your task yourself. The 409s say why, each with the next
  step: the task is closed, the agent is you or not in play, the task waits
  on someone else already (one wait at a time), a review with a dependency
  still open, the agent answered 3 times on this task in 24 hours, your
  asks for today are spent — then ask the owner instead (`waitingOn
  {"owner":"owner", …}`). Within one plan file, work you need done is still
  a task of the other agent plus `dependsOn`; across plan files, ask — the
  other agent makes the work its own task if it takes it on.
  **Without a bearer** (a `claude` you started by hand has no identity: the
  ask is 401), write the `waitingOn` naming the agent in the file yourself:
  it is a plain wait, and the owner relays it.
- **Answering an ask** (an `ask:<key>` line in your heartbeat, or «Asks
  waiting on you through Silos» when a conversation starts):
```
curl -s -X POST ${SILOS_API:-http://127.0.0.1:3210}/api/tasks/ask/answer \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $SILOS_AGENT_TOKEN" \
  ${SILOS_AGENT_ID:+-H "X-Silos-Agent: $SILOS_AGENT_ID"} \
  -d '{"key":"<key>","text":"<your answer>","turn":"'"$SILOS_TURN"'"}'
```
  Answer once, in plain words (at most 8000 characters); «not mine — ask the
  owner» is an answer too. Silos writes it as your note on their task,
  clears their wait, and wakes them when their tasks wake them — never edit
  their task to answer. A 409
  «nothing asks you» means it was answered already or withdrawn; «no longer
  waits on you» means its owner or the owner moved the task first — leave a
  note if it still matters. Work the ask needs is a task of yours (in a
  heartbeat, `"signal":"ask:<key>"`).
- **Waiting on a person** → an answer, a decision or an OK is
  `waitingOn {owner, action, asked}` on YOUR task, never a task of theirs;
  only work they must DO in the world is a task of theirs you `dependsOn`.
  Never leave yours
  `in_progress` "waiting for the OK" — nobody sees a wait that no task
  names. When your work is finished but needs someone's OK (a merge, a
  deploy, a payment), it is `in_review` with `waitingOn` naming who gives
  the OK (the review model, [schema.md](schema.md)); their answer comes back as a note and
  the task pending again, or done when they approve.
- **`in_review`** only when that task IS the review, and always with its
  reviewer in `waitingOn` ([schema.md](schema.md)).
