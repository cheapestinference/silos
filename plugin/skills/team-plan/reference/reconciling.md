# Team tasks — reconciling

Reference for the `team-plan` skill (the rules it cites are in SKILL.md,
«Behavior»).

When asked to check that tasks are up to date (or on a standing duty to
keep them so), go task by task through every task that is not done — in
the project's list and in every named plan — and decide from evidence, not
from the file:
- agent tasks: done only with a pointer (commit on the branch that ships,
  file:line, a record with a date); `Dropped:` when superseded (cite it);
- human tasks: done when the system holds the proof (rule 3), with the
  proof in the note; `Dropped:` when obsolete, saying why; when only the
  person can know, append "Evidence: …, confirm to close" and tell them —
  a note is not a closing, so never leave an obsolete task open with a note
  that says it is obsolete;
- an owner named by their name: rename to `owner`;
- recompute `blocked`; turn hidden waits on a person into human tasks;
- a task untouched for weeks whose work sits unmerged or unanswered: say so
  in a note and ask the owner whether it continues;
- move finished NAMED plans to `plans/closed/` — never the project's list.
Then report what changed and what is on each person now.
