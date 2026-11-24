// session-counts.ts — how many conversations and automation runs each agent
// has, counted over EVERY indexed session (pure).
//
// The overview caps each agent's list (overview-cap.ts), so a number shown
// as "N conversations" can never be the length of that list: the agent
// header once read Builder "1,399 conversations" (every run counted as one)
// while the project page summed capped lists (147) and Settings printed the
// capped total (165). One rule for every COUNT: these totals count the
// conversations the owner opened (no `origin`) apart from the runs an
// automation opened — a wake, a run or a nested `claude -p` is a
// conversation too (product.md: the engine's session), it just counts
// under its own class; totals come from here, computed before any cap.
export interface CwdCounts {
  conversations: number
  runs: number
}
export interface SessionCounts {
  conversations: number
  runs: number
  // per automation id (a removed automation's runs keep their id)
  runsByAutomation: Record<string, number>
  // per session cwd ('' = no cwd) — a project's share of an agent that
  // works anywhere (Anywhere's conversations inside one folder)
  byCwd: Record<string, CwdCounts>
  // nested runs (births: an agent's own `claude -p`) with no indexed parent
  // conversation to fold under — the agent page's "N nested runs". Nested
  // runs are neither conversations nor automation runs; present only when
  // there are any.
  nestedLoose?: number
  // conversations Silos opened to work one urgent message each (origin
  // message; HISTORY: no longer written — no message wakes anyone): rows
  // only while open or searched, and neither the owner's conversations nor
  // runs. Present only when there are any.
  messageConversations?: number
  // conversations Task mode opened to wake the agent on a task (origin
  // task): the task's, neither the owner's nor runs. Present only when
  // there are any.
  taskConversations?: number
}

export interface CountableSession {
  agentId: string
  cwd: string | null
  origin?: { automationId: string } | { kind: 'nested'; parent: string | null } | { kind: 'message' } | { kind: 'task' } | null
}

export function emptyCounts(): SessionCounts {
  return { conversations: 0, runs: 0, runsByAutomation: {}, byCwd: {} }
}

// `indexedIds`: the ids a nested run's parent can be found among; without
// it only a parentless nested run is loose.
export function countSessions(sessions: Iterable<CountableSession>, indexedIds?: ReadonlySet<string>): Map<string, SessionCounts> {
  const out = new Map<string, SessionCounts>()
  for (const s of sessions) {
    let c = out.get(s.agentId)
    if (!c) {
      c = emptyCounts()
      out.set(s.agentId, c)
    }
    if (s.origin && 'kind' in s.origin && s.origin.kind === 'nested') {
      const parent = s.origin.parent
      if (parent === null || (indexedIds !== undefined && !indexedIds.has(parent))) c.nestedLoose = (c.nestedLoose ?? 0) + 1
      continue
    }
    if (s.origin && 'kind' in s.origin && s.origin.kind === 'message') {
      c.messageConversations = (c.messageConversations ?? 0) + 1
      continue
    }
    if (s.origin && 'kind' in s.origin && s.origin.kind === 'task') {
      c.taskConversations = (c.taskConversations ?? 0) + 1
      continue
    }
    const cwd = s.cwd ?? ''
    const at = c.byCwd[cwd] ?? (c.byCwd[cwd] = { conversations: 0, runs: 0 })
    if (s.origin && 'automationId' in s.origin) {
      c.runs++
      at.runs++
      c.runsByAutomation[s.origin.automationId] = (c.runsByAutomation[s.origin.automationId] ?? 0) + 1
    } else {
      c.conversations++
      at.conversations++
    }
  }
  return out
}
