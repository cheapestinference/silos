---
name: heartbeat
description: Use when your turn opens with «This is your heartbeat» — Silos woke you to decide, not to work. Answer or close your messages, start a pending task someone left you, record each idea you weigh, and sleep when nothing of your mission needs you.
---

# Heartbeat — you decide here; you do not work here

Silos fires your heartbeat at the rhythm the owner set (every week, or every
day with a weekly think). The turn opens with its packet: what changed
«since» your last heartbeat — your new messages, your failed automations,
pending tasks someone left you, waits, rows routed to you, what the owner
decided. Nothing else: work happens in a task, in a conversation of its own.

Every call below carries the turn's token — `"turn": "$SILOS_TURN"` — and your
bearer. Outside a heartbeat turn the considered and sleep calls are refused.

## What you may do

- **A message.** Answer or close it — `PATCH /api/agents/$SILOS_AGENT_ID/messages/<id>`
  with `{"turn":"$SILOS_TURN","state":"answered","answer":"<what you did>"}`
  (`"read"` when nothing is needed, `"needs_owner"` when only the owner decides).
- **A pending task of yours someone left you.** Start it, or leave it for the owner:

  ```bash
  curl -s -X POST "${SILOS_API:-http://127.0.0.1:3210}/api/tasks/assign" \
    -H "Authorization: Bearer $SILOS_AGENT_TOKEN" -H 'content-type: application/json' \
    -d '{"turn":"'"$SILOS_TURN"'","key":"<the task key>"}'
  ```

  The key is what the packet line starts with, after `task:` — or send
  `"plan":"<plan>","task":"<id>"` instead, the two halves of its ref
  (`<plan>#<id>`). Read `queued` in the answer: `false` comes with a `why`
  (it waits on something, a conversation is on it already) — nothing started.

- **A failed automation of yours.** Only when the fix takes a minute: fix the
  files it uses. Its schedule and prompt are the owner's.
- **Each idea you weigh — kept or dropped.** Record it, so the next heartbeat
  does not decide it again. Name the packet item in the idea
  (`message:<id>`, `task:<key>`, `run:<id>`…): a `dropped` item does not come
  back without a new change, a `later` one comes back after its `until`.

  ```bash
  curl -s -X POST "${SILOS_API:-http://127.0.0.1:3210}/api/agents/$SILOS_AGENT_ID/considered" \
    -H "Authorization: Bearer $SILOS_AGENT_TOKEN" -H 'content-type: application/json' \
    -d '{"turn":"'"$SILOS_TURN"'","idea":"message:<id> — <one line>","decision":"dropped","why":"<one line>"}'
  ```

  `decision` is `created`, `proposed`, `dropped` or `later` (with `"until":"<ISO>"`);
  at most 20 per heartbeat.
- **Sleep** when nothing of your mission needs you for a while (30 days at most):

  ```bash
  curl -s -X POST "${SILOS_API:-http://127.0.0.1:3210}/api/agents/$SILOS_AGENT_ID/heartbeat/sleep" \
    -H "Authorization: Bearer $SILOS_AGENT_TOKEN" -H 'content-type: application/json' \
    -d '{"turn":"'"$SILOS_TURN"'","until":"<ISO date>","why":"<one line>"}'
  ```

Creating work of your own — a task that answers a message or a failed run,
something from your mission — is said by the turn's opening text: it lists
what THIS turn may create and how many. A task you create names what it
answers in `"signal"`, in the packet's own form (`message:<id>`,
`task:<key>`, `run:<id>`, or `mission`); what the opening text does not list
is refused.

## What the turn does not have

No subagents, no question to the owner. Web tools and connectors only when
the turn's opening text says this turn has them; otherwise none — and do
not reach the net from the shell either (curl to anything but Silos, git, gh,
npm, pip, python, node all count as reading outside). Silos audits the
transcript. Your last message is the heartbeat's summary: one line of what
you decided.
