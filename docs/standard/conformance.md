# Silo Standard v0 — Validation and conformance

Two contracts: what the **validator** checks on submission (and on every update),
and what the **conformance suite** proves about a kernel that claims to implement
the standard. The `silo-check` CLI (`npm run silo-check`) prints the same thing as
the validator's text preview — if the validator could not run outside the kernel,
the kernel would have slipped in a dependency it must not have.

The check numbers below (§1–§12) are stable: validator messages and other
documents cite them.

## The validator (on submission and on update; also for `draft`)

The checks run in this order; every error is given in plain words with its
position.

1. **Schema**: the manifest validates against `silo.schema.json`. An unknown
   ADDITIVE field ⇒ what is understood is loaded and the rest stays in `wants`
   (status). An unknown RESTRICTIVE field ⇒ the install is REFUSED with a reason
   (must-understand; the class is empty in v0 — the rule already applies).
2. **Ids and charsets**: a silo id is `[a-z0-9-]` and not reserved (the kernel's
   words, and approved silos — also after uninstall); record ids follow the kind's
   charset.
3. **Source confinement**: every glob resolves strictly inside its `root` class —
   realpath, no `..`, no symlink escape, regular files only, size caps. A glob
   over the root of a project does not validate. Legacy conventions outside the
   `silos/` prefix are a CLOSED LIST of the kernel, never a manifest field.
   **`kernel` source**: there is no glob to confine — the named `kind` MUST exist
   in THIS kernel's kernel-kinds catalog; one it does not publish is **an error,
   not a want** (the additive rule speaks of fields; an unknown catalog value
   leaves the silo with nothing to read — the same reading as an unknown
   archetype). A kernel source stands alone (never next to a `files` source: both
   would feed the same kind) — one per silo, or several (21-11) each feeding the
   kind named like the kernel kind it presents, every kind fed by exactly one —,
   and its `producer.role` is `kernel`
   with no `instructions` and no `sync`; the role `kernel` is carried only by a
   kernel source.
4. **Convention**: derived from the canonical root of each source (one per
   source) and written in `status` — for a kernel source, `kernel:<kind>`. An
   intersection with an active silo is not an error: it is the **coexistence
   gesture** (the dialog offers a reversible takeover — the old silo's slots AND
   instructions suspended — or a separate view).
5. **A complete envelope per kind**: id/identity/state/at/anchors mapped
   (updatedBy may be declared absent); anchors the source's location can sustain
   (a kind in agent-state does not anchor to a folder; the `platform` anchor is
   sustained only by a kernel source, and a kernel source sustains only
   `platform` — except the parent anchor `{hub: task, from: parent}`, valid only
   over a kernel kind the catalog declares with parent `task`, e.g. `execution`);
   states with complete labels and at least one `terminal`. Over a kernel source
   the manifest's kind **matches the published kind**: the same states (not one
   fewer, not one more) with the same terminals, only catalog fields with their
   type, `id`/`state`/`updatedBy` on the catalog's fields, `at` and the `due` role
   on the catalog's timestamps, and never `id.from: filename` (a kernel record has
   no file).
6. **Expressions**: every predicate parses against the grammar (`expressions.md`)
   and references only declared fields of the kind (or `parent.`); aggregators
   only in `computed` and `pulse`. Over a kernel source the actions of every
   needs-you entry are only `open` and `ack`, and those of `spec.actions` also
   the `kernel-verb`s the kernel kind admits: `name` from the closed catalog
   (`catalogs.md` «Kernel-verbs» — an unknown name is rejected), admitted by
   the kind, `kind` the kind that presents it and `when` (if any) a valid
   predicate over it. A `kernel-verb` on a file silo does not validate. Kernel
   data is never written by a silo verb.
7. **Needs-you**: every entry carries a dispatchable `clears`; an unconditional
   `blocking` does not validate; with `audience: producer-agent`, the condition
   MUST be clearable by the producer (an `agent-record-write` action on the kind,
   or a sync source — the sync IS its write channel) and the entry cannot be
   `blocking` (what blocks is the owner's by definition).
   A non-blocking entry is cleared by whoever writes some field of its `clears`:
   the owner (`set-field`), the producer (`agent-record-write` or its sync) or the
   kernel; if nobody can, it does not validate («nobody can clear this item»).
   Over a kernel source the KERNEL writes every field: a `clears` condition over
   them is cleared by its engine (a window resets) without anybody's gesture;
   `blocking` still requires something the owner can write (there is nothing: it
   does not validate), and `producer-agent` has no producer to go to (it does not
   validate, with the usual reason).
8. **Sync + ownerWritable** ⇒ a mechanical precondition: the declared producer
   holds a bearer (its territory fence enabled); the dialog lists it («requires the
   token of the agent bound to finance — off today»).
9. **Examples**: 1–3 per kind, mandatory, and ALL of them parse with the manifest
   itself (they produce a valid envelope, or the submission fails naming the
   field). On an UPDATE, the previous version's examples MUST still parse or
   declare aliases — and the diff says «N records on disk stop parsing» (dry-run)
   and lists any LOOSENING of fence/authorization on its own line.
10. **Dry-run with authorization**: with a bearer, only over locations that bearer
    can already read on disk (the rest is painted with examples); the full dry-run
    runs as the owner at approval. The text preview prints the exact pulse
    sentence, the exact needs-you row and the list row. The data of a kernel
    source is platform data: only the owner's dry-run reads it («from N records
    Silos holds»); a bearer sees the examples. The dialog's consequences, with no
    paths to list, say in the catalog's words what kernel data the silo reads and
    how many records the kernel holds now.
11. **A norm that cannot be mechanized, said anyway**: examples are synthetic —
    never personal data (the suite cannot prove it; the standard requires it).
12. **A theme's contrast** (only when `spec.theme` is declared; added 21-11 after
    §11, so the earlier numbers keep their meaning): the shape is check 1's — the
    closed token vocabulary (`catalogs.md`, «Theme tokens»; an unknown token is an
    error, never a want), `#rrggbb` values, both modes; then every pair of the
    contrast rule is measured in light and in dark, and each one under its minimum
    is an error that names the mode, the pair, the ratio measured (floored to two
    decimals) and the minimum: «in dark, text-3 on background measures 2.41:1 —
    the rule asks at least 3:1». A manifest with a failing pair is rejected. The
    kernel re-checks the theme of a manifest it reads off disk and offers none
    that fails. On an update the diff says whether the look appears, changes its
    colours, is renamed or goes.

## The conformance suite

Published with the standard. It runs against a kernel with the reference
manifests installed and their examples as fixtures, plus generic test manifests
for what no shipped silo exercises (a sync producer with an owner overlay, a
project-anchored source; kernel sources are exercised over the kernel kind
`process`, its records held by a fake kernel source):

- **Envelope**: every fixture produces a valid envelope; every deliberately broken
  fixture (customerEmail removed, an invalid status) produces the EXACT error with
  the field named — a generalized explanation is testable, not aspirational.
- **Tolerance**: the `lift`s (a loose threadId → a synthesized thread with EMPTY,
  not invented, fields; a note string → a minimal note) and the aliases (`opened`,
  `thread_id`, the conditional alias of `customer`) produce exactly what the
  manifest declares.
- **Terminal derivations**: the pulse counts only live records; the observed
  transition to terminal (journal) feeds Done today; «arrived closed» ≠ «was
  closed»; the first observation is a baseline and floods nothing.
- **Journal**: `since(state)` from the observed transition; `removed` when a file
  disappears; a rebuild is said aloud.
- **Overlay** (sync source): seals the base value; retires when the source
  catches up; a contradiction ⇒ a conflict in Needs you; an orphan ⇒ a freshness
  term; per field; survives uninstall (pinned to the convention).
- **Writing**: `set-field` re-reads + merges + replaces atomically with CAS;
  `append-item` respects `writeMerge`; `move-item` writes the destination before
  the source and a retry does not duplicate.
- **Data honesty**: counts over the complete set; server-side pagination;
  truncation said («showing 200 of 614»); freshness on every slot once `cadence`
  is exceeded, collapsed into one term when there are several.
- **Uninstall**: removes views/slots/instructions/derived fence; NEVER records,
  overlay or journal; live producers listed; records that keep growing ⇒ a Home
  term.
- **Install**: every third-party submission lands `pending`; activation only by
  the owner's click; install/update/uninstall are visible events.
- **Looks**: every reference manifest validates; a theme-only manifest installs
  with no producer, sources or kinds; a bad value, an unknown token, a missing
  mode and each pair under its minimum are rejected with their figures; the
  descriptor carries a theme only while its silo is active; the dialog says the
  look and draws its colours; an update says what happens to the look.
- **Kernel source**: a kernel record produces a valid envelope anchored to the
  platform (no agent or folder); one the manifest cannot read is listed with its
  reason; installing with live records is a baseline (it does not flood Done
  today); a move the kernel writes clears the Needs you row; a quiet end is never
  Done today; uninstalling keeps the records and the journal.

## Reference measurement

The reference manifests were first measured against real records of a working
installation (every record producing a valid envelope or an explained failure,
with the same reasons the pre-standard code gave). That dataset is private, so the
measurement is kept as private design history, not as a check an outside kernel
can rerun; the reproducible fixtures are the manifests' own `examples`.
