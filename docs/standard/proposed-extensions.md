# Silo Standard — Annex v0.x (proposed, outside the frozen schema)

**Rule:** the v0 schema freezes only what the reference manifests exercise
(«entries are only added»). Everything already designed that no reference manifest
has proven yet is published here as PROPOSED, each piece with the condition that
brings it in. A piece moves from the annex into the schema when that condition is
met and a reference manifest exercises it — never before. The annex is a signal of
demand, not debt: it is exactly the role of `wants`, at the scale of the standard.

## Proposed

| Piece | What it is | Enters with |
|---|---|---|
| Hubs strip | the co-anchoring of other silos on every record/hub page — «installing your second silo improves the first» | when two live silos truly co-anchor (share a hub with records on both sides) |
| `party` role | a normalized counterparty (email/domain) as a join key in the hubs strip and ⌘K | when a producer supplies normalized addresses; joining on names alone would fabricate false joins (two different «Acme») |
| `builtin` meta-silo (+ its `kernel-verb`s Install/Uninstall) | the kernel's settings for silos as a silo itself; Install/Uninstall as declared verbs | the meta-silo. `kernel-verb` itself ENTERED the schema 21-11 with its first name, `stop-process` over the kind `process` (`reference/system.silo.json` 0.2.0, approved by the owner): `{verb: kernel-verb, name, kind, when?}`, a closed catalog in `catalogs.md` «Kernel-verbs», a boolean guard the kernel writes, an owner gesture |
| `re-anchor` | re-attribute a record to another conversation/folder by an owner gesture | after `kernel-verb` |
| `mention` slot + `hand-off` + derived read of the anchor | @record in the composer; the owner's gesture anchors AND derives API read access for the conversation's agent; the composer inserts the envelope as a quote with provenance; `sensitive` always excluded | the first real case |
| `proposal` | a dispatch proposed by the producer, a DERIVED row (verb + literal diff + enum/template params), «proposed by X · approved by owner»; over sync sources the kernel composes it | the first sync producer that needs it live |
| Automation templates | pre-filled recipes over the kernel's scheduler, opt-in per template in the install dialog | the first sync producer that needs it |
| Horizon strip | the mirror of Done today: what is coming across all silos, composed from the `due` role | its UI step (the reference manifests that carry `due` — invoices, documents — already allow the kernel to compute it) |
| `sensitive: true` | **first member of the RESTRICTIVE class**: values never returned whole by the API, the `credentials` archetype, a universal deny, a tombstone after uninstall | a credentials vault moved onto the standard |
| Archetypes `timeline` / `credentials` / `files` | the remaining page shapes | the first silo that needs each |
| Bridge silos + kind extension | nominated joins; extending `task` | later |
| `column-block` slot | a block in a conversation's context column, bounded to its radius | the first real case |
| Standalone `silo-check` | validator + text preview + conformance outside the host repository (`npx silo-check my.silo.json ./samples/`) | publishing the standard as a package; the decoupling is respected already (`conformance.md`) |
| Role packs | the role as a copyable unit: `role.json` + skills (materialized as engine skills, never records) + the silos it produces + automation templates + secrets by name; template ≠ instance, knowledge age (`verified`/`reviewEvery`), a lockfile that never overwrites what the agent touched | its proof: a role exported and installed on a clean host with zero hand edits |
| Distros | `distro.json` = role packs + placements | after role packs |
| Evidence at approval | an `evidence` field role (paths or URLs of files/records the owner can read) on a `needs-you`/`proposal` row: the row and the dialog show it, and approving writes to the silo's journal who, when and the hash of each piece of evidence seen — approving a filing is not a button | the first real case (e.g. a periodic filing with its draft and the comparison with the previous period) |

## Already in the schema

These pieces were proposed here and have entered v0; their rules are in
`catalogs.md` and `conformance.md`. They are listed so that references to «the
annex» keep resolving.

| Piece | Where it is now |
|---|---|
| `kernel` source + the kernel-kinds catalog | `source.root/type: kernel` + `source.kind`, the `platform` anchor, the `number` type, `roles.due.word`; `catalogs.md`, «Kernel kinds» |
| `audience: owner \| producer-agent` | routine rows go to the producer's inbox with escalation; granted by the OPERATOR; the producer's own closings are counted («Finance closed 3 on its own»); `conformance.md` §7 |
| Edge-only silos, the `tree` archetype, the `lens` slot | `spec.relations`, `catalogs.md`, «Relations», «Archetypes», «Slots» |
| `any` aggregator | the shape of `all`; `expressions.md`, layer 2 |
| **`task` anchor** (`{hub: task, from: parent}`) | a kernel record hangs from a TASK of the plans silo: the kernel resolves the task (literal edges: the conversation that wrote it is in the task's `conversations[]`, otherwise the task's `source` names the same document) and writes it in the field the catalog declares as the kind's parent; the manifest only presents it. Valid only over a kernel kind with `parent: {hub: task}` in the catalog; from a location or over files, refused (`conformance.md` §5). It is not a hub with a page of its own: the door is the task's page. First kind: `execution` (`catalogs.md`) |
