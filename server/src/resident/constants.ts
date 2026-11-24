// resident/constants.ts — the resident's tunables (moved verbatim from
// resident.ts, which re-exports the public ones).

export const SIX_HOURS_MS = 6 * 3600_000
export const DEFAULT_TICK_MS = 30_000
export const DEFAULT_FILES_DEBOUNCE_MS = 1000
export const ROTATION_THRESHOLD = 0.85
export const WATCH_PROMPT_CAP = 4096
// What a run cut mid-turn says — written by reconcileStaleRuns (a boot
// finding the orphan) and by shutdown() (SIGTERM closing it in the act),
// and read back by the streak that caps crash-loop relaunches.
export const RESTART_INTERRUPTED = 'interrupted by a server restart'
// After this many CONSECUTIVE interrupted runs, the boot catch-up is
// skipped: the run may be exactly what is bringing the server down.
export const CRASH_LOOP_CAP = 3

// Auto-resume for interactive chats: cap on automatic retries before giving
// up with an honest TERMINAL state (the record is marked `gaveUp`, NOT
// deleted — the banner says so, see the giveUp method). Without a cap, a
// turn that hits the limit on EVERY reset would retry forever.
export const MAX_RESUME_ATTEMPTS = 5

// The resume sweep must not stampede. At most this many resumes are
// processed PER TICK (a throttle, same spirit as the titler's max batch),
// and the day's total is capped by the same budget automations use
// (DEFAULT_MAX_RUNS_PER_DAY) — a weekly reset shared by N chats no longer
// fires N SDK turns at once.
export const RESUME_BATCH_PER_TICK = 3

// What a turn that produced nothing says (no text, no tool, no thinking, no
// output token): the engine ended it on an error of its own — an API or
// account error arrives as a synthetic message with a «success» result. It
// never started: not charged.
export const NO_OUTPUT = 'the turn ended without any output (an engine, API or account error)'
// How long a command's own kill takes past its timeout (SIGTERM, then
// SIGKILL, then the run ends even if a stray grandchild holds the pipes) —
// the outer cap leaves room for it.
export const COMMAND_KILL_SLACK_MS = 15_000
