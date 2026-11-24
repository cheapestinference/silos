// Appended to EVERY run's prompt so the run history reads as results ("acted"
// / "no news") instead of hundreds of identical "ok" rows. Additive: the
// heartbeat/responsibility protocols keep writing their own status.json; this
// line only classifies the run itself. Parsed back by resident.ts
// parseRunOutcome. A leaf module: the Claude adapter's started-with reader
// names it as Silos' own text without loading the resident.
export const RUN_OUTCOME_INSTRUCTION =
  'When you finish, end your final message with a line `OUTCOME: nothing` if you found nothing new and changed nothing, or `OUTCOME: acted` if you did something (wrote, fixed, sent, recorded a change) — followed by one sentence saying what.'
