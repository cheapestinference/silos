# Plan mode, visible in the conversation

## Context

When a claude uses plan mode, its plan (what it proposes and what you approve or reject) is today just one more tool call. The conversation does not set it apart and the column does not show it. This was on hold because no transcript on hand had a real `ExitPlanMode`, and the rule in `context.ts` is to implement only formats checked against real JSONL.

**This very approval creates that sample.** The current CLI (2.1.316) no longer receives the plan as a parameter: it reads it from `~/.claude/plans/<name>.md`. So the first step is to read, in this session's transcript, the real line of the ExitPlanMode `tool_use` and its `tool_result`, approved or rejected, to learn what it actually stores:
- whether the plan travels inside the input or there is only a path;
- how approved is told apart from rejected;
- whether the `permission-mode` lines record entering and leaving plan mode.

## Approach

1. **Real sample.** Extract and redact this session's lines (EnterPlanMode, ExitPlanMode and its result, and the mode lines) as a fixture in `server/test/fixtures/`, like the other Claude Code golden files.
2. **Parser** (`server/src/harnesses/claude-code/parser.ts`, `types.ts` `TranscriptTurn`): a new field `planProposal?: { text, state: 'proposed' | 'approved' | 'rejected', file?: string }` on the turn that calls ExitPlanMode. The text is the whole plan, without the 2000-character cap of `ToolUseDetail.input`. If the JSONL only carries the path, the file is read if it exists; if not, it says «plan file gone» and invents nothing. The state comes from the `tool_result`.
3. **Context** (`claude-code/context.ts`, `SessionContext`): `planMode: { state, at, title } | null`, with the conversation's latest plan. It sits next to `pending` and `flags.permissionMode`, which already exist.
4. **Web**:
   - In the chat, the turn with `planProposal` is drawn as a block of its own: the plan's markdown, folded after about 12 lines, with a «Plan proposed / approved / rejected» header and the time. It is not drawn as a tool run.
   - In the column, a «Plan · approved 20:41» row that jumps to that turn. While the plan is proposed and unanswered, the conversation waits on the human just as with an open question. Check whether `live.ts` already treats it that way; if not, add it to the same «waits on you» calculation.
   - Built with the `frontend-design` skill. No layout tests: screenshots.
5. **OpenCode**: its plan mode is another agent (`plan`), not a tool. The two-engines rule applies to what belongs to the conversation, so check whether its reader sees something equivalent. If there is nothing to read, say so in `docs/harnesses.md` and invent nothing.

## Files

- `server/src/harnesses/claude-code/parser.ts`, `context.ts` and `server/src/types.ts` (and its mirror `web/src/lib/types.ts`)
- The chat's turn component (the one that draws tool runs with `lib/tool-summary.ts`) and the `ContextColumn`, **carefully**: another change is rewriting ContextColumn right now. Only one new row, coordinated before touching it.
- Tests: parser and context over the real fixture (approved, rejected and without a file). It is the engine, so it gets tests.

## Verification

- `npm test` and `npm run typecheck` with the full totals read; `npm run e2e`.
- This conversation in Silos must show the «Plan approved» block of this very plan, and the column its row.
- Deploy with `npm exec -w web -- vite build`. The change touches `server/src`, so **warn before saving**, because it freezes the live console.
- Commit only my own files, with the task marked done in the plan.
