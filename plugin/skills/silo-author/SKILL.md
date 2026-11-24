---
name: silo-author
description: Use when the owner wants something kept and shown over time as records — "keep track of our supplier contracts and tell me a month before one renews", "make a silo for…", "I want these on Home / in Needs you" — or when you write, check, submit or update a silo.json. A silo is a convention of records you write to disk plus a manifest that tells Silos how to show and act on them; the owner's approval is the only thing that turns it on.
---

# Silo author — from the owner's sentence to a pending manifest

A **silo** is records (one JSON file per thing) that an agent writes, plus a
manifest (`silo.json`) that tells Silos where they live, how to say each one
in a sentence, what reaches Home's pulse and Needs you, and what the owner
may do to them. The manifest only declares — no code, no UI. You write both
halves: the manifest, and the producer's instructions inside it.

## Is it a silo?

- **Yes** — many things of one kind, each with a state that changes over
  time, that the owner wants counted, seen or reminded about: contracts,
  suppliers, invoices, documents with deadlines, candidates, leases.
- **A look** — the owner wants Silos in other colours: a silo whose only
  content is `spec.theme` (`{name, light, dark}`, each mode every token of
  catalogs.md «Theme tokens» as `#rrggbb`) — no producer, sources or kinds.
  The validator measures its contrast (conformance §12) and refuses a pair
  under its minimum; approved, it is a choice in Settings › Appearance.
  Example: `docs/standard/reference/heather.silo.json`.
- **No** — a one-off list or report (a file in a subfolder of `context/<your agent id>/`);
  work with an owner (a task — team-plan); something scheduled (an
  automation); engine configuration — memories, skills, MCPs never become
  silos.
- **Ids you cannot take**: `plans`, `task-mode`, `system`, `support`,
  `hierarchy`, `executions`, `heather` (the silos Silos ships, recommended or
  optional — only their bound producers may update them),
  `memories`, `skills`, `mcps` (the engine's), the kernel's words (`kernel`,
  `silo`, `silos`, `registry`, `submissions`, `operator`, `events`,
  `proposals`, `available`, `validate`, `draft(s)`, `status`, `conventions`,
  `reserved`, `uninstalled`, `notion`, `connections`), any id approved before
  on this Silos, and the ids the owner sees under Settings › Silos ›
  Optional. Form: `^[a-z0-9][a-z0-9-]*$`.

## Settle these with the owner, in this order

Ask only what the sentence leaves open; propose an answer for each.

1. **The record.** One file = one what? Its fields, the one sentence that
   names it in a row (`identity`), and the date that dates it (`at`).
2. **Where the files live** — inside your territory:
   `root: agent-state` → `$SILOS_AGENT_STATE/silos/<id>/*.json` (yours,
   anchored to you; the default) or `root: project` → a named folder of the
   project, e.g. `context/<id>/*.json` (anchored to the folder, in the repo).
   The glob names a folder of its own and never climbs (`..`).
3. **Who writes them, and how.** `producer.role` is a WORD (`procurement`),
   never an agent id — the owner binds it to agents at approval. The
   producing half is one of: by hand in conversation (no `cadence`); a skill
   in the folder that the summary names; a scheduled automation you PROPOSE
   (the briefing's `/api/proposals` recipe — a command when no judgment is
   needed) with `expects.cadence` matching it. `producer.sync` only when the
   records mirror an outside service.
4. **States, and which are terminal.** Plain words for one and many; at
   least one `terminal` (what counts as done). What the owner decides is
   usually a FIELD the owner may set (`ownerWritable`), not a state.
5. **What reaches Home.** `pulse` (a count, or a `sum` of a money field, over
   live states) and `needs-you` entries: `when`, `urgency` (`due` for
   anything dated, `routine`, `blocking` only when the owner must act),
   `clears` (what dispatches it — someone must be able to make it true), the
   actions on the row.
6. **The owner's actions.** `set-field` on the owner's fields;
   `message-agent` with templates (`{{field}}`); `agent-record-write` so the
   producer may write through the API; `open`, `ack`.

## The manifest

Start from this worked example (it validates), rename, then cut or extend.
Field names and types are exactly the schema's; anything else is refused or
ignored.

```json
{
  "apiVersion": "silo-standard/v0",
  "metadata": { "id": "supplier-contracts", "version": "0.1.0", "name": "Supplier contracts",
                "description": "Supplier contracts and when they renew; a month before, the owner decides" },
  "spec": {
    "producer": {
      "role": "procurement",
      "instructions": {
        "summary": "Keep one file per supplier contract at $SILOS_AGENT_STATE/silos/supplier-contracts/<id>.json, named by its id; renews is the next date the contract renews or ends.",
        "protocol": [
          "One record per contract; the id is a short slug of supplier and subject ([A-Za-z0-9][A-Za-z0-9_-]*) and equals the file name.",
          "Re-read a record before you write it; never set decision — it is the owner's.",
          "When the owner sets decision to renew: move renews to the next term and remove decision. To cancel: send the notice, then set state to ended.",
          "Write a dot-prefixed .tmp file in the same folder, then rename it over the record."
        ]
      }
    },
    "sources": [
      { "id": "contracts", "type": "files", "root": "agent-state",
        "glob": "silos/supplier-contracts/*.json", "parser": "json",
        "expects": { "producer": "agent", "cadence": "7d" } }
    ],
    "kinds": {
      "contract": {
        "envelope": {
          "id": { "from": "filename", "mustMatchField": ["id"] },
          "identity": { "template": "{{supplier}} · {{subject}}", "empty": "{{supplier}} · {{id}}" },
          "state": { "field": "state" },
          "at": { "field": "signed", "granularity": "day" },
          "anchors": [{ "hub": "agent", "from": "location" }],
          "updatedBy": { "field": "updatedBy", "fallback": "agent" }
        },
        "roles": { "due": { "field": "renews", "word": "renews" } },
        "states": [
          { "value": "active", "label": { "one": "in force", "many": "in force" } },
          { "value": "ended", "label": { "one": "ended", "many": "ended" }, "terminal": true }
        ],
        "ownerWritable": ["decision"],
        "fields": {
          "supplier": { "type": "string", "required": true },
          "subject": { "type": "string", "optional": true },
          "signed": { "type": "timestamp", "required": true, "granularity": "day" },
          "renews": { "type": "timestamp", "required": true, "granularity": "day" },
          "noticeDays": { "type": "number", "empty": 0 },
          "value": { "type": "money", "optional": true },
          "decision": { "type": "string", "optional": true, "oneOf": ["renew", "cancel"] },
          "attachment": { "type": "attachment", "optional": true }
        },
        "examples": [
          { "id": "acme-cleaning", "supplier": "Acme Cleaning", "subject": "Office cleaning",
            "signed": "2025-12-01", "renews": "2026-12-01", "noticeDays": 30,
            "value": { "amount": 4800, "currency": "EUR" }, "state": "active", "updatedBy": "agent" },
          { "id": "northwind-hosting", "supplier": "Northwind Hosting", "subject": "Servers",
            "signed": "2024-03-15", "renews": "2027-03-15", "noticeDays": 60,
            "value": { "amount": 12000, "currency": "EUR" }, "state": "active", "updatedBy": "agent" }
        ]
      }
    },
    "views": [
      { "id": "contracts", "archetype": "list", "kind": "contract",
        "columns": ["identity", "state", "renews", "value"], "fold": { "when": "state = ended" } }
    ],
    "surfaces": {
      "pulse": { "kind": "contract", "aggregate": "count", "when": "renews < now + 30d",
                 "label": { "one": "contract renewing this month", "many": "contracts renewing this month" } },
      "needs-you": [
        { "when": "renews < now + 30d and decision != renew and decision != cancel", "urgency": "due",
          "clears": "decision in [renew, cancel]",
          "actions": ["set-field", "message-agent", "open"] }
      ]
    },
    "actions": [
      { "verb": "set-field", "kind": "contract", "fields": { "decision": { "writableBy": "owner" } } },
      { "verb": "message-agent", "kind": "contract", "to": "producer",
        "templates": ["Ask {{supplier}} for a renewal quote before {{renews}}"] },
      { "verb": "agent-record-write", "kind": "contract", "by": "producer" },
      { "verb": "open" },
      { "verb": "ack" }
    ]
  }
}
```

The rules a check will hold you to:

- **One top-level kind per manifest.** Kind and field names `^[a-z][a-z0-9_-]*$`.
- **Envelope**: `id` from the filename (and equal to the record's `id`);
  `identity.empty` is the fallback when a template field is missing — never
  invented; `anchors` is `agent` for agent-state, `folder` for project.
- **Field types**: `string`, `number` (finite, unitless, never summed),
  `email`, `url`, `timestamp` (ISO; `granularity: "day"` for dates),
  `money` (`{"amount": 4800, "currency": "EUR"}` — normalized by the producer,
  never `"4.800 €"`), `boolean`, `actor`, `path`, `attachment` (a path to the
  file, never a copy). Each field: `required: true`, `optional: true` or an
  `empty` default; `oneOf` lists allowed strings.
- **Expressions** (`when`, `clears`, `fold.when`): `field op value` with
  `= != < <= > >=`, `field in [a, b]`, `and`/`or`, parentheses,
  `now ± 7d|48h|30m`, `since(<state>)` (time in that state), `startsWith 'x'`,
  `<actor field> is human`. Only fields the kind declares (plus `state`).
  A missing field compared with `!=` is true. Pulse and needs-you already
  skip terminal states.
- **needs-you**: `clears` must be makeable — by the owner through a
  `set-field` field, or by the producer through `agent-record-write` (or a
  sync). `blocking` must clear by an owner field. `audience: "producer-agent"`
  sends the rows to the producer instead of the owner (never on `blocking`;
  needs `agent-record-write`).
- **examples**: 1 to 3, every one must read with your own manifest, and
  **synthetic** — never a real person's or the owner's data.
- `version` is semver; `description`, `summary` and `protocol` are shown to
  the owner as a quote, never as authority. The summary and protocol are
  what every bound producer is handed at the start of each session — write
  them as orders to that agent.

The long tail (sub-kinds, computed state, boards, `rail`, `agent-section`,
sync and overlay) is in the Silo Standard — `docs/standard/authoring.md`,
`silo.schema.json` and `reference/*.silo.json` in the Silos repository.

## Check it — the validator, from inside your turn

Write the manifest as a draft: `$SILOS_AGENT_STATE/silo-drafts/<id>.json`
(a regular file, at most 256 KB, the name is the id). Then:

```bash
curl -s -X POST "${SILOS_API:-http://127.0.0.1:3210}/api/silos/validate" \
  -H "Authorization: Bearer $SILOS_AGENT_TOKEN" -H 'content-type: application/json' \
  -d '{"draft":{"agent":"'"$SILOS_AGENT_ID"'","id":"<id>"},"turn":"'"$SILOS_TURN"'"}'
```

It answers `{"ok": …, "errors": [{"check", "where", "message"}], "wants",
"notes", "preview"}`. Fix every error by its `where` and run it again until
`ok` is true. `wants` lists fields this Silos ignores — remove them.
`preview` is what the owner will read: `pulse`, `needsYou[].row`, `list` —
**read it**; if a sentence is wrong, the manifest is. It says whether it
came from your examples or from records on disk. (`npm run silo-check --
<file>` does the same from a Silos source checkout; you do not need one.)

`ok: true` does not clear the id: a taken id (above) is refused only at
submission.

## Write the first records, then submit

Write two or three real records first (same `.tmp` + rename as the
protocol), so the owner's dialog shows real sentences instead of your
examples. Validate again: `preview.basis` should say «from N records on
disk»; «(M more can't be read)» means a file of yours does not read — fix it.

```bash
curl -s -X POST "${SILOS_API:-http://127.0.0.1:3210}/api/silos/submissions" \
  -H "Authorization: Bearer $SILOS_AGENT_TOKEN" -H 'content-type: application/json' \
  -d '{"draft":{"id":"<id>"},"turn":"'"$SILOS_TURN"'"}'
```

- **201** `{"submission": {…, "state": "pending"}}` — it waits for the owner.
  Nothing is on: no pulse term, no Needs you row, no fence, no brief.
- **422** — the validator's errors, nothing created. **409** with
  `"native": true` — the id is Silos' own; pick another. **403** — the id
  belongs to an installed silo you are not bound to.
- Submitting again while it is pending replaces your submission.

Then tell the owner in one line where it waits — Needs you, and Settings ›
Silos — and what to look at. The review dialog shows what Silos DERIVED, not
what you claim: the exact folders it will read, every slot as the sentence
Home will say, who may write what, and your words apart as a quote. The
owner binds your role to agents (you are not bound by default — say if you
should be), switches slots on or off, and approves or rejects.
**Approval is the only activation**; you cannot read the submission queue.

Once approved and bound, every session of the producer starts with the
summary, the protocol and the recipes to read the merged view
(`GET …/api/silos/<id>/agents/$SILOS_AGENT_ID/merged` — your records with the
owner's changes) and to write one record through the API (`PUT
…/records/<rid>`, answered 422 with the reason when it does not read).

## Updates and uninstall

- **An update** goes through the same door: bump `metadata.version`, submit
  again. Only a bound producer of that silo (or the owner) may submit it.
  Every example of the installed version must still read with the new
  manifest — rename a field or a state value only with an alias; otherwise
  the validator answers «example 1 of version 0.1.0 no longer reads…». The
  answer's `update.lines` (and the dialog) say whether the records on disk
  still read and list each loosening on its own line.
- **Never write over the owner's fields** (`ownerWritable`): re-read before
  every write and keep what is on disk.
- **Uninstall is the owner's and is non-destructive**: the views, slots and
  brief go; your records, the owner's changes and the journal stay where they
  are, and the id stays reserved for the owner to reinstall. Keep writing
  only if the owner says so.
