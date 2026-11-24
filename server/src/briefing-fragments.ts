// briefing-fragments.ts — the Silos skills the briefing stands in for (a
// leaf: harnesses/briefing.ts composes them, silos/producer-brief.ts asks
// whether a silo's `via` skill is one of them, and silos/ imports no
// harness).

/** The skill-bound fragments, in composition order (after base.md). Each is
 *  also the name of the Silos skill it stands for. compose.py lists the same.
 *  `heartbeat` is the Heartbeat rule (it replaced the
 *  responsibility skill — the agent decides in its heartbeat, the owner
 *  sets its control and rhythm). */
export const BRIEFING_FRAGMENTS = ['team-plan', 'vault-secrets', 'heartbeat'] as const
