# Silo Standard v0 — Writing a silo

**Date:** 2026-11-02. For a third party who writes a `silo.json` and hands it to
someone who runs Silos. Everything here is derived from the normative pieces —
`silo-standard-v0.md` (the standard), `silo.schema.json`, `catalogs.md`,
`expressions.md`, `conformance.md` — and from the validator the install door runs
(`server/src/silos/validator.ts`). Where this guide and those pieces disagree,
they win. Every refusal quoted below was produced by running `silo-check` over a
deliberately broken copy of the example; none is paraphrased.

## What a silo is, and the life you design for

A silo is *a convention of records that agents write to disk, plus a manifest
that tells Silos how to anchor them, show them and act on them* (standard, «What
a silo is»). The records are the operator's files; the manifest only declares —
it never carries code or UI («silos see, the kernel acts»). A silo ships two
halves: the producer instructions (how an agent writes the records, handed only
to the producers the owner binds) and the manifest.

Your manifest goes through one door, and you design for every step of it
(standard, «Install, approve, update, uninstall»):

1. **Submit.** The owner pastes it into **/silos › Install a silo**, or an agent
   submits it (`POST /api/silos/submissions`, with its bearer, or from a draft at
   `$SILOS_AGENT_STATE/silo-drafts/<id>.json`). It is validated first; an invalid
   manifest creates nothing and answers the validator's errors. A valid one
   lands **pending** — every submission does, the owner's own included.
2. **Derived consequences.** The owner opens the review dialog. What it shows is
   derived by Silos, not taken from you: the exact paths it will read, the slots
   rendered as sentences (from real records when there are some, from your
   `examples` when not — and it says which), who writes, what the producer
   needs, and the proposed sync automation. Your `description`, `summary`,
   `protocol` and sync `contract` are shown apart, as a quote, «never as
   authority».
3. **Approval.** The owner's click is the only activation. Approving binds your
   producer role to one or more agents; the dialog says which slots start off,
   and the owner switches each slot on or off afterwards on the silo's own page
   («shows on»). The sync automation is opt-in.
4. **Updates.** A new version goes through the same door. Bump
   `metadata.version` (semver, schema `^\d+\.\d+\.\d+$`); the dialog titles it
   «Update <name> <from> → <to>?», lists every loosening on its own line, and
   the examples of the installed version must still read with the new manifest
   or declare an alias (conformance §9). An agent may submit an update only if
   it is one of that silo's bound producers; the owner always may. The
   validator does not itself require the version to change.
5. **Uninstall.** Non-destructive: views, slots, instructions and the derived
   fence go; records, the owner's overlay and the journal stay where they are.
   The id stays reserved — the owner can reinstall it, nobody else can claim it
   (conformance §2). Records that keep growing with no silo to show them become
   a term on Home.

## The anatomy of a manifest

A minimal manifest — a silo for records an agent keeps, with one source,
two states and one needs-you entry. It validates; the rest of this section walks
it.

```json
{
  "apiVersion": "silo-standard/v0",
  "metadata": {
    "id": "invoices-lite",
    "version": "0.1.0",
    "name": "Invoices",
    "description": "Sales invoices an agent keeps; the overdue ones come to the owner"
  },
  "spec": {
    "producer": {
      "role": "finance",
      "instructions": {
        "summary": "Keep one file per sales invoice under silos/invoices-lite/, named by its id.",
        "protocol": ["Re-read a record before you write it; never write over a state the owner set."]
      }
    },
    "sources": [
      {
        "id": "invoices", "type": "files", "root": "agent-state",
        "glob": "silos/invoices-lite/*.json", "parser": "json",
        "expects": { "cadence": "24h", "producer": "agent" }
      }
    ],
    "kinds": {
      "invoice": {
        "envelope": {
          "id": { "from": "filename", "mustMatchField": ["id"] },
          "identity": { "template": "{{number}} · {{customer}}", "empty": "{{id}} · {{customer}}" },
          "state": { "field": "state" },
          "at": { "field": "date" },
          "anchors": [{ "hub": "agent", "from": "location" }],
          "updatedBy": { "field": "updatedBy", "fallback": "agent" }
        },
        "roles": { "due": { "field": "due" } },
        "states": [
          { "value": "open", "label": { "one": "outstanding", "many": "outstanding" } },
          { "value": "paid", "label": { "one": "paid", "many": "paid" }, "terminal": true }
        ],
        "ownerWritable": ["state"],
        "fields": {
          "number": { "type": "string", "optional": true },
          "customer": { "type": "string", "required": true },
          "date": { "type": "timestamp", "required": true, "granularity": "day" },
          "due": { "type": "timestamp", "optional": true, "granularity": "day" },
          "total": { "type": "money", "required": true },
          "reminders": { "type": "number", "empty": 0 }
        },
        "examples": [
          {
            "id": "inv-0001", "number": "F-0001", "customer": "Example Co",
            "date": "2026-10-02", "due": "2026-11-01",
            "total": { "amount": 120.5, "currency": "EUR" }, "reminders": 0,
            "state": "open", "updatedBy": "agent"
          }
        ]
      }
    },
    "views": [
      { "id": "invoices", "archetype": "list", "kind": "invoice",
        "columns": ["identity", "state", "total", "due"], "fold": { "when": "state = paid", "label": "paid" } }
    ],
    "surfaces": {
      "pulse": { "kind": "invoice", "aggregate": "sum", "field": "total",
                 "when": "state = open", "label": { "term": "outstanding" } },
      "needs-you": [
        { "when": "state = open and due < now", "urgency": "due",
          "clears": "state = paid", "actions": ["set-field", "open", "message-agent"] }
      ]
    },
    "actions": [
      { "verb": "set-field", "kind": "invoice", "fields": { "state": { "writableBy": "owner" } } },
      { "verb": "message-agent", "kind": "invoice", "to": "producer",
        "templates": ["Chase payment for {{identity}} ({{total}})"] },
      { "verb": "agent-record-write", "kind": "invoice", "by": "producer" },
      { "verb": "open" },
      { "verb": "ack" }
    ]
  }
}
```

### `apiVersion` and `metadata`

`apiVersion` is the constant `silo-standard/v0`. `metadata.id` is the silo's id —
`[a-z0-9-]`, starting with a letter or digit — and is not a word the kernel keeps
(`kernel`, `silo`, `silos`, `registry`, `submissions`, `operator`, `events`,
`proposals`, `available` and a few more) nor an id the owner approved before on
that Silos (conformance §2). Nor the id of an engine dimension — `memories`,
`skills`, `mcps` are the engine's own configuration (`silo-check` and the door
refuse them with the door's words). The silos Silos ships keep their ids
(`plans`, `task-mode`, `system` — recommended, installed with Silos — and
`support`, `hierarchy`, `executions`, `heather` — optional, in the catalog):
a manifest of yours under one of them is an update of that silo, not a new one. `version` is semver; `name` is what the dialog and
the pulse call your silo. Three versions have three owners: `apiVersion` the
standard's, `metadata.version` yours, and the records' — records outlive
manifests and are never migrated; you keep old records reading with field
aliases (standard, «Versioning»).

### `spec.producer`

The role that writes the records. The owner binds it to one or more agents in
the dialog; `any-agent` means any agent with the skill named in `via`.
`instructions.summary` and `protocol` are prose injected only to the bound
producers, in both engines. Add `sync` (`service`, a `contract` of at least one
line, optional `stateMap`) only if the producer syncs from an outside service
(schema `$defs/producer`). The role `kernel` is reserved for kernel sources
(below).

### `spec.sources` — where the records live

v0 has one source a third party writes: **`files`** — a glob inside a location
class, a declarative parser (`json` or `md-frontmatter`), confinement enforced by
the validator (standard, «Sources, freshness and writing»; conformance §3):

- `root: agent-state` expands under every agent's `$SILOS_AGENT_STATE`; the
  convention is `silos/<your-id>/…`.
- `root: project` reads the project folders Silos knows.
- The glob must name a folder of its own, must not climb with `..`, and resolves
  to regular files only, within size limits. The **convention** is derived from
  the canonical root of each source (`agent-state:silos/invoices-lite`) — you
  never declare it. Two silos may read the same convention; only one is active
  with slots, the other is a declared coexistence gesture (conformance §4).
- v0 reads one top-level kind per manifest.

`expects` declares freshness: `producer` (`agent` or `sync`) and a `cadence`
(`\d+(m|h|d)`). When the last write is older than the cadence, every slot of the
silo says so.

How records get written follows from three things, not one:

- **An agent writes its files** (`expects.producer: agent`). Add the action
  `agent-record-write` and it may also change its own records through the API
  with its bearer — derived from location, never someone else's records
  (`catalogs.md`, «Actions»).
- **A sync** is not a source — it is a producer that syncs an outside service and
  writes `files`, under a contract: idempotent, one record per file, money and
  dates normalized, never over the owner's fields (standard). A sync plus
  `ownerWritable` fields means the owner's values live in an **overlay**, and the
  producer must read the merged view through the API — so approval is refused
  until that producer holds a bearer (conformance §8; checked at approval on the
  Silos it is installed on — validation and `silo-check` cannot see it).
- **`kernel` sources are the platform's, not an author's.** A kernel source
  (`type`/`root: kernel` plus `kind`) reads no one's files; it presents a kind
  the kernel already publishes in `kernel-kinds/v0` (`catalogs.md`, «Kernel kinds»:
  `task-wake`, `execution`, `process`, `worktree`). You cannot add a kernel kind; you can only declare presentation over
  a published one, with `producer.role: kernel`, no instructions, no sync, the
  anchor `platform`, the catalog's own states and fields, and only `open` and
  `ack` (conformance §3, §5, §6). `reference/executions.silo.json` (kind
  `execution`) and `reference/system.silo.json` (kinds `process`, `worktree`,
  with kernel-verbs) are the worked examples.

### `spec.kinds` — the record

Every kind maps the **envelope** (standard, «The record envelope»):

| Envelope field | In the example |
|---|---|
| `id` | from the filename, and must match the `id` field when both exist |
| `identity` | the sentence that *is* the record in a row — a template with a declared fallback (`empty`), never invented |
| `state` | a field (or computed from children) |
| `at` | the field that dates the record (or inherited from the parent, for sub-kinds) |
| `anchors` | derived from location: `agent` for agent-state, `folder` for project; `conversation` only through a declared field; `platform` only for kernel data |
| `updatedBy` | who touched it; may be declared `absent: unknown`, never invented |

**`states`** is an ordered list with plain-word labels for one and many, and at
least one `terminal`. From it Silos derives what the pulse counts (the live
states), what enters Done today (the observed transition to terminal), the board
columns, the fold and what needs-you predicates exclude. A raw value is never
painted.

**`fields`** — types from `catalogs.md`, «Field types»: `string`, `number`,
`email`, `url`, `timestamp`, `money`, `boolean`, `actor`, `path`, `attachment`,
`refs(<sub-kind>)`. `money` is `{amount: number, currency}` already normalized —
parsing «71,00» is the producer's job. `number` is a finite JSON number with no
unit: comparable with numeric literals, never summed (`sum` is money only).
Unknown fields in a record are always preserved (`unknownFields: preserve`).

**`roles.due`** names the record's future — what falls due, renews or expires —
and feeds predicates such as `due < now + 7d`. `roles.due.word` (lowercase
letters and spaces) is only voice: the word the row uses for that future
(«renews» for a contract; absent, «due»).

**`ownerWritable`** lists what `set-field` may write; over a sync it triggers the
overlay.

**`examples`** — 1 to 3 per kind, mandatory, and every one must read with your
own manifest (conformance §9). They are the conformance fixture, the empty-state
preview and the worked example of your instructions. They must be **synthetic**:
never a real person's data — no check can prove it; the standard requires it
(conformance §11).

Sub-kinds (children inside the parent's file, with `path`, their own envelope,
`computed` aggregates, `lift` and aliases) are in the schema; `reference/plans`
and `reference/support` are the worked examples.

### `spec.views`, `spec.surfaces` and `spec.actions`

**Views** use the archetypes v0 publishes: `list` and `board` (`catalogs.md`).
The `record` page of every kind and ⌘K are derived — you never ask
for them and nothing is hidden from them.

**Surfaces** are grants: what the dialog lists and the operator switches off
one by one (`catalogs.md`, «Slots»):

- `pulse` — a term in Home's pulse sentence: `count`, or `sum` over a `money`
  field, with an optional `when`, always over live states and the complete set.
- `needs-you` — a dispatchable item in the inbox. Each entry carries `when`, an
  `urgency`, `clears` and at least one action:
  - `blocking` never folds and must clear by something the **owner** can write
    with a `set-field` action; `due` carries a date or predicate and folds under
    the silo's budget; `routine` arrives folded when it piles up
    (`catalogs.md`, «Urgencies»).
  - `clears` is the condition that dispatches the item. Somebody must be able to
    make it true: the owner (`set-field`) or the producer
    (`agent-record-write`) (conformance §7).
  - `audience: producer-agent` sends the entry's rows to the producer bound to
    your role instead of the owner's inbox. For the operator this means: the
    owner's inbox does not list those rows; Home counts them in one line
    («674 invoices are with Finance»), and the bound producer is told in
    its brief that the queue is its own. Approving the manifest is the grant;
    the owner can send any entry back (`audienceOff`), and with no producer bound
    the owner keeps the rows. The validator requires that the producer can
    clear the condition, and refuses it on `blocking` — what blocks is the
    owner's by definition (conformance §7; schema `audience`).
- `rail` — an entry in the global rail pointing at one of your views.
- `agent-section` — a section on the producer's page, under `knows` or
  `machinery`.
- `project-machinery` — a row in the project's machinery line.

**Actions** are declared invocations of kernel primitives, never code:
`set-field`, `append-item`, `move-item`, `ensure-record`, `agent-record-write`, `ack`, `open`,
`message-agent` (`catalogs.md`, «Actions»). Templated messages always carry
their provenance. Over a kernel source you may only `open`, `ack` and declare the
`kernel-verb`s its kind admits — `{"verb": "kernel-verb", "name": "stop-process",
"kind": "process", "when": "stoppable"}`: the KERNEL does the work, from a
closed catalog (`catalogs.md`, «Kernel-verbs»), always as the owner's gesture.

A list view's `fold` may carry a `label` — what the folded records are, a few
words on one line (at most 60 characters): the page's fold line reads «12 paid
· Show»; without it, «12 more · Show».

**Expressions** (`when`, `clears`, `fold.when`, `labelOverrides`) use the one
small grammar of `expressions.md`: comparisons, `in [...]`, `and`/`or`,
`now ± duration`, `since(state)`, `is human`, `startsWith`. They may reference
only fields your kind declares. Aggregators (`count`, `sum`, `max`, `all`) appear
only in `computed` and `pulse`.

### `spec.theme` — a look (optional)

A silo may also bring a look for Silos: colour values in the standard's own
words (`catalogs.md`, «Theme tokens»), for light and for dark, each `#rrggbb`.
Nothing else — no fonts, no CSS, no layout. The kernel measures every pair of the
contrast rule (conformance §12) and refuses a manifest with one under its
minimum; once the owner approves it, the look is a choice in Settings ›
Appearance, for whoever wants it in their own browser.

A silo can be nothing but a look — no producer, sources or kinds. This one
validates as it stands:

```json
{
  "apiVersion": "silo-standard/v0",
  "metadata": { "id": "my-look", "version": "0.1.0", "name": "My look" },
  "spec": {
    "theme": {
      "name": "My look",
      "light": { "background": "#f7f5f8", "panel": "#ece7f0", "text": "#221a29", "text-2": "#55475e", "text-3": "#83758a", "border": "#dcd4e2", "accent": "#8a2f6e", "on-accent": "#ffffff" },
      "dark": { "background": "#1c1720", "panel": "#262029", "text": "#f3eef4", "text-2": "#c8bccd", "text-3": "#9a8c9f", "border": "#3a3140", "accent": "#e59ac9", "on-accent": "#2a0f22" }
    }
  }
}
```

`silo-check` prints the colours and, per mode, the pair closest to its minimum —
how much room the look has. A pair under it is refused with its figures:

```
spec.theme.dark: in dark, text-3 on background measures 1.79:1 — the rule asks at least 3:1 [conformance §12]
```

The reference `heather.silo.json` is a complete one.

## What the validator will refuse

The validator runs its checks in the order of conformance.md and answers every
error in plain words with its position. These are its real answers to broken
copies of the example above, as `silo-check` prints them (the bracket names the
conformance check):

**Schema (§1).** An unknown field of the schema is *additive*: the manifest still
validates, and the field is listed as a want («loads without 1 field this Silos
does not know yet: spec.kinds.invoice.colour»). Everything else the schema says
is a refusal:

```
metadata.id "Invoices_Lite" does not have the expected form ^[a-z0-9][a-z0-9-]*$ [conformance §1]
metadata.version "1" does not have the expected form ^\d+\.\d+\.\d+$ [conformance §1]
spec.kinds.invoice is missing examples [conformance §1]
spec.kinds.invoice.examples takes at most 3 items [conformance §1]
spec.surfaces.needs-you[0].urgency must be one of blocking, due, routine (found "urgent") [conformance §1]
```

**Ids (§2).**

```
metadata.id: kernel is a word the kernel keeps for itself — pick another id [conformance §2]
```

**Confinement (§3).**

```
spec.sources[0].glob: source invoices: the glob "../other/*.json" climbs out of its agent-state root with ".." [conformance §3]
spec.sources[0].glob: source invoices: the glob "*.json" names no folder of its own under agent-state — a source's records live in a named folder [conformance §3]
spec.producer.role: kernel is the producer of kernel sources only — files are written by agents [conformance §3]
spec.sources[0].kind: source x: this Silos publishes no kernel kind "invoice" (kernel-kinds/v0: limit) [conformance §3]
```

**One kind per manifest (§4).**

```
spec.sources: this silo declares 2 kinds and nothing says which source feeds which — v0 reads silos with one kind per manifest [conformance §4]
```

**The envelope (§5).**

```
spec.kinds.invoice.envelope.at: at maps no field — name the field that dates the record (or inherit it from the parent) [conformance §5]
spec.kinds.invoice.envelope.anchors[0]: a kind read from agent-state cannot anchor to a folder from its location [conformance §5]
spec.kinds.invoice.envelope.anchors[0]: a record anchors to a conversation only through a declared field or the owner's gesture — never from its location [conformance §5]
spec.kinds.invoice.envelope.anchors[0]: only kernel data anchors to the platform — records in files belong to an agent or a folder [conformance §5]
spec.kinds.invoice.states: at least one state must be terminal (what counts as done) [conformance §5]
spec.kinds.invoice.states[0].label: state "open" needs its plain words for one and many [conformance §5]
```

**Expressions, views, pulse and actions (§6).**

```
spec.surfaces.needs-you[0].when: dueDate is not a field of invoice — declare it in fields (or fix the name) (column 18) [conformance §6]
spec.surfaces.needs-you[0].when: expected a field, a value, now or since(…), found "=" (column 9) [conformance §6]
spec.surfaces.pulse.field: sum needs the money field it adds up [conformance §6]
spec.surfaces.pulse.field: reminders is not a money field of invoice [conformance §6]
spec.views[0].columns[4]: amount is not a field of invoice [conformance §6]
spec.surfaces.needs-you[0].actions[1]: delete is not an action of the catalog (set-field, append-item, move-item, ensure-record, agent-record-write, ack, open, message-agent) [conformance §6]
spec.actions[0].verb: set-field does not act on kernel data — a silo over a kernel source may only open, ack and declare the kernel-verbs its kind admits (the kernel's own mutations) [conformance §6]
spec.actions[1].name: this kernel knows no kernel-verb "restart-process" — the catalog is closed (stop-process, remove-worktree) [conformance §6]
spec.actions[1].name: stop-process does not act on the kernel kind limit — it admits no kernel-verb: open and ack only [conformance §6]
```

**Needs-you (§7).**

```
spec.surfaces.needs-you[0].clears: a blocking item must clear by something the owner can do — reminders > 3 reads reminders, none of which a set-field action lets the owner write [conformance §7]
spec.surfaces.needs-you[0].clears: nobody can clear this item: reminders > 3 reads reminders, which neither the owner (set-field) nor the producer (agent-record-write or a sync) writes [conformance §7]
spec.surfaces.needs-you[0].audience: a blocking entry cannot be routed to the producer — what blocks is the owner’s by definition [conformance §7]
spec.surfaces.needs-you[0].audience: audience producer-agent needs the producer to be able to clear it — declare agent-record-write on this kind, or a sync (the sync is its write channel) [conformance §7]
```

**Examples (§9).** Every example is read with your manifest; the reason names
the field.

```
spec.kinds.invoice.examples[0]: this example does not read: missing customer [conformance §9]
spec.kinds.invoice.examples[0]: this example does not read: state "void" is not one of open/paid [conformance §9]
spec.kinds.invoice.examples[0]: this example does not read: total must be money as {amount, currency} (found "120,50 €") [conformance §9]
```

What only the Silos you install on can know is checked there, not by
`silo-check`: an id approved before on that Silos (§2), coexistence with an
active silo reading the same convention (§4), whether the sync producer holds a
token today (§8), and the update diff against the installed version (§9).

### The producer-clearable rule (conformance §7)

`audience: producer-agent` is a grant the operator makes by approving; it is
never valid on `blocking`, and the condition must be clearable by the producer —
an `agent-record-write` action on the kind, or a sync, «the sync is its write
channel». Over a kernel source the kernel writes every field: a `clears` on them
is cleared by its engine (a window resets) with nobody's gesture; `blocking`
still needs something the owner can write, and there is nothing, so it does not
validate; `producer-agent` has no producer to go to.

A sync counts as the producer's write in the «nobody can clear this item» check
too: an entry whose `clears` reads only fields the sync fills validates without
an `agent-record-write` action.

## How to check

From a checkout of the Silos repository:

```
npm run silo-check -- path/to/my.silo.json
```

It parses the file (a JSON mistake is said in the parser's words, with its line and column when the parser gives a position), runs the
same validator the install door runs, and exits 0 when the manifest validates,
1 when it does not. On success it prints what the install dialog will tell the
owner: the slots in the words Home will use (from your examples — there are no
records where you are), what it reads and with which cadence, who writes it and
what each action lets each side write, where needs-you rows go, the proposed
sync automation, requirements, wants and notes, and the brief a bound producer
is handed at start. Several files may be given at once.

When it validates, hand the file to the operator: **/silos › Install a silo…**,
paste it or pick the file, **Submit for review…**. The paste door answers the
same validator's errors in place; a valid manifest opens the review dialog,
where the owner sees the same consequences — this time from the real records on
their disk, if any — and decides.

## Further reading

- The manifest above — a producer agent, an owner-writable field held in the
  overlay, a `sum` pulse, a `due` role, a `due` needs-you entry.
- `reference/system.silo.json` and `reference/executions.silo.json` —
  presentation over kernel data: kernel source, `platform` anchor, kernel-verbs.
- `reference/plans.silo.json` and `reference/support.silo.json` — sub-kinds,
  computed state, `lift`, aliases, `labelOverrides`, a board.
- `reference/hierarchy.silo.json` (relations only) and
  `reference/heather.silo.json` (a look only) — the smallest silos.
- `conformance.md` — the checks in full and what the conformance suite proves.

## Not yet

- **No remote distribution.** Silos does not fetch silos from anywhere. The
  catalog an installed Silos offers under «Optional» is the reference
  directory shipped with it (`docs/standard/reference/`), nothing else.
- **No folder transport.** A silo is one `silo.json`; there is no package or
  folder format, and the producer instructions travel inside the manifest.
- **A silo you write travels by paste** — or by an agent's submission on the
  Silos it runs on. Either way it lands pending and waits for the owner.
- `silo-check` runs from the Silos repository; the standalone package and the
  samples argument the annex describes (`npx silo-check my.silo.json
  ./samples/`) do not exist yet.
