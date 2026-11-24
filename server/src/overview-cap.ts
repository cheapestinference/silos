// The overview's per-agent cap, by KIND — pure.
//
// One cap over the newest N sessions hid the owner's conversations: an
// agent with an hourly automation had its newest 40 sessions ALL be runs,
// so every human conversation fell off the end before the client could
// split runs from conversations (Builder: 1,347 conversations, sidebar read
// "No conversations yet"). Conversations and runs are
// trimmed apart, and runs per automation: the sidebar files them under
// their automation (AutomationsTree shows 5, "show all" a few more), so a
// chatty automation never starves a quiet one. Input must be newest-first;
// output keeps that order.
// The owner's conversations are few (≈120 across every agent) and
// the sidebar folds all but the newest under "N older": a cap of 40 only
// hid Writer's conversations older than mid-August with no way to reach them
// ("I used to see many, now very few"). The ceiling stays as a guard
// against a pathological folder, far above any real list.
export const CONVERSATIONS_SHOWN = 1000
export const RUNS_SHOWN_PER_AUTOMATION = 10
// message conversations shown per agent: they stay reachable (open, a
// search, the agent's Messages), so a little more room than runs
export const MESSAGE_CONVERSATIONS_SHOWN = 30

// A nested run (births — an agent's own `claude -p`) is not one of the
// owner's conversations either: capped per parent conversation (or per
// agent when it has none) with the runs' allowance, so the newest of each
// survives for the column and the agent page.
// A message conversation (origin message) is capped
// apart too — per agent, with the runs' allowance — so months of them never
// push the owner's own conversations out of the list (a bug once).
type Capped = {
  origin?:
    | { kind: 'automation'; automationId: string }
    | { kind: 'nested'; parent: string | null }
    | { kind: 'message'; messageId: string }
    | { kind: 'task'; task: string }
  agentId?: string
}

export function capSessionsByKind<S extends Capped>(
  newestFirst: readonly S[],
  caps: { conversations: number; runsPerAutomation: number; messagesPerAgent?: number } = {
    conversations: CONVERSATIONS_SHOWN,
    runsPerAutomation: RUNS_SHOWN_PER_AUTOMATION,
    messagesPerAgent: MESSAGE_CONVERSATIONS_SHOWN,
  },
): S[] {
  let conversations = 0
  const perBucket = new Map<string, number>()
  const out: S[] = []
  for (const s of newestFirst) {
    if (s.origin === undefined) {
      if (conversations >= caps.conversations) continue
      conversations++
    } else {
      const bucket =
        s.origin.kind === 'nested'
          ? `nested:${s.origin.parent ?? ''}`
          : s.origin.kind === 'message'
            ? `message:${s.agentId ?? ''}`
            : s.origin.kind === 'task'
              ? `task:${s.agentId ?? ''}`
              : `automation:${s.origin.automationId}`
      const n = perBucket.get(bucket) ?? 0
      const cap = s.origin.kind === 'message' || s.origin.kind === 'task' ? (caps.messagesPerAgent ?? MESSAGE_CONVERSATIONS_SHOWN) : caps.runsPerAutomation
      if (n >= cap) continue
      perBucket.set(bucket, n + 1)
    }
    out.push(s)
  }
  return out
}
