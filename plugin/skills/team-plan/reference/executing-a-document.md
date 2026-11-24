# Team tasks — executing an engineering document

Reference for the `team-plan` skill.

When an implementation plan already exists as a document (for example one
written with a planning skill into `docs/**/plans/<name>.md`, with
"### Task N: …" sections) and an agent executes it step by step (for
instance with subagent-driven development), the team tasks do NOT mirror
its sections. The executor's own ledger (`.superpowers/sdd/<plan>/progress.md`,
written by that skill at every approval) is the record of progress: Silos
reads it, paints the real progress in the conversation's column, and keeps a
copy when the worktree goes. The team tasks hold only what people coordinate on:

1. ONE agent task per document: `title` = "Execute <document title>",
   `owner` = the executing agent, `source` = "<path to the .md>". Claim it
   when execution starts (that links the executing conversation, which
   hangs the execution from the task) and mark it `done` when the branch is
   merged. It goes in the project's list unless a named plan already holds
   the work.
2. The HUMAN tasks the document names (an approval, a credential to add, a
   setting only the owner can change), with the human as owner and
   `dependsOn` as the document implies (same file as the agent task). Not a
   "final validation" task: the merge is the end ([schema.md](schema.md)).

`source` is an extra field: tooling that doesn't know it ignores it.
