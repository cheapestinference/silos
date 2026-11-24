# Silo Standard v0 — The expression language

One language, two named layers, published in the catalog like the slots. It is
deliberately **not Turing-complete**: no loops, no definable calls, no assignment,
no access outside the evaluated record (and its declared parent/children). It is
derived from what the reference manifests use — not one construct more.

## Layer 1 — Expressions (predicates)

Where they are used: `needs-you.when` · `needs-you.clears` · `fold.when` ·
`labelOverrides.when` · `pulse.when` · `lift` conditions.

```
expr        := or
or          := and ( "or" and )*
and         := cmp ( "and" cmp )*
cmp         := operand op operand
             | operand "in" "[" value ("," value)* "]"
             | operand "is" "human"
             | operand "startsWith" string
             | "(" expr ")"
op          := "=" | "!=" | "<" | "<=" | ">" | ">="
operand     := field | value | "now" | "now" ("+"|"-") duration | "since" "(" state ")" | "monthStart"
field       := name ( "." name )*              — e.g. total.currency, parent.at
duration    := integer ("m"|"h"|"d")           — e.g. 7d, 48h
value       := string | number | state
```

- **`now ± duration`**: the clock enters predicates — which is why the kernel
  re-evaluates on a timer as well as on file events (an invoice becomes «due this
  week» without anyone writing).
- **`since(state)`**: hours/days since the record ENTERED that state, read from the
  transition journal («in `waiting_customer` for 5 days»). Before the first
  observation there is no data: the predicate is false, it never invents. The only
  exception is local and declared: inside the `when` of a rotation with
  `"undated": "old"` (`catalogs.md`, `ensure-record`), a `since(…)` with no
  recorded transition counts as old («long ago»). Everywhere else it stays false.
- **`monthStart`**: the start of the current month **in UTC** — the same clock as a
  rotation's `stamp` and archive name — an instant comparable with `since(…)` and
  with date fields (`state = done and since(done) < monthStart`). Like `now`, it is
  a reserved word.
- **The task-flow names** (`waiting`, `gate`, `stalled`, `stalledCause`,
  `stalledBy` — `catalogs.md`, `task` role): like `since()`, the kernel computes
  them on request with injected live facts (which conversation is live, which
  agent wakes); they read like any other field (`ready and owner is human and
  gate`).
- **`is human`**: only over `actor` fields — true when the value does not resolve
  to an agent id.
- **`parent.`**: a sub-kind may look at its parent (`parent.at < now - 30d`). A
  parent does NOT look at its children from this layer — that is what aggregators
  are for.
- **`startsWith`**: a literal string prefix (plans' `Dropped:`).

Real uses (from the reference manifests): `state = needs_owner` ·
`state in [open, partial] and kind = sale and due < now` · `ready and owner is
human` · `state = done and notes startsWith 'Dropped:'` · `parent.at < now - 30d` ·
`state = action_needed and due < now + 7d`.

## Layer 2 — Aggregators (declared, closed list)

Where they are used — ONLY in `computed` fields (of the kind or of the envelope)
and in `pulse.aggregate`. Never inside a layer-1 predicate (the exception: a
computed field may then be used in a predicate by its name — `ready` — which is
exactly how the two layers fit together).

| Aggregator | Over what | Real example |
|---|---|---|
| `count` | live records of a kind (pulse) | «3 cases» |
| `sum(<money>)` | a money field of live records (pulse) | «€12,400 outstanding» — per currency, never mixed |
| `max(a, b, …)` | fields and children collections, ONE level | `max(threads.lastMessageAt…, openedAt)` |
| `all(<refs\|children>, pred)` | children or refs inside the parent | `all(dependsOn, state = done)` · `all(tasks, state = done) ? done : active` |
| `any(<refs\|children>, pred)` | likewise | `dropped: any(notes, text startsWith 'Dropped:')` |

- **One level deep**: an aggregator sees direct children (or refs declared
  `withinParent`), never grandchildren or other records. With nested sub-kinds
  each level aggregates ITS children: a task looks at its `notes`, the plan looks
  at its `tasks` — never the plan at its tasks' notes.
- **`any`** is true when SOME child (or referenced sibling) matches; over none it
  is **false** (vacuity: `all` is true over nothing, `any` false). Over partial
  children (some unreadable) a child that was read and matches is proof (true); if
  none matches nothing is vouched for and it is false — like `all`, it never
  invents. A ref that names no sibling does not count.
- **`? :`** only in a state `computed` (plans' ternary form); it is not a general
  expression.
- `computed` fields are derived **on read** over an index invalidated by mtime;
  they are never materialized; a field of the same name written on disk is
  ignored (except with `at.written: authoritative`) and the explanation names it.

## Limits, said aloud

- No loops, no author functions, no regex (the only prefix test is `startsWith`),
  no general arithmetic (only `now ± d`), no access to other records, silos, files
  or the network.
- A predicate that does not parse = the manifest does not validate (an error with
  the position); a predicate that references a field the kind does not declare =
  it does not validate.
- Bounded total evaluation: needs-you predicates run over ALL records (data
  honesty) — that is why the grammar is small on purpose.
- This grammar is frozen like the rest of the catalog: new constructs are only
  added, together with the manifest that needs them.
