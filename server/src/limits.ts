// limits.ts — the task-mode numbers, ONE source (distinct from
// silos/limits.ts, the silo kernel's own). Unmeasured figures (d3): they are
// revised with measurements, never by eye.

const DAY_MS = 24 * 3600_000

// the ceiling per agent and LOCAL day (R7): charged task wakes + runs of its
// own recurring work without acceptedFrom. Heartbeat turns are out, «Run
// now» included: their period is their ceiling. The
// owner's gestures neither count nor are held by it.
export const OWN_TURNS_PER_DAY = 10
export const OWN_TURNS_PER_DAY_MIN = 1
export const OWN_TURNS_PER_DAY_MAX = 200
// unattended turns of ONE agent at once (was TASK_TURNS_LIVE): an owner's
// gesture does not jump it either (R1: it is queued, said) — and the queue
// has TWO classes: a gesture enters ahead of every non-gesture, FIFO inside
// each class
export const OWN_TURNS_LIVE = 2
// unattended turns live in the WHOLE installation (heartbeats + wakes + runs
// of agents): the excess is QUEUED in the same two classes, never lost
export const UNATTENDED_TURNS_LIVE_GLOBAL = 3
export const INITIATIVES_PER_WEEK = 1
export const INITIATIVES_OPEN_MAX = 3
export const SELF_RECURRENT_MAX = 3
export const SELF_RECURRENT_MIN_GAP_MS = 7 * DAY_MS - 3600_000
export const SELF_RECURRENT_RUNS_DAY = 1
// DEFAULT of Agent.unattendedSpendPerDay (B1): USD a local day of its
// unattended turns, compared when the provider prices
export const UNATTENDED_SPEND_USD_DAY = 5
export const UNATTENDED_SPEND_MIN = 1
export const UNATTENDED_SPEND_MAX = 1000
// maxTurns of the SDK in a heartbeat turn (Claude; OpenCode: OPEN 9)
export const HEARTBEAT_MAX_TURNS = 30
// ONE wall cap for EVERY unattended turn the resident launches: the runs
// (the old RUN_TIMEOUT_MS, renamed) AND the task wakes (r6 #169) — failed /
// timeout + chat.cancel + lock released
export const UNATTENDED_TURN_TIMEOUT_MS = 30 * 60_000
export const PROPOSALS_PENDING_MAX = 3
export const PROPOSAL_TTL_MS = 14 * DAY_MS
export const SLEEP_MAX_MS = 30 * DAY_MS
export const CONSIDERED_PER_TURN = 20
// items per packet source: the rest «…and <n> more», their keys out
// of packet.keys so they come back at the next heartbeat
export const PACKET_PER_SOURCE_MAX = 20
export const MESSAGE_UNREAD_ROW_MS = DAY_MS
// the floors of the free period, in minutes: above
// them everything goes — the screen says the consequence, never forbids
export const HEARTBEAT_PERIOD_MIN = 5
export const AUTOMATION_PERIOD_MIN = 1
// how far back the packet looks when no heartbeat turned yet
export const PACKET_FIRST_SINCE_MS = 7 * DAY_MS
// the considered lines the prompt carries: the last 20, ≤ 90 days
export const CONSIDERED_PROMPT_MAX = 20
export const CONSIDERED_PROMPT_DAYS_MS = 90 * DAY_MS
// considered.jsonl is rotated at this many lines — with several
// rounds a day, 500 lines were hours of memory
export const CONSIDERED_KEEP_LINES = 2000
// the considered lines a ROUND's prompt carries
export const CONSIDERED_PROMPT_ROUND = 60

// ── the proactive mode — unmeasured figures, revised
// with the measure and with Usage ──
// what a proactive agent may create from its mission in a local day (1–50)
export const PROACTIVE_PER_DAY = 5
export const PROACTIVE_PER_DAY_MIN = 1
export const PROACTIVE_PER_DAY_MAX = 50
// its open tasks with root `mission`, at most
export const PROACTIVE_OPEN_MAX = 10
// maxTurns of a round WITH its tools (Claude; OpenCode: the 30 min cap of
// every unattended turn)
export const ROUND_MAX_TURNS = 60
// % of the 5-hour window or of any weekly one: past it, rounds and thinks wait
export const ROUND_ACCOUNT_HEADROOM = 85
// the plan reading a round's margin trusts, at most this old (by its hour)
export const ROUND_USAGE_FRESH_MS = 15 * 60_000
// a provider that neither prices nor can be read: rounds with a turn a day
export const ROUNDS_UNMEASURED_PER_DAY = 12
// % of the day's spend cap past which rounds wait (its tasks go on)
export const ROUND_SPEND_SHARE = 50
// a sleep asked in a turn that read outside is bounded to this
export const ROUND_SLEEP_AFTER_OUTSIDE_MS = 3 * DAY_MS
// a proactive agent's own recurring work: its own weekly counter
export const SELF_RECURRENT_PER_WEEK = 1
// a `yours` task comes back to the packet when it is still not started this
// long after it was last listed; a foreign wait, every this long
export const PACKET_RELIST_MS = 7 * DAY_MS

// ── agent ↔ agent asks ──
// an ask on another agent is a GUARD (never the owner's relay row) only while
// that agent's next heartbeat, counted from the moment it was asked, falls
// within this much — and only until then (H8)
export const ASK_REACH_MS = DAY_MS
// the bounds of what an ask stores and writes to the file, exactly (H5): its
// action, its question, and the answer's note (the plans note's own max)
export const ASK_ACTION_MAX = 80
export const ASK_ASKED_MAX = 500
export const ASK_ANSWER_MAX = 8000
// asks an agent may arm in a local day (B2.1, H11 — counted in Task mode's
// store, `armsToday`): a repeat that changes nothing is not counted
export const ASKS_PER_DAY = 20
// (H9) the round trips on ONE task: an ask is refused at arm time once this
// many `answered` wakes of that answerer on that task were delivered in 24 h
export const ANSWERS_PER_TASK_DAY = 3
export const ANSWERS_WINDOW_MS = DAY_MS

// the next local midnight after `now` — when a day's ceiling opens again
export function nextLocalMidnight(now: Date): Date {
  const d = new Date(now.getTime())
  d.setHours(24, 0, 0, 0)
  return d
}
