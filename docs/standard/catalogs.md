# Silo Standard v0 — Catalogs

The closed vocabularies a manifest chooses from: slots, relations, derived
surfaces, icons, theme tokens, archetypes, actions, field types, envelope roles,
the kernel-kinds catalog, urgencies and schema field classes. They are derived from the reference
manifests (`reference/`).

**Evolution rule:** entries are **only added**; renaming or retiring one is a major
version of the standard. Designed pieces that no reference manifest exercises yet
live in [`proposed-extensions.md`](proposed-extensions.md), not here.

## Slots

Slots are grants: what the approval dialog lists and what the operator switches
off, slot by slot.

| Slot | Surface | Condition / contract |
|---|---|---|
| `rail` | an entry in the global rail + a page of its own | only if the kind deserves its own detail; `{label, view}` |
| `pulse` | a term in Home's pulse sentence | `aggregate: count \| sum(<money>)`, optional `when`; over LIVE (non-terminal) states and the complete set; different currencies = separate terms; the order between silos is the operator's and the kernel folds the excess |
| `needs-you` | a dispatchable item in the inbox | requires `when` + `urgency` + `clears` (a dispatchable condition) + `actions`; an unconditional `blocking` does not validate; the per-silo budget folds only `due`/`routine`; more than N simultaneous `blocking` items ⇒ the silo's `status: warning` |
| `agent-section` | a section on the agent's page | `house: knows \| machinery`, never a third |
| `project-machinery` | a row in the project's machinery line | `{label}` |
| `lens` | grouping/folding over an existing surface | `{over: tasks, label?, groupBy: {relation, by: subtree}}`; the relation is an acyclic agent → agent relation of the same silo; **kernel floor**: it folds, never hides — what blocks, what is escalated and what is ready for the owner is shown unfolded above the groups, and what falls in no group goes to «No team»; a visible chip switches it off in one click |

Annex (v0.x): `column-block`, `mention`.

## Relations

`spec.relations[]`: `{name, from: agent, to: agent, cardinality: one, acyclic,
writableBy: owner}`. A silo with relations MAY have no producer, sources or kinds
(an edge-only silo).

- The KERNEL stores the edges (`<dataDir>/silos/<id>/relations.json`,
  `GET/PUT /api/silos/:id/relations/:name`), and only the owner writes them — an
  agent's bearer gets 403: a job title or a reporting line grants no access.
- The kernel refuses in words a dangling id, an edge to itself and, if `acyclic`,
  a cycle.
- An edge whose agent is archived or deleted stays in the file, said, and out of
  every chain.

## Derived surfaces

Always on, free, never requested: the `record` page of every kind, `cmdk` (⌘K —
the house rule), `sidebar-glyph` (emerges from state anchored to an agent with
needs-you items), and — once two silos can co-anchor — the **hubs strip**
(annex). **Sub-kinds do NOT get derived surfaces by
default**: they are declared if wanted.

## Icons

`metadata.icon` names the silo's glyph from a closed catalog; the kernel draws it
wherever the silo is named by a mark (the rail, its pages). Absent = the kernel's
own silo glyph. A manifest names an icon and never carries one.

| name | for |
|---|---|
| `help` | support, helpdesk, questions |
| `invoice` | invoices, receipts, money owed |
| `document` | documents, contracts, files to answer |
| `people` | who reports to whom, contacts, teams |
| `system` | the machine: processes, limits, health |
| `inbox` | mail and messages that arrive |
| `tasks` | work to do, lists |
| `calendar` | dates, renewals, schedules |

## Theme tokens

`spec.theme` (`{name, light, dark}`) declares a look in these words, for light AND
for dark. The vocabulary is closed: an unknown token rejects the manifest (it is
not a want — a colour the kernel cannot place would vanish silently). Every value
is `#rrggbb`: no alpha, no names, no functions. The kernel maps the words onto its
own surfaces and derives what they do not name (its shimmer, the dark console
frame from the dark mode's values, the selection); a theme never reaches fonts,
layout, status colours or the terminal palette.

| token | required | what it paints |
|---|---|---|
| `background` | yes | the page |
| `panel` | yes | raised surfaces: the sidebar, cards, the selected row |
| `text` | yes | body text |
| `text-2` | yes | secondary text |
| `text-3` | yes | hints and timestamps |
| `border` | yes | hairlines between things |
| `accent` | yes | links, counts, what is live, solid buttons |
| `on-accent` | yes | the label on a solid accent button |
| `accent-soft` | no | the tint behind what is selected — absent, the kernel derives it: `accent` at 12% over the page |

**The contrast rule** (WCAG 2.x ratios; conformance §12), in each mode:

| pair | minimum |
|---|---|
| `text` on `background`, `text` on `panel` | 7:1 |
| `text-2` on `background`, `text-2` on `panel` | 4.5:1 |
| `accent` on `background`, `accent` on `panel` | 4.5:1 |
| `on-accent` on `accent` | 4.5:1 |
| `text-3` on `background` | 3:1 |

## Archetypes

Archetypes are page shapes; slots are placements.

| Archetype | Semantics | Status in v0 |
|---|---|---|
| `record` | the detail of ONE record: fields in voice, actions, anchors (and the hubs strip once it exists) | derived, free for every kind — not declared |
| `list` | table/cards + facets + fold; a text search on the same line; optional (21-11, System): `first: {when}` — what goes first, the mirror of fold — and `groupBy: <dimension>` — a field, `agent`, `folder`, `project` or `state` —; `fold.label` (21-11) — what the folded records are, in a few words; `label` (21-11, System 0.3.0) — the view's name on its silo's page, one line of at most 40 characters: a silo with several `list` views over different kinds shows a switch between them by these names (the first is the default) | **v0** (support, plans, system) |
| `board` | kanban over the declared states; `groupBy: state`, `swimBy: parent` | **v0** (plans/task) |
| `timeline` | a time feed | annex — enters with the first silo that needs it |
| `tree` | roots = the ends with no outgoing edge, children by the named relation (`relation`); each node = the hub's entity with its live line; the edge editor lives on the silo's page | **v0** (hierarchy) |
| `credentials` | masked key-value | annex — enters with `sensitive` |
| `files` | a document browser | annex |

**`list`, in detail (21-11).** The order: what is folded goes last; with
`groupBy`, the groups that hold some `first` record come first, then by their
most recent record, and the group with no value goes LAST, named («No
conversation»: `No` + the field's `label`); inside a group, `first` first and
then the most recent. The group's value breaks every tie, so a group is
contiguous across pages; its count is over the whole matching set (a page that
shows part of it says so: «4 of 7»). The search (`q` on the records route)
asks every term to appear, case-insensitively, in the identity, in a cell the
view shows or in the group; it is an explicit request — like a filter, it turns
fold off — and the count line is still the server's («3 of 24 match»). One
filter line: search, facets, count. The fold line says how many and WHAT they
are: with `fold.label` (optional, one line, ≤ 60 characters) «55 ended or
another user's · Show»; without it, «55 more · Show». With `groupBy`, the
heading of a group whose value is a reference the web can open (a conversation
that exists, an agent, a project) IS the door — the same target as its cell; a
group with no target (a deleted conversation, «No conversation») stays text.

Each archetype is built ONCE by the kernel. When a hand-built page is moved onto
an archetype, the gate is a side-by-side comparison with the hand-built page: if
the generated one is worse, the archetype goes back to the workshop, not the silo.

## Actions

The v0 verbs — the ones the reference manifests use.

| Verb | What it does | Contract |
|---|---|---|
| `set-field` | the owner transitions listed fields (`fields.<n>.writableBy: owner`) | write discipline of the standard («Writing»): CAS on curated sources; **overlay** on sync sources (seals the base value, retires when the source reaches it, contradiction → Needs you); auditable through `updatedBy` + the journal |
| `append-item` | add a child to an `appendOnly` sub-kind | declared `writeMerge` (union by keys + order) |
| `move-item` | move a child between parents | FIXED semantics of the verb: destination before source (a crash ⇒ a visible duplicate, not a loss), idempotent retry; the parent's computed fields are recalculated |
| `ensure-record` | ensure ONE reserved record (`id`) of a top-level kind in a project folder the source reads (plans: the project's list `plans/tasks.plan.json`) | born from `seed` when missing, exclusive write — never overwrites one that exists. With `rotate`, once a month the children that match `when` (except those a staying child names through `keepReferencedBy`) are written to `into` (`{{month}}` = the closed month; union by id, never overwritten) BEFORE they leave; their ids go to `retired` and are never reused; `stamp` keeps the month. With `undated: "old"`, inside that `when` a `since(…)` with no recorded transition counts as old. `retired` never shrinks: the kernel rebuilds it as the union of the ids in the `into` archives that already exist; if a child is both live and in an archive, the live one wins (and on the next rotation its copy replaces the archived one). The kernel MAY also rotate in a sweep of its own (once per location and day), only over a record that already exists — the sweep never creates it. Owner only |
| `claim` | take ONE task: add an id to the `link` collection of the `subKind` (an identity collection — plans: `conversations`) and apply `set` (`{status: in_progress}`) in the SAME write — except in the states of `keep` (plans: `[blocked]`), where the claim links without touching the state | FIXED semantics of the verb: `link` is a collection of the `subKind`; adding the id is idempotent (already listed ⇒ not duplicated) and `set` applies all the same; only fields with declared states in `set`; `by` ⊂ {`owner`, `task-owner`} — `task-owner` = the agent that `roles.task.owner` names in that record (requires the role). If that id's thread had been released, the same write appends `{session, released: false}` to the releases collection |
| `release` | release ONE conversation from a task: append a mark `{session, released: true, at, by}` to the `link` collection (= `roles.task.releases`) | FIXED semantics of the verb: only appends, never rewrites or deletes a mark; the last mark of each thread, by position, decides (no marks or `released: false` ⇒ current; `true` ⇒ past); idempotent only against the last mark of its thread. Without `dispose`, it does not change the task's state. With `dispose: {field, from, default, allowed}` the SAME write as the mark sets `field` to the requested state (one of `allowed`) or, when none is requested, to `default` — only if the task is in `from` at write time **and** the released thread was the last current one; if another current thread remains, or the task is in another state, the state is untouched and the response says `kept: <state>`; a mark that already existed (`written: false`) does not touch it either (`kept` + `already: released`); a requested state outside `allowed` ⇒ 400. `field` is the `subKind`'s state field; `from`, `default` and `allowed` are declared states. `set` stays forbidden on release. `by` ⊂ {`owner`, `task-owner`} |
| `agent-record-write` | the producer changes its own records through the API with its bearer | derived from location; never someone else's records |
| `ack` | a persistent «seen» | the needs-you acknowledgement pattern |
| `open` | navigate to the entity/anchor | |
| `message-agent` | a message to the producer, optionally from `templates` | every templated message carries provenance («composed from record X via silo Y»); it never passes through the owner's prose |
| `kernel-verb` | the owner asks the KERNEL for a mutation of its own records: `{verb: kernel-verb, name, kind, when?}` (21-11, a v0 addition — System 0.2.0) | only over a `kernel` source; `name` from an ENUMERATED, closed catalog (below, «Kernel-verbs») that the kernel kind admits (`verbs` in its entry); `kind` the manifest's kind that presents it; `when` optional, a predicate over the record (when the page offers the door). A name the kernel does not know rejects the manifest. Always an owner gesture — an agent acts from its own shell; the kernel re-checks its guard over live data at the gesture and the answer says in words what happened; the event goes to the record's story |

Over a `kernel` source, only `open`, `ack` and the `kernel-verb`s its kind
admits: kernel data is never written by a silo verb.

Annex / later: `re-anchor` (an owner gesture), `hand-off`, `create-automation`;
more names in the `kernel-verb` catalog (the meta-silo's Install/Uninstall).

## Kernel-verbs — a closed catalog

A `kernel-verb` is a mutation by the kernel, declared and visible as such: the
silo NAMES it, the kernel does it (there is no code in the manifest). The
catalog is **enumerated and closed** — «a kernel source» is not enough of a
guard: each name enters with its step, its kind and its guard, and names are
only added (like the slots). Each one is admitted by the kernel kind in its
entry (`verbs`); its **guard** is a boolean field the kernel writes on every
record of the kind — whether the verb applies to THAT record now (the page
hides the door when it is false) — and that the kernel checks again at the
gesture over live data, whatever the page said. Every kernel-verb is the
owner's: an agent bearer never runs one. The install/update dialog says it as
its own strong permission («a new kernel-verb: … — lets Silos …»). Each name
brings two words for its door from the catalog: the door's («Stop») and the one
shown while the kernel works («Stopping…», 21-11) — the page shows it from the
click until the answer and the re-read records, never a mute door.

| Name | Kind | Guard | Door | What it does |
|---|---|---|---|---|
| `stop-process` | `process` | `stoppable` | Stop · Stopping… | re-reads the live process table; the root must still be the same process (pid AND start — a reused pid is a stranger, never signalled); gathers the tree as it is NOW (root and descendants, as a scan folds it; no engines, no other roots); SIGTERM to all, a short grace (up to ~5 s, awaited without blocking and ended as soon as the whole tree is gone — liveness re-read every ~100 ms), SIGKILL to the survivors (each re-verified by its start); the record is `exited` at once with `stoppedAt`, `stoppedBy: owner` and `why` «stopped by you». Answers: stopped N · was already gone · K did not exit. Never this server's tree (`origin: silos`), never another user's process (`origin: other-user`) |
| `remove-worktree` | `worktree` | `removable` | Remove · Removing… | re-reads the live facts: still a linked worktree of a project Silos knows (never the main checkout), not locked, nothing of it missing from the default branch (`ahead − landed = 0`), no tracked change, no process inside (the process table read afresh), its conversation not running — any of them moved ⇒ refused in words, nothing touched. Then: a `git bundle` of the branch into Silos' trash when it landed only by patch; every file git does not track (untracked AND ignored — a gitignored plan or `.env` is data too) MOVED into the same trash folder (`trash/worktrees/<moment>-<name>/`, emptied by the trash's own 30-day purge); `git worktree remove` (never `--force`); the branch deleted — `-d` when it is an ancestor of the default branch, `-D` only after its bundle. Never the stash. The record is `removed` with `removedAt`, `removedBy` and `why`. The SAME path is the one Silos takes by itself (below, `worktree`) |

## Field types

| Type | Shape | Notes |
|---|---|---|
| `string` | string | `empty`, `oneOf`, `max` |
| `number` | a finite JSON number | e.g. a usage window's `percent`: comparable with numeric literals; never summable (`sum` is `money` only); the cell says it as is — unless it declares `unit` (21-11): then it says it with the unit and at most one decimal («41.5 %», «1,240 MB»); right-aligned |
| `email` | a normalizable string (`trim-lowercase`) | future basis of the `party` role (annex) |
| `url` | string | |
| `timestamp` | ISO; `granularity: day` accepted | the envelope's `at` |
| `money` | `{amount: number, currency}` **already normalized** | parsing localized strings («71,00») is the PRODUCER's job; aggregatable with `sum`, currencies never mixed |
| `boolean` | bool | |
| `actor` | an agent id or a human name | soft resolution: if it matches an agent id, it anchors; otherwise it is a person. Enables `is human` |
| `path` | a path relative to the project | |
| `attachment` | a path to a document | confined like the globs; opens in the existing viewer |
| `refs(<sub-kind>)` | sibling ids | `withinParent: true`; enables `all(refs, …)` / `any(refs, …)` |
| `object` | a JSON object | preserved as is and read only by a role (the wait `{owner, action, asked?, options?}` of the `task` role); never a column, never compared |

**A field's presentation** (21-11, voice only): `label` — the words the column
header and the record page use for it («memory», «started»; a view's `at` is
said with the label of the field the envelope maps it to); `unit` — only on a
`number`: the unit of its cell. A `unit` on any other type does not validate.
Neither changes what is compared, filtered or aggregated.

## Envelope roles

**`due`** — the record's future; it feeds predicates (`due < now + 7d`) and the
Horizon strip (annex). Optional `word`: the word the row uses for that future when
it is not a due date — «resets» for a usage window («… · resets Nov 1, 05:00
UTC»); absent = «due». Voice only. `party` stays in the annex (claiming it from
names instead of normalized addresses would fabricate false joins).

**`task`** — a kind or sub-kind declares `roles.task: {owner, dependsOn,
waitingOn?, nextCheckAt?, conversations?}`: which fields are the owner, the
dependencies, the wait `{owner, action, asked?, options?}`, the next check and
the conversations.

- The wait is read from the raw object: `owner` (who), `action` (what is needed),
  `asked` (a string: the question in words — the Needs you row says it as its main
  text, «Finance asks: …») and `options` (a list of 1 to 4 strings of up to 40
  characters when the answer is a choice). An `asked` or `options` outside that
  shape is ignored and never invalidates the record; they are not fields of the
  task and do not enter the field dictionary.
- The kernel then computes, **on request** (never written, like `since()`), five
  names readable in predicates: `waiting` (waits on someone, or a `nextCheckAt`
  still to come), `gate` (an open task of an agent depends directly on this one),
  `stalled`, `stalledCause` and `stalledBy`.
- The stall rule: every open task has a KEPT next step — a live conversation, a
  wake on its way, a human owner with nothing open below (a person's task on
  open dependencies is walked like any other), a healthy chain of blockers, a
  wait with an owner, or a next check. The ten causes: `unowned`,
  `blocked-on-nothing`, `blocker-missing`, `blocker-cycle`, `blocker-parked`,
  `blocker-cancelled`, `owner-cannot-run`, `review-without-reviewer`,
  `in-progress-nothing-live`, `owner-outside-project` (its owner is an agent
  that does not work in the task's project — nobody moves it until the owner
  gives it to an agent of that project); `stalledBy` names the FIRST stalled task of the
  chain, not the one at the top. A dependency on a task the plan's file holds
  but cannot be read is no stall (the reader says it).
- The values of `stalledCause` are computed by the kernel, never declared by a
  manifest: they are not catalog entries and may change within v0 (no
  reference manifest names one) without a new `apiVersion`.
- Live facts are injected: `isLive(session)` and `wakes(agent)` (now · beat ·
  never); without them nothing is live and nobody wakes.
- It reads the states by their standard names (pending, in_progress, in_review,
  blocked, done, cancelled); only `done` resolves a dependency.
- The walk has no depth cap and is linear (each task looked at once); a cycle is
  its own cause (`blocker-cycle`), never a silence.
- **The owner's note that reopens** (Silos semantics of `roles.task`, spec
  2026-11-21 D17): an `append-item` by the owner into the task's notes — the
  appendOnly sub-kind of the task the owner may append to whose words are a
  `text` (the kernel's `noteOf`) — on a task whose `owner` is an agent in play,
  that is closed (`done`, `cancelled`) or `blocked` with nothing holding it but
  Silos' own `unstick …` wait, reopens it IN THE SAME WRITE: the `unstick` wait
  goes, and the state becomes `blocked` while a dependency not done, a wait or a
  next check ahead still holds it, else `pending`. Only when the manifest lets
  the owner set the state field. Never a person's task, an archived agent's or
  nobody's; never a note starting `Dropped:` nor one an owner's verb that closes
  writes. The same write is never swallowed by the two-minute dedupe of
  append-item. A manifest declares nothing for it.

## Nested sub-kinds

A sub-kind MAY declare its own — the `notes[]` and `conversations[]` of a task —
**two levels at most** (record → child → grandchild; a third does not validate).
They are read, lifted (`lift`), evaluated, journaled and accept `append-item` just
like direct children; a grandchild's key is
`<record>/<collection>/<child>/<collection>/<id>` (`folder:/w/plan/tasks/t4/notes/0`).
An unreadable grandchild does not bring its child down: the record names it in its
remarks.

## Kernel kinds — `kernel-kinds/v0`

What a `kernel` source can present: data the kernel ALREADY has, without reading
anyone's files (`source: {type: kernel, root: kernel, kind: <kind>}`). Each later
built-in feature that moves onto the standard extends it with its reference
manifest. Rules:

- **Versioned like the slots**: entries (kinds, fields, states) are **only
  added**; renaming or retiring one is a major version of the standard. The
  catalog's version travels with `apiVersion` (`silo-standard/v0` ⇒
  `kernel-kinds/v0`).
- **Unprefixed, reserved names**: `process` belongs to the kernel; a silo's kinds are
  always qualified (`<silo>/process` is the PRESENTATION a silo declares over the
  kernel kind `process`).
- **The kernel writes, the silo presents**: the manifest declares the states'
  labels, identity, views and slots; the states, fields, types and envelope are
  the catalog's (the validator requires it, `conformance.md` §5). Over kernel data
  a v0 silo may only `open`, `ack` and declare the `kernel-verb`s the kind admits
  (`verbs` in its entry; a closed catalog, above) — the mutations are the
  kernel's, never the silo's.
- **Producer `kernel`**: `producer.role: kernel` — no agent to bind, no
  instructions to inject, no sync. A reserved value: only a kernel source carries
  it. The exception is declared by the kind: `binds: producers` (`task-wake`,
  below) — the kernel writes ABOUT bound agents, and the silo names their role.
- **The `platform` anchor**: platform data — the record belongs to no agent,
  folder or conversation. It is the DECLARED absence of a hub: it has no hub page,
  its Needs you row has no agent, and the project page does not list it; only a
  kernel source sustains it.
- **Derived convention `kernel:<kind>`**: the transition journal of kernel data
  lives in `conventions/kernel%3A<kind>/` — a space no `files` source can derive
  (their roots are agent-state and project), so it needs no list of reserved
  names.
- **The dialog's words**: a kernel source has no paths to list; the catalog says
  what each kind reads in plain words, and the install dialog quotes it as is.
- **Several kernel kinds, one silo** (21-11, System 0.3.0): one kernel source
  feeds the silo's one kind, whatever its name (`task-wake` is presented as
  `wake`); a silo with SEVERAL kernel sources — the same question asked of two
  kinds (System: processes and worktrees, «what conversations left on this
  machine») — names each of its kinds like the kernel kind it presents, and
  that name is the link (no other field). Every kind fed by exactly one
  source, otherwise the manifest is refused in words. A kind written about
  bound agents (`binds: producers`) still stands alone. Files and kernel data
  never feed one silo.

### `task-wake` — a wake of task mode

One record each time an event of a plan task calls its owner bound to task mode —
its blockers done, its subtasks done, an owner's note, its `nextCheckAt` due. It
waits (`queued`) while the owner's conversation is in a turn or held by a console;
it arrives (`delivered`) when the turn starts; it is superseded (`superseded`)
when the task moved on before it arrived. Reads: *its wakes: each time Silos woke
an agent on a task, and why*.

**`binds: producers`**: the kernel writes these records ABOUT the agents the
operator binds to the producer role of the silo that presents them. That silo
names an agent role (never `kernel` or `any-agent`), MAY carry
`producer.instructions` — the protocol those agents receive at start, through the
same channel as any producer — and never `sync`; its brief names no record paths:
the bound agents write nothing in it. A kind without `binds` follows the rule
above (producer `kernel`, nobody to bind).

| State | Terminal | When |
|---|---|---|
| `queued` | no | fired; waits for the turn (in progress, console open, no-progress brake, daily cap) |
| `delivered` | **yes** | its turn started in the task's conversation |
| `superseded` | **yes** | the task closed, changed owner, or the agent left the mode before it arrived |

| Field | Type | Notes |
|---|---|---|
| `id` | string | **envelope `id`**: `<agent>~<plan>~<task>~<reason>~<n>` |
| `state` | state | **envelope `state`** |
| `at` | timestamp | **envelope `at`**: when it fired |
| `updatedBy` | actor | **envelope `updatedBy`**: always `kernel` |
| `agent` | string | the bound agent it wakes |
| `task` | string | the task's record key in the plans silo |
| `ref` | string | `plan#task`, as it is said |
| `title` | string | the task's title when it fired |
| `reason` | string | `unblocked` · `children-done` · `owner-note` · `next-check` |
| `says` | string | the reason in plain words |
| `deliveredAt` | timestamp, optional | when its turn started |
| `session` | string, optional | the conversation it reached |
| `held` | string, optional | why it waits, in plain words |

### `execution` — an SDD execution, hung from its task

One record per SDD ledger (`.superpowers/sdd/<plan>/progress.md`, the one the
subagent-driven-development skill writes) that the kernel already reads — the copy
a conversation's ledger left in `<dataDir>/executions/<folder>/<session>.json`
(it survives the worktree) or a LIVE ledger in the checkouts of a managed folder
that no copy names (ledgers with no conversation that name the same document are
one execution: the most recent one speaks and names the others in
`otherLedgers`/`otherLedgersSay`). It runs (`running`) and fixes (`fixing`: a task
in a fix round) while something runs it; it stops (`stopped`: unfinished and
nothing runs it) and finishes (`done`: every counted task complete,
`done ≥ total > 0`). Reads: *the SDD ledgers your agents' conversations wrote —
read-only*.

**Parent `task`** (annex, «`task` anchor»): the kernel resolves the plan task it
hangs from and writes it in `task` — the task whose `conversations[]` holds the
session that wrote the ledger, otherwise the task whose `source` names the same
document (same main checkout, same path inside). Nothing more: no titles, no
guessing. A manifest over this kind MAY declare the anchor `{hub: task, from:
parent}`; over any other kind the validator refuses it. An execution with no task
is listed all the same.

| State | Terminal | When |
|---|---|---|
| `running` | no | tasks remain incomplete and something runs it: its conversation works, or the ledger was written within the live window |
| `fixing` | no | in addition, a task is in a fix round (`Task N: fix round R`) |
| `stopped` | no | tasks remain incomplete and nothing runs it |
| `done` | **yes** | every counted task is complete (`done ≥ total > 0`) |

| Field | Type | Notes |
|---|---|---|
| `id` | string | **envelope `id`**: `<folder>~<session>` (a conversation's copy) or `ledger~<ledger path, every non-alphanumeric → ->` (a live ledger with no known conversation) |
| `state` | state | **envelope `state`** |
| `updatedAt` | timestamp | **envelope `at`**: the ledger's last write |
| `updatedBy` | actor | **envelope `updatedBy`**: always `kernel` |
| `title` | string | the document's title (its first `# `), else the ledger's, else its folder's name |
| `done` | number | complete tasks (the ones the document names, when there is a document) |
| `total` | number | the document's tasks; with no document, the ones the ledger names |
| `totalFrom` | string | `document` · `ledger` — where `total` comes from |
| `gone` | boolean | the ledger no longer exists (worktree removed): the kernel's copy speaks |
| `ledger` | string | the ledger's path |
| `session` | string, optional | the conversation that wrote it |
| `folder` | string, optional | that conversation's folder, as the index names it |
| `agent` | string, optional | that conversation's agent |
| `project` | string, optional | the main checkout where the document lives |
| `doc` | string, optional | the document, inside its main checkout |
| `fixingTask` | number, optional | the first task in a fix round (while not `done`) |
| `round` | number, optional | its round |
| `task` | string, optional | **parent**: its task's record key in the plans silo |
| `taskRef` | string, optional | that task as it is said: `plan#task` |
| `edge` | string, optional | `conversation` · `document` — which edge hung it |
| `otherLedgers` | number, optional | ledgers with no conversation of the same document folded into this one |
| `otherLedgersSay` | string, optional | those ledgers and how far each got |

### `process` — a process a conversation left on the machine

(`reference/system.silo.json`, the recommended System silo; engine
`server/src/silos/processes.ts`, process table `proc-table.ts`.) A process is an
**indicator**, not a case — a test worker that lives 2 s is nothing to look at.
The case is a **process tree root** that either
carries a conversation's session id in its environment and has been seen alive
across scans for at least 60 s, or listens on a TCP port (recorded at once,
whether or not it comes from a conversation; one owned by another user, whose
process cannot be read, is a record that says so plainly: its port and no
command). Reads: *the processes your conversations started on this machine
and the ports they listen on*.

- **Attribution**: every process a conversation starts inherits its session id
  in the environment and keeps it when orphaned (reparented to init) — Silos'
  `SILOS_SESSION_ID` and the variables each engine declares it sets itself
  (`Harness.traits.sessionEnvKeys`; neutral code names no engine). No other
  name is read from the environment.
- **The engine is not a record**: the engine's process (the binary of a
  registered harness) IS the conversation; it is neither a record nor folded
  into one. A live engine above the root, or one carrying its session, says the
  conversation is running.
- **Roots**: among the processes with a session (engines excluded), a root is
  one whose parent carries no session; a shell wrapper (`sh -c …`) that only
  waits on one child yields the root to that child, repeatedly. Descendants
  fold into the root (`processes`, cpu and memory summed, ports unioned); a
  listener inside a conversation's tree belongs to that conversation.
- **Command redacted** before it is stored or served: the value after every
  flag or assignment whose name says token/secret/password/passwd/key/auth/credential
  (`--flag v`, `--flag=v`, `KEY=v`, also inside an `sh -c` script), a URL's
  userinfo and every long opaque blob → `[redacted]`; ≤ 200 characters; a
  script that prepares the shell and does `eval '<cmd>'` is said by `<cmd>`.
- **Stopping is the kernel's**: over this kind a v0 silo `open`s/`ack`s and
  declares the `kernel-verb` `stop-process` (21-11, an owner gesture — see
  «Kernel-verbs»). Its guard `stoppable` is written by the kernel on every
  record: `running` or `left`, readable (with pid and start), owned by this
  server's user, and not Silos' own tree. A stopped record says `stoppedAt`,
  `stoppedBy` and `why` «stopped by you».
- **Quiet end** (`quiet`, the only new thing in the catalog — PROPOSAL 21-11,
  pending the owner): `exited` is terminal but is not work done — Done today
  and the digest never list it (without this, every build or server that ends
  would be «done today — npm run dev exited» beside the pulse). The journal and
  the record's story count it all the same. The only other quiet end is
  `worktree`'s `removed` (below).

| State | Terminal | When |
|---|---|---|
| `running` | no | its conversation runs now (a turn, a live console of its thread, a live holder, a live engine in the table), or it belongs to no conversation |
| `left` | no | alive, and nothing of its conversation runs any more (closed, asleep or deleted) — label «left running» |
| `exited` | **yes** | a complete scan no longer finds that pid with that start; kept 24 h, then pruned; quiet end: never in Done today |

| Field | Type | Notes |
|---|---|---|
| `id` | string | **envelope `id`**: `<pid>-<start in ticks>` (a reused pid is another record); an unreadable listener: `port-<port>-<uid>` |
| `state` | state | **envelope `state`** |
| `startedAt` | timestamp | **envelope `at`**: when it started (an unreadable listener: when Silos first saw it) |
| `updatedBy` | actor | **envelope `updatedBy`**: always `kernel` |
| `command` | string | its command line, REDACTED |
| `origin` | string | `conversation` · `silos` (this server's tree — even if a conversation's shell started it: Silos is never something «left») · `machine` (this user's, outside any conversation) · `other-user` (another user's listener: its process cannot be read; 21-11, formerly `machine`) |
| `pid` | number, optional | absent on a listener whose process cannot be read |
| `cpu` | number, optional | % of one core, averaged over the last two scans (absent with a single scan or once `exited`) |
| `memoryMb` | number, optional | resident memory of the tree |
| `processes` | number, optional | processes folded into the record: the root and its descendants |
| `ports` | string, optional | the TCP ports the tree listens on: `4391, 5193` |
| `cwd` | string, optional | the root's working directory |
| `session` | string, optional | the conversation it comes from (its current session: the thread's tip after a `/clear`) |
| `folder` | string, optional | that conversation's folder, as the index names it |
| `agent` | string, optional | that conversation's agent |
| `conversation` | string, optional | its title as Silos shows it, or literally «a deleted conversation (4c440473)» — never an invented title |
| `why` | string, optional | in plain words — `left`: «its conversation was deleted» · «its conversation is not running»; `exited` by an owner's stop: «stopped by you» |
| `exitedAt` | timestamp, optional | when a scan found it gone (or the stop saw it go) |
| `stoppable` | boolean, optional | the guard of `stop-process`, written by the kernel on every record (derived from facts: it moves only with them) |
| `stoppedAt` | timestamp, optional | when the owner stopped it |
| `stoppedBy` | string, optional | who stopped it: `owner` |

The indicators (`cpu`, `memoryMb`, `processes`) move on every scan (every
30 s) and never count as a change: no journal, no notice to the kernel, no
record write — only a fact (record, state, ports, conversation) is one. What
is SERVED is at most one scan old: a read of the records asked for after a scan
reads the silo again once (no journal line — the indicators are not facts —,
at most one read per scan however often the page asks). `cpu` needs two scans:
before that it is absent, never 0.

### `worktree` — a git worktree a conversation left on the machine

(`reference/system.silo.json`, the recommended System silo's second view; engine
`server/src/silos/worktrees.ts`.) Three things create worktrees — an engine's
subagent isolation, conversations that follow a «feature = worktree + branch»
workflow, people by hand — and nothing closed them: on the machine that asked
for this kind, 45 had piled up. The case is one **linked worktree** of a
project folder Silos knows (the main checkouts of the agents' territories)
that is a git main checkout — `git worktree list`; the main checkout is never
a record, nor a prunable entry. Reads: *the git worktrees of your projects,
what of each is not in its default branch, and the conversation that made it*.

- **Measured against the default branch**: `origin/HEAD`'s branch when the
  repo has it locally, else the main checkout's branch, else `main`/`master`.
  `ahead` counts its commits (merges aside — a merge brings nothing of its
  own) not reachable from it; `landed`, those patch-equivalent to a commit of
  it (`git cherry`): a branch whose commits were cherry-picked is NOT unmerged
  work.
- **Attribution**: the sessions the engines place in it
  (`HarnessReader.worktreeSessions` — a transcript the engine moved there when
  its conversation entered the worktree; a child session spawned into it,
  counted for the session that spawned it), and conversations whose working
  directory is inside; else a process inside that carries a session id; else
  none («No conversation»). Liveness is the ONE rule the `process` kind reads
  (a turn, a live console of its thread, a live holder).
- **Processes inside**: read from the table the `process` kind already scans
  (`ProcessRecords.inside`) — `/proc` is never scanned twice; a removal reads
  it afresh at the gesture.
- **Silos closes the merged ones**: on its tick (every 60 s), a worktree that
  is `merged`, `removable`, and idle for **6 h** (`WORKTREE_IDLE_CLOSE_MS`) —
  from the latest of its last commit, the birth of its `.git` file and the
  last time Silos saw it in use or changing (HEAD or `git status` moved; kept
  in the kind's own store) — is removed by the SAME path as `remove-worktree`,
  `removedBy: silos`, `why` «removed by Silos — merged and idle for 6 h». An
  `unmerged` worktree is NEVER removed by Silos, whatever its age. Always on
  (the System silo has no owner setting of its own); `SILOS_NO_WORKTREE_SCAN=1`
  turns the whole scan off (isolated test servers).
- **Quiet end**: `removed` is terminal and quiet, like `exited` — never Done today.

| State | Terminal | When |
|---|---|---|
| `in-use` | no | a live process works inside it, or its conversation runs — wins over the other two; label «in use» |
| `merged` | no | nothing of it is missing from the default branch (`ahead − landed = 0`) and no tracked file changed |
| `unmerged` | no | it holds commits or tracked changes the default branch does not have (or its default branch can't be told) |
| `removed` | **yes** | removed — by the owner, by Silos, or found gone (`git worktree list` no longer names it: removed outside Silos); kept 24 h, then pruned; quiet end |

| Field | Type | Notes |
|---|---|---|
| `id` | string | **envelope `id`**: `wt-<hash of its real path and the birth of its .git file>` (a worktree re-created at the same path is another record) |
| `state` | state | **envelope `state`** |
| `lastCommitAt` | timestamp | **envelope `at`**: its HEAD's commit time |
| `updatedBy` | actor | **envelope `updatedBy`**: always `kernel` |
| `path` | string | its folder, relative to its project when inside it (`.claude/worktrees/x`), else absolute |
| `dir` | string | the same, absolute (its real path) |
| `project` | string | the main checkout it belongs to — also the `project` facet |
| `branch` | string, optional | its branch (absent: a detached HEAD) |
| `base` | string, optional | the default branch it is measured against |
| `ahead` | number | its commits, merges aside, not reachable from the default branch |
| `landed` | number | of those, the ones patch-equivalent to a commit of the default branch |
| `changes` | number | tracked files modified or staged |
| `leftovers` | number | untracked entries (`git status ??`) — they go to the trash on removal (ignored files too, uncounted) |
| `processes` | number | live processes whose working directory is inside it |
| `session` | string, optional | the conversation that made or works it (its current session) |
| `folder` | string, optional | that conversation's folder, as the index names it |
| `agent` | string, optional | that conversation's agent |
| `conversation` | string, optional | its title as Silos shows it, or literally «a deleted conversation (4c440473)» |
| `why` | string, optional | the state (and the guard) in plain words: «its 3 commits landed in main by patch (cherry-picked)» · «2 commits not in main, 1 tracked file changed» · «removed by you» |
| `removable` | boolean, optional | the guard of `remove-worktree`, written by the kernel on every record: `merged`, not locked, the machine's processes readable |
| `removedAt` | timestamp, optional | when it was removed (or found gone) |
| `removedBy` | string, optional | `owner` · `silos`; absent: removed outside Silos |
| `trash` | string, optional | the trash folder its leftovers and its branch's bundle went to |

## Urgencies

- `blocking` — NEVER folds; requires a dispatchable condition; a whole kind that is
  unconditionally blocking does not validate; raising urgency is an operator
  gesture.
- `due` — carries a date or predicate; the per-silo budget folds it.
- `routine` — arrives folded per silo when it piles up.

(`audience: owner | producer-agent` — in the schema; granted by the operator.)

## Schema field classes (evolution)

Every `spec` field in v0 is **additive**: a kernel that does not understand it
loads what it understands and lists the rest as `wants`. The **restrictive** class
(unknown ⇒ the install is REFUSED with a reason — must-understand) exists in the
standard and is empty in v0; its first planned member is `sensitive` (annex).
