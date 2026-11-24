# Team tasks — the file format

Reference for the `team-plan` skill: every field of a task, what Silos does
with a shape it cannot read, the project's list's rotation, creating a task
in an unattended turn, and what Silos itself writes in these files.

## A whole file

```json
{
  "title": "August books close",
  "createdAt": "2026-08-25",
  "updatedAt": "2026-08-27",
  "tasks": [
    { "id": "t1", "title": "Export the month's sales", "owner": "finance",
      "status": "done", "dependsOn": [],
      "notes": [{ "at": "2026-08-26T10:02:00Z", "by": "finance", "text": "Exported: 412 invoices, file context/finance/sales-08.csv" }] },
    { "id": "t2", "title": "Confirm the figure with the accountant", "owner": "owner",
      "status": "pending", "dependsOn": ["t1"], "due": "2026-08-28" },
    { "id": "t3", "title": "Close the month in the ERP", "owner": "finance",
      "status": "blocked", "dependsOn": ["t2"],
      "conversations": ["3f1c2a9e-1b2c-4d5e-8f90-123456789abc"] },
    { "id": "t4", "title": "Reconcile the Stripe fees", "owner": "finance",
      "status": "blocked", "dependsOn": [], "parent": "t3",
      "waitingOn": { "owner": "owner", "action": "choose how fees are booked",
        "asked": "Do I book the Stripe fees in the month of the charge or of the payout?",
        "options": ["Month of the charge", "Month of the payout"] },
      "nextCheckAt": "2026-08-28T09:00:00Z" }
  ]
}
```

## Fields

- `id`: short stable ids (`t1`, `t2`…). Never reuse or renumber existing ids.
  A new id goes above every id in `tasks` AND in `retired` (the project's
  list's rotated ids — «The project's list rotates» below).
- `owner`: an agent id (`finance`, `builder`…), `owner` for the person who runs
  Silos (always that word, never their name — Silos knows who they are), or
  a teammate's name (`sam`). Silos has no door for a teammate: the owner
  sees their tasks (and a `waitingOn` naming them) and relays — so a
  teammate's task is how you make that wait visible, not how you reach them.
- `status`: `pending` | `in_progress` | `in_review` | `blocked` | `done` |
  `cancelled`.
  - `in_review`: its owner finished it and someone NAMED reviews it before
    it is done — the one review model: an agent's task in review carries
    `waitingOn {"owner": "<who reviews>", "action": "<what to check>",
    "asked": "<the question>"}` naming the reviewer (`owner`, a teammate,
    another agent — never yourself; another agent is asked through Silos
    with `"review":true`, [asking.md](asking.md)). A `nextCheckAt` is no reviewer: without
    the wait Silos says the task sits untouched and refuses a release with
    `"state":"in_review"`. Only when this task IS what is under review — any
    other wait is `dependsOn` or `waitingOn`.
  - `cancelled`: it will not be done. Finished like `done`, but it resolves NO
    dependency: a task that depends on it stays blocked until you remove or
    replace that dependency.
- `due` (optional, `YYYY-MM-DD`): a real deadline — a notary's validity, a
  tax filing, a certificate that expires. Silos raises the task in Needs you
  as it approaches. A date that lives only in a note is invisible to it. Not
  for wishes ("this week"): only dates the world sets.
- `dependsOn`: ids this task waits on, in the same file. `blocked` MUST mean
  "some dependency is not done" or a declared `waitingOn` — recompute
  statuses on every update so the file never lies. A wait on something
  outside the file (a date, a vendor, a model release) is `pending` with a
  note, or `waitingOn`; never `blocked` with neither.
- `parent` (optional): the id of the task this one is a subtask of. It groups;
  it does NOT block — if the parent really waits on it, also put it in the
  parent's `dependsOn`.
- `waitingOn` (optional): `{ "owner": "<who>", "action": "<what they must do>" }`
  — a wait on someone outside the file's tasks, said where Silos reads it.
  When you wait on the owner, ALWAYS write `asked` (and `options` when the
  answer is a choice): `asked` is your question, one sentence, verbatim —
  Needs you quotes it; `options` is a list of 1 to 4 short answers (at most
  40 characters each) the owner answers with one tap. Never invent options
  for an open question; any other shape is ignored. Their answer comes back
  as a note on the task, with the wait cleared: it wakes you if your tasks
  wake you.
  Wait on the owner only for what is theirs and you cannot go on without:
  consent to something irreversible, outward-facing or that spends money,
  or a choice that is genuinely theirs — and anything they said they want
  to be asked about: their word wins over this rule. What you can decide,
  decide, and say what and why in a note. Never ask them to read: `asked` is answerable
  as it stands — the question itself, never «read <file> and tell me». If
  it takes a document to ask, you have not finished: reduce it to the
  choices, put the option you recommend first, and name the file in a note
  as backing.
  A wait on another AGENT you ask through Silos (POST
  /api/tasks/ask, [asking.md](asking.md)): one written by hand reaches nobody
  — the owner has to relay it.
  - `binding` (optional, only on a wait on `owner`): asks the owner to SIGN
    a Vault entry for your code —
    `"binding": { "entry": "<VAULT_ENTRY_NAME>", "baseUrl": "https://<host>",
    "inject": { "header": "<header>", "format": "Bearer %s" } }` (`entry`
    alone links the wait to the entry). Never a credential value. What the
    owner sees, what their save does and how to verify it are the Vault's
    rules (the `vault-secrets` skill, «Signed entries», when this session
    has it).
- `nextCheckAt` (optional, ISO date-time): when the task's owner looks at it
  again.
- A dropped task is `cancelled` with a note that starts `Dropped:` and says
  why (superseded by what, decided by whom). Never delete it. Like any
  `cancelled` task it resolves no dependency: fix what depended on it (drop
  the dependency or point it at the replacement).
- A task owned by a person is work only that person can DO in the world —
  a signature, a purchase, a filing, a credential to create, a call. Never
  a task of theirs to review, read, validate, confirm, decide or approve:
  checking quality is an agent's work (a reviewer's task), and a decision
  or an OK you cannot go on without is a `waitingOn` on YOUR task, which
  they answer with one tap. No "validate it live" tasks either: merged work
  is validated by being used; the owner objects when something is wrong.
  Your task ends at the merge.
- `conversations` (optional): the session ids of the conversations that
  worked the task, in either shape — `["<id>"]` or
  `[{ "session": "<id>" }]`. Silos links the task's row to those
  conversations, and does not wake the task's owner for it while one of them
  is working. You don't write it by hand: you **claim** the task
  (SKILL.md, «Claiming a task»), and Silos adds your conversation and sets
  `in_progress` in one write. Only a conversation that works the task claims
  it (never a beat that hands the work off).
- `releases` (Silos writes it): which listed conversations let the task go
  (`{ "session", "released", "at", "by" }`, append-only). A released
  conversation stays in the task's history but no longer works it. You
  release with the recipe in SKILL.md, never by hand — the one exception is
  the manual claim fallback ([answers.md](answers.md)).
- `notes` (optional): a list of `{ "at": "<ISO>", "by": "<your agent id>",
  "text": "…" }`, oldest first. Append only — never rewrite or delete a note
  (Silos itself appends one when the owner drops a task). Sign with your own
  id, never `owner`: the owner's notes are the ones Silos saw the owner
  write — a note you sign `owner` counts as yours.
- `updatedAt`: bump on every change.

Every field above except `id`, `title`, `owner` and `status` is optional. A
field in a shape the format refuses (a `notes` string, a `status` outside the
six) loses the whole TASK: Silos can't read it, so it is in no list and wakes
nobody — Home says «N tasks in <plan> can't be read» with the reason. A field
the format does not know (a lone `conversation`) is simply not read: the link
is lost. Write the shapes above.

## The project's list rotates

The project's list carries two fields Silos writes: `rotatedAt` (`YYYY-MM`) and
`retired` (ids). Silos rotates the project's list itself, at most once a day: every task finished (`done` or `cancelled`) before the current month began (UTC) — or finished with no date on record — moves to `plans/closed/tasks-<YYYY-MM>.plan.json`, unless an open task still names it in `dependsOn` or `parent`; its id is listed in `retired`, and links to it keep opening.
Keep both fields as they are; never reuse a retired id; never move, rename or
archive the project's list yourself. Read it back after you write it: a write
that raced a rotation can bring rotated tasks back.

## Creating a task in an unattended turn

In an unattended turn (a heartbeat, a task wake, an automation run) a
task you create is a creation of your own: create it with append-item,
saying what it answers in `"signal"` (`message:<id>`, `task:<key>`,
`run:<id>`… — an item of this turn — or `"mission"` in your weekly think)
and sending your `turn`:
```
curl -s -X POST ${SILOS_API:-http://127.0.0.1:3210}/api/silos/plans/record/append \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $SILOS_AGENT_TOKEN" \
  -d '{"key":"folder:<project folder>/tasks","collection":"tasks","values":{"id":"<new id>","title":"<what>","owner":"<who>","signal":"<what it answers>"},"turn":"'"$SILOS_TURN"'"}'
```
If you edit the file instead, write `"signal"` in the task object — Silos
registers it the same and judges it the same: what names no signal, or is
over your quota, it cancels with a note saying why.

## What Silos writes

Silos writes in these files too — always re-read right before you write,
and keep what it wrote:
- the claim and the release (`conversations`, `releases`, `status`);
- the owner's gestures: Done / Drop / Reopen (`status`, a `Dropped:`
  note), an answer to your question (an owner note, `waitingOn` cleared,
  and `pending` when nothing else holds the task), «Answer & done»,
  which also notes the tasks it unblocks, and «Give to…» (`owner`, a note
  «Handed from X to Y.», the conversations of the one it leaves released)
  — a task given away is no longer yours: stop working it;
- an owner's note on a closed task of an agent — or a blocked one nothing
  holds — reopens it in the same write (`pending`, or `blocked` while
  something still holds it; Silos' own `unstick` wait goes with it); a
  `nextCheckAt` that fired is cleared by Task mode;
- a task the owner creates through Silos is born whole: its details as
  its first note, the conversation it came from in `conversations`;
- an ask through Silos: the asker's `waitingOn` and `blocked` (or
  `in_review`); its answer: the answering agent's note, `waitingOn`
  cleared, and `pending` when nothing else holds the task;
- a stall nobody cleared: Silos marks the task `blocked` with a
  `waitingOn` naming who is asked now, plus a note — you stay its owner;
  an agent asked this way sees it as an ask and answers it like one;
- the project's list's `rotatedAt` and `retired` (above).
