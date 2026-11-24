# Silo Standard v0

**Status:** v0, frozen vocabulary — entries are only added (see [Versioning](#versioning)).
**Parts:** this document (the standard) · [`silo.schema.json`](silo.schema.json)
(the manifest schema) · [`catalogs.md`](catalogs.md) (slots, archetypes, actions,
field types, kernel kinds) · [`expressions.md`](expressions.md) (the predicate and
aggregator language) · [`conformance.md`](conformance.md) (what the validator
checks and what the conformance suite proves) · [`proposed-extensions.md`](proposed-extensions.md)
(designed pieces not yet in the schema) · [`reference/*.silo.json`](reference/)
(reference manifests) · [`authoring.md`](authoring.md) (a guide for authors).

The key words MUST, MUST NOT, SHOULD and MAY are used in their usual sense.

## Terminology

- **Kernel** — the host program that implements this standard: it reads records,
  validates manifests, evaluates expressions, renders surfaces and performs
  actions. In the Silos console the kernel is the Silos server.
- **Agent** — a coding agent the kernel runs (for example a Claude Code or OpenCode
  session) with an identity, its own state folder and, optionally, a **bearer**
  token that identifies it to the kernel's API.
- **Owner** — the human who runs the kernel. Only the owner approves silos and
  performs owner actions.
- **Operator** — the owner acting on placement and switches: which slots are on,
  which agents produce for a silo, the order of terms.
- **Producer** — the role in a silo that writes its records; the operator binds it
  to one or more agents.
- **Engine** — the agent runtime (Claude Code, OpenCode…). Producer instructions
  are delivered through each engine's own start-of-session channel.
- **Hub** — an entity records anchor to: an agent, a project folder, a
  conversation (an agent session), and, for a few kernel kinds, a task.
- **Surfaces** named in this standard are the kernel's places: **Home** (the
  landing page, with a one-sentence **pulse** and a **Done today** list), **Needs
  you** (the owner's inbox), the **rail** (global navigation), an agent's page, a
  project's page, **⌘K** (global search) and the per-record **record** page.

## What a silo is

**A silo is an installable way of working**: a package the owner installs and
binds to agents, carrying a protocol for the agents that work it, the records
they write, and the views and actions the kernel offers on those records. A silo
need not use all three — a protocol with records the kernel keeps is a *mode*,
relations alone are a *view*, records with their producer are a *function* or a
line of the operator's business.

Mechanically: **a silo is a convention of records that agents write to disk, plus
a manifest that tells the kernel how to anchor them, show them and act on them.**

Everything else follows from that sentence:

- The data are the operator's files — not the kernel's and not the silo's.
- The boundary is *silos see, the kernel acts*: a manifest declares; it MUST NOT
  carry code or UI.
- The trust model fits in one line: what an agent can write is bounded by where it
  can write.

**Every silo you install multiplies with the ones you already have**: records of
different silos cross by their anchors (agent, folder, conversation, time) — in
⌘K and, once two silos co-anchor, in the hubs strip of each record page (annex). Installing a second silo improves the first.

A silo packages **two halves**:

1. the **producer instructions** — how an agent writes the records. They are
   delivered only to the declared producers, in every engine;
2. the **manifest** (`silo.json`) — how the kernel reads the records, anchors them,
   shows them and which actions it offers.

Besides its records, a silo MAY bring **a look** (`spec.theme`): declared colour
values for the kernel's own surfaces, light and dark. It is an optional extra a
silo declares, not a fourth part of what a silo is — values, never CSS, checked
for contrast by the kernel and offered, once approved, beside the built-in looks
(see «Looks» below). A silo whose only content is a look is valid.

That is why a silo is not only a data dimension: protocol, convention and views
travel in one package. What a silo never carries is an agent's identity (name,
folder, skills, secrets): the owner binds the silo's role to agents of their own.

## The decision ladder

1. **The standard** decides the *vocabulary*: which knobs exist (this document and
   its catalogs).
2. **The silo author** decides the *values*: which knobs the silo uses and how (the
   manifest).
3. **The operator** decides *placement and switches*: order, slots switched off,
   lenses, which agent produces.

Every question that can be pushed down the ladder is pushed down; that is what
keeps the standard small enough to fit in one agent skill.

## The record envelope

Every kind maps six core fields; everything else is the author's free schema.

| Field | What it is |
|---|---|
| `id` | stable identity (from the file name or from a field; when both exist they MUST match) |
| `identity` | the sentence that IS the thing in a row — a template with a declared fallback, never invented |
| `state` | the lifecycle state (a field, or computed from the children) |
| `at` | the record's moment (a field, inherited from the parent, or written-authoritative) |
| `anchors` | which hubs it belongs to — derived from the location, not configured |
| `updatedBy` | who touched it last (may be declared absent; never invented) |

From the envelope alone the kernel derives the pulse, ⌘K, Done today,
freshness and the `record` page. The first conformance test is the envelope: *does
every record produce a valid envelope and, if not, which field fails?* An
unreadable record does not disappear: it is shown with its reason, in plain words.

### Kinds and sub-kinds

A **kind** is a type of record a silo reads (`invoice`, `case`, `plan`). Kinds are
published qualified by the silo id (`invoices/invoice`).

A **sub-kind** is a set of child records inside the parent's file (the threads and
notes of a case, the tasks of a plan), each with its own envelope. Sub-kinds MAY
nest one more level (record → child → grandchild); a third level does not
validate (`catalogs.md`, «Nested sub-kinds»).

- A parent's aggregate fields are declared **computed** and derived on read —
  never materialized.
- Tolerances are declarative, not heroic: per-field **aliases**, **conditional
  aliases** (accepted only when the value has a declared form), and **`lift`** (a
  loose field is lifted into a synthesized child holding what the file says —
  empty, not invented).

### The `due` role

`roles.due` (optional) is the record's future — what falls due, renews or expires.
It feeds inbox predicates (`due < now + 7d`). Other envelope roles are in
`catalogs.md`, «Envelope roles».

### Kernel sources

A silo MAY read no one's files and instead declare presentation over data the
kernel already holds — a kind of the **kernel-kinds catalog** (`catalogs.md`,
«Kernel kinds», versioned like the slots; v0 publishes `task-wake`,
`execution`, `process` (the processes conversations leave on the machine) and
`worktree`).

- The kernel writes those records (producer `kernel`, no agent to bind — except a
  kind the catalog declares with `binds: producers`).
- The silo supplies labels, identity, views and slots, and over them only the
  actions `open`, `ack` and the `kernel-verb`s the kind admits (a closed
  catalog; v0: `stop-process` over `process`, `remove-worktree` over `worktree`, 21-11 — the kernel's mutations,
  an owner gesture).
- They are platform data: their anchor is `platform` — no agent, folder or
  conversation.
- A kernel kind MAY declare in the catalog a PARENT that the kernel resolves
  (`execution` hangs from a task of the plans silo); the manifest presents it with
  the anchor `{hub: task, from: parent}` (annex, «`task` anchor»).

## States and the voice contract

`states` is an ordered list with plain-word labels and at least one `terminal`.
Five decisions derive from it that no silo takes again:

1. what the pulse counts (the live, non-terminal states);
2. what enters Done today (the observed transition to a terminal state — except
   an end the kernel-kinds catalog declares `quiet`: a process that ends is no
   work done);
3. the columns of a board;
4. when folding considers a record inactive;
5. what inbox predicates exclude.

A raw value is never painted («2 invoices_v2» does not exist). A state MAY *read*
differently under a predicate (`labelOverrides`: a `done` whose note starts with
«Dropped:» reads «dropped»).

## The transition journal

Files hold the current state, not its changes — so the kernel keeps, by
convention, an append-only journal of every transition it **observes** (and of
disappearances: `removed`). Honest Done today, `since(state)` («in
waiting_customer for 5 days»), the history of each record and the catch-up
(«since Friday: 3 invoices paid») all come from it.

Honesty rules:

- the first observation is a baseline, never an event;
- «arrived closed» is not «was closed»;
- what is observed late is dated when it was seen, and says so.

## Sources, freshness and writing

### Sources

v0 has one file source: **`files`** — globs by convention inside a location class,
a declarative parser, confinement enforced by the validator.

- `agent-state`: under `silos/<id>/` of every agent's state folder.
- `project`: the project folders the kernel knows (a worktree resolves to its main
  checkout).

(A `kernel` source is described above; it reads no files.)

«Synced» is not a source: it is a producer that syncs from an outside service and
writes `files`, under a contract — idempotent, one record per file, money and
dates normalized, never over the owner's values. The kernel has no connectors.

### Producers

A manifest names one producer **role** (`spec.producer.role`), never an agent id.
The operator binds the role to one or more agents when approving; `any-agent`
means any agent with the skill named in `via`. The producer's instructions
(`summary`, `protocol`) are prose delivered only to bound producers. The role
`kernel` is reserved for kernel sources. The schema's `$defs/producer` gives the
full shape, including `sync`.

With several agents bound, **the producer of a record is the agent that wrote
it** (its `agent` anchor) while that agent is bound and in play: a routed row, a
task made from the record and a message about it go to that agent. A record no
bound agent wrote (a project record, a writer since unbound) falls to the first
bound agent in play. One silo therefore serves several projects by binding one
agent per project; nothing is declared per project.

### The convention is derived, never declared

The kernel computes a source's **convention** from its canonical root. Two silos
MAY read the same convention — your data are files; a silo is only a way to see
them — but only one is active with slots: the second is a declared gesture of
coexistence (`conformance.md` §4).

### Freshness

A source declares `expects {cadence, producer}`. When the last write is older than
the cadence, *every* slot of the silo says so («no new cases since Sat · the
check-inbox run last wrote Fri»).

### Writing

Every write re-reads, merges and replaces atomically with compare-and-swap (CAS).
Because CAS binds only the kernel, the fields the owner writes over a sync source
live in a reconciled **overlay**:

- it seals the base value it was written over;
- it is retired when the source reaches the owner's value;
- a contradiction surfaces in Needs you — nobody wins silently.

The sync producer reads the merged view through the API. That is a precondition
the validator enforces (`conformance.md` §8), not a courtesy.

## Views, surfaces and actions

- **Archetypes** are page shapes the kernel builds once and silos parametrize
  (`list`, `board`, `tree`; `record` is derived).
- **Slots** are placements a silo requests (grants) and the operator can switch
  off (`rail`, `pulse`, `needs-you`, `agent-section`, `project-machinery`,
  `lens`).
- **Derived surfaces** (the `record` page, ⌘K, the sidebar glyph) are
  not requested: nothing is hidden from them.
- **Actions** are declared invocations of kernel primitives — no code. A silo that
  needs more than the catalog is an engine, and engines belong to the kernel.

Full catalogs are in `catalogs.md`; the single grammar of predicates and
aggregators is in `expressions.md`.

## Relations

A silo MAY declare typed relations between existing hubs (`spec.relations[]`,
v0: agent → agent, cardinality one). The kernel stores the edges and the owner
writes them. A silo with relations MAY have no producer, sources or kinds (an
**edge-only silo**). Rules in `catalogs.md`, «Relations».

## Looks

A silo MAY declare a theme (`spec.theme` = `{name, light, dark}`): for each mode,
a value for every token of the closed vocabulary in `catalogs.md`, «Theme
tokens», in the standard's own words (`background`, `panel`, `text`, `text-2`,
`text-3`, `border`, `accent`, `on-accent`; `accent-soft` optional, derived from
`accent` when absent). Values are `#rrggbb` only: no alpha, no names, no
functions — that is what keeps a manifest from carrying CSS. A theme never sets
fonts, layout, status colours or the terminal's palette; the kernel derives what
the vocabulary does not name (its shimmer, the dark console frame, the selection).

- **Contrast is checked at validation** (conformance §12): a pair of the rule
  under its minimum, in either mode, rejects the manifest — the error names the
  mode, the pair, the measured ratio and the minimum.
- **Approval makes it available, nothing more**: the dialog says the silo brings a
  look, by name, and shows its colours; an update says when the look changes,
  appears or goes. No one's screen changes at approval.
- **Choosing it is the viewer's, per browser**, among the built-in looks. When the
  silo is turned off or uninstalled, or its theme disappears, a browser that had
  chosen it falls back to the default.

A silo with a theme MAY have no producer, sources or kinds (a silo that brings
**only a look**); one that does declare records keeps every rule for them.

## Security: derived, not configured

Everything else is computed from *where the records live*: who writes (the
producer, in its territory), who reads (the owner through the API; an agent's
bearer only what its location already lets it read on disk), what the fence
denies to the other agents, and what the records anchor to. Agents cannot
misconfigure what they do not configure.

**The limit, said aloud:** the chain unconditionally guarantees the behaviour **of
the API** (masking, authorization, approvals). Enforcement **at file level** is
the kernel's territory fence: opt-in per agent and without bash rules in any
engine — a local agent in bypass mode can `cat` whatever the file system lets it.
The hard boundary (containers, Unix users) is separate work, and this standard
does not promise it.

**The trust model as a whole:** with a local, bearer-less identity treated as the
owner, the install gate and the events guarantee **legibility** — nothing appears
without a trace or without passing through `pending` — not a wall against a
hostile local process. The adversary this design does protect you from is the
agent that is confused, or injected by the content it reads.

## Install, approve, update, uninstall

**Submit.** An agent submits a manifest through the API. **Every third-party
submission lands `pending`.** An invalid manifest creates nothing and answers with
the validator's errors (`conformance.md`).

**Approve.** The only activation is the owner's click, in front of **rendered
derived consequences**: the exact paths it will read, and the slots painted with
real records (a dry-run under the viewer's authorization) or with the mandatory
`examples`. The author's prose is shown as a quote, never as authority.

**Draft.** The author iterates in a `draft` state (a file in the author's own
agent state) against the text preview — the exact words the kernel will say —
without disturbing anyone.

**Update.** A new version goes through the same door. The examples of the
installed version MUST still read with the new manifest or declare aliases, and
the diff lists every loosening of fence or authorization on its own line
(`conformance.md` §9).

**Uninstall does not destroy.** It removes views, slots, instructions and the
derived fence — never a record, the owner's overlay or the journal (they are
pinned to the convention, not to the silo). The dialog lists the producers still
alive, and records that keep growing with no silo to show them are a term on
Home, not a line buried in settings. *Your data are files in your folders; a silo
is only a way to see them.*

## Versioning

Three versions with three owners:

- the standard's (`apiVersion`);
- the silo's (`metadata.version`);
- the records' (field-map aliases — records outlive manifests and are never
  migrated).

Catalogs only add; renaming or retiring an entry is a major version of the
standard. Schema fields fall into two classes:

- **additive** — unknown ⇒ loaded without it and listed in `wants`;
- **restrictive** — unknown ⇒ the install is refused (an old kernel does not
  approve a restriction it cannot derive). The restrictive class starts empty;
  `sensitive` will be its first member (annex).

**Additions within v0.** New verbs within v0 follow one path: they enter the
schema's enum and `catalogs.md` with fixed semantics, with no new signature
(`ensure-record` was the first). `claim` and `release`, with their properties
`link` and `set`, the value `task-owner` of `by` and the role
`roles.task.releases`, are **additive**: a kernel that does not know them lists
them as `wants` (the properties) or refuses the manifest with an error in words
(the enum value) — it never applies them halfway. Equally **additive**: the
`dispose` property of `release` (the state disposition on release, in the same
write as the mark), the `undated` property of `rotate` and the language operand
`monthStart`. The semantics of `roles.task.waitingOn` grows from `{owner, action}`
to `{owner, action, asked?, options?}` without touching the field dictionary: the
kernel reads those keys from the raw object, and an invalid shape is ignored — it
never invalidates a record.

## Conformance

This standard is not asserted; it is measured.

- The validator's checks, in order, and the conformance suite are in
  [`conformance.md`](conformance.md).
- The reference manifests in `reference/` are written against real record shapes;
  every piece of the host that moves onto the standard publishes its manifest
  there, so «the host is made of silos» is verifiable.
- The correctness metric is public: a new silo = a manifest + instructions, zero
  lines of kernel code.

## In other words

- **For operators**: Notion-like views whose data your agents write.
- **For engineers**: Kubernetes CRDs for your agent fleet — the author's spec, the
  kernel's status, must-understand fields, a conformance suite.
