// BackgroundPage — the GLOBAL background-work view. The moment it serves
// (product.md): "what is my fleet doing RIGHT NOW?" without knowing which
// conversation the work hides in — a review spawning 15 verifiers showed
// as '1 working' everywhere else. One page, grouped by conversation,
// newest background activity first; a header navigates to the
// conversation, where the census column takes over (open transcripts,
// nesting). Data: GET /api/tasks — the same census the column trusts;
// alive/finished derived from mtime exactly like conversations (live.ts).
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { relTime } from '../lib/rel-time'
import { agentAtWork } from '../lib/live'
import { basename } from '../lib/routes'
import { SessionDot } from './SessionDot'
import { PageHeader } from './PageHeader'
import type { TasksSession } from '../lib/types'

const TASKS_POLL_MS = 5_000

export function BackgroundPage() {
  const nowTick = useStore((s) => s.nowTick)
  const openSession = useStore((s) => s.openSession)
  const agents = useStore((s) => s.agents)
  const [sessions, setSessions] = useState<TasksSession[] | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      Promise.resolve(api.tasks())
        .then((r) => {
          if (!cancelled && r) setSessions(r.sessions)
        })
        .catch(() => {
          /* the page keeps its last truth; the poll retries */
        })
    }
    load()
    const t = setInterval(load, TASKS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  const emojiOf = (agentId: string): string | null => agents.find((a) => a.id === agentId)?.emoji ?? null
  const liveCount = (sessions ?? []).reduce((n, s) => n + s.subagents.filter((a) => agentAtWork(a, nowTick)).length, 0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* the common band: named like every root page, in the
          same place; the line under the title is the one fact that moves */}
      <PageHeader
        testId="background-header"
        title="Background work"
        facts={
          <span className="min-w-0 truncate">
            Subagents across every conversation
            {liveCount > 0 ? (
              <>
                {' '}
                — <span className="text-terracotta">{liveCount} running now</span>
              </>
            ) : (
              ''
            )}
          </span>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-4 sm:px-5">
        {sessions === null ? null : sessions.length === 0 ? (
          <p className="max-w-prose text-sm text-ink-2">
            No background work in the last two days. When a conversation launches subagents — a review, a research sweep, a skill running in the background —
            they appear here, grouped under their conversation.
          </p>
        ) : (
          <ul className="max-w-3xl space-y-5">
            {sessions.map((s) => {
              const liveSubs = s.subagents.filter((a) => agentAtWork(a, nowTick)).length
              return (
                <li key={`${s.folder}/${s.id}`} className="rounded-xl border border-line bg-panel/40">
                  <button
                    type="button"
                    onClick={() => void openSession(s.folder, s.id)}
                    className="flex w-full items-baseline gap-2 rounded-t-xl px-3 py-2 text-left hover:bg-canvas/60"
                  >
                    {emojiOf(s.agentId) ? (
                      <span aria-hidden="true" className="shrink-0 text-sm">
                        {emojiOf(s.agentId)}
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1 truncate font-display text-[15px] text-ink">{s.title}</span>
                    {s.cwd ? <span className="shrink-0 font-mono text-[11px] text-ink-3">{basename(s.cwd)}</span> : null}
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-2">
                      {liveSubs > 0 ? `${liveSubs} live` : relTime(s.subagents[0]?.mtime ?? s.mtime, nowTick)}
                    </span>
                  </button>
                  <ul className="border-t border-line/60 px-3 py-1.5">
                    {s.subagents.map((a) => {
                      const alive = agentAtWork(a, nowTick)
                      return (
                        <li key={a.id} className={`flex items-baseline gap-2 py-1 ${a.parentId ? 'pl-5' : ''}`}>
                          <SessionDot signal={alive ? 'working' : null} />
                          <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={a.description ?? a.id}>
                            {a.description ?? a.id}
                          </span>
                          {a.skill ? (
                            <span className="shrink-0 font-mono text-[10px] text-ink-3">{a.skill}</span>
                          ) : a.type ? (
                            <span className="shrink-0 font-mono text-[10px] text-ink-3">{a.type}</span>
                          ) : null}
                          <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-2">
                            {alive
                              ? `at work${a.lastTool ? ` · ${a.lastTool}` : ''}${a.startedAt ? ` · ${relTime(a.startedAt, nowTick)}` : ''}`
                              : `done · ${relTime(a.mtime, nowTick)}`}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
