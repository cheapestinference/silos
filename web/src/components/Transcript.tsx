// Transcript.tsx — the open session's turn thread: persisted turns (capped
// so they don't blow up the DOM in long sessions) + the turn in progress
// (streaming) + the last `!command`'s result. Auto-scrolls to the bottom
// as long as the user hasn't let go of the pin by scrolling up.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Loader2 } from 'lucide-react'
import { useStore } from '../store'
import { useBottomLock } from '../hooks/useBottomLock'
import { Turn, Markdown, type LimitBannerInfo } from './Turn'
import { providerLabel, agentOnCheapest } from '../lib/providers'
import { useSmoothText } from '../lib/smoothing'
import { ToolChip } from './ToolChip'
import { EmptyState } from './EmptyState'
import { ProjectSelector } from './ProjectSelector'
import { ReceiptLine, StatusLine } from './StatusLine'
import { ExternalStatus } from './ExternalStatus'
import { PendingQueue } from './PendingQueue'
import { groupTurns } from '../lib/grouping'
import { assignReceipts } from '../lib/receipts'
import { backgroundWorking, closedByClient, isLive, lastTurnClosed, toolInFlight } from '../lib/live'
import { stripAgentContext } from '../lib/agent-context'
import { ToolStreak } from './ToolStreak'
import { MediaScope } from './MediaImage'
import { MASTER_ID } from '../lib/constants'

const INITIAL_WINDOW = 200
const WINDOW_STEP = 200

// compensates for the scroll jump when expanding the window — exported
// separately so it can be tested with a mocked ref (jsdom doesn't measure
// real layout: scrollHeight always returns 0, so an end-to-end test of the
// handler couldn't check anything).
export function compensateScrollAfter(el: HTMLElement, heightBefore: number): void {
  el.scrollTop += el.scrollHeight - heightBefore
}

// the transcript's own loader: quiet, in place, and DELAYED — a fetch
// that lands in under ~150 ms (the usual case on this machine) paints
// nothing at all, so switching conversations doesn't flicker a spinner.
// The same Loader2 + "Loading…" idiom as FileExplorer/FileViewer.
const LOADER_DELAY_MS = 150
function TranscriptLoading() {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setShown(true), LOADER_DELAY_MS)
    return () => clearTimeout(t)
  }, [])
  return (
    <div className="relative flex-1 overflow-hidden" aria-busy="true">
      {shown ? (
        <p data-testid="transcript-loading" className="flex h-full items-center justify-center gap-2 text-xs text-ink-2">
          <Loader2 size={13} className="animate-spin" aria-hidden="true" /> Loading…
        </p>
      ) : null}
    </div>
  )
}

export function Transcript() {
  const detail = useStore((s) => s.detail)
  const active = useStore((s) => s.active)
  const userTextPersisted = useStore((s) => s.userTextPersisted)
  const selected = useStore((s) => s.selected)
  const execOut = useStore((s) => s.execOut)
  const agents = useStore((s) => s.agents)
  const selectedAgentId = useStore((s) => s.selectedAgentId)
  const nowTick = useStore((s) => s.nowTick)
  // Auto-resume + nudge: extras for THIS conversation's LIMIT banner.
  // Memoized on primitives so its identity ONLY changes when the content
  // changes — Turn's memo (prev.limit === next.limit) shouldn't force a
  // re-render of normal turns on every tick.
  const pendingResumes = useStore((s) => s.pendingResumes)
  const providers = useStore((s) => s.providers)
  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null
  const prKey = selected ? `${selected.folder}/${selected.id}` : null
  const pr = prKey ? pendingResumes[prKey] : undefined
  const agentProvider = selectedAgent?.provider
  const fallbackProvider = selectedAgent?.onFallback?.providerId
  const limitInfo = useMemo<LimitBannerInfo>(() => {
    const resume = pr
      ? {
          resetsAt: pr.resetsAt,
          folder: pr.folder,
          sessionId: pr.sessionId,
          ...(pr.fallbackProviderId ? { fallbackLabel: providerLabel(providers, pr.fallbackProviderId) } : {}),
          ...(pr.gaveUp ? { gaveUp: { tries: pr.gaveUp.tries } } : {}),
        }
      : undefined
    const agentLike =
      agentProvider !== undefined || fallbackProvider !== undefined
        ? {
            provider: agentProvider,
            onFallback: fallbackProvider !== undefined ? { providerId: fallbackProvider, from: agentProvider ?? 'default', until: '' } : undefined,
          }
        : null
    return { ...(resume ? { resume } : {}), nudge: !agentOnCheapest(agentLike, providers) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the fields read, not on the record's identity
  }, [pr?.resetsAt, pr?.folder, pr?.sessionId, pr?.fallbackProviderId, pr?.gaveUp?.tries, agentProvider, fallbackProvider, providers])
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW)
  const scrollRef = useRef<HTMLDivElement>(null)

  const turns = detail?.turns ?? []
  const total = turns.length
  const hasHidden = total > windowSize
  const visible = hasHidden ? turns.slice(total - windowSize) : turns
  // grouping happens AFTER the window cap, BEFORE rendering — streaks of
  // tool-only turns are visually compacted (groupTurns doesn't reorder).
  const allBlocks = useMemo(() => groupTurns(visible), [visible])
  // the active turn only belongs to THIS view if it's the chosen agent's
  // and either it doesn't have a session yet (a chat isNew just started
  // for this agent), or its session matches the one that's open — this
  // keeps a mid-response agent/session change from dragging someone else's
  // streaming along.
  const selectedKey = selected ? `${selected.folder}/${selected.id}` : null
  const activeVisible =
    active !== null &&
    active.agentId === selectedAgentId &&
    (active.sessionKey === undefined || active.sessionKey === null || active.sessionKey === selectedKey)

  // a LIVE session with no turn of its own in memory (avoiding "more than
  // one line with a glyph"): the last tool streak is the one in progress —
  // the status monitor paints it (a single live line), so it's omitted
  // here to avoid duplicate glyphs. No longer requires native === false:
  // after a mid-turn refresh a NATIVE session loses its `active` (client
  // memory) and ends up in exactly an external session's situation — the
  // monitor derives from the JSONL, the live streak gets absorbed the
  // same way.
  // "Live" uses the SAME truth as ContextColumn (Working ≠ live): a fresh
  // mtime AND an unclosed turn — with a known close (the parser's
  // marker/turnEnded, or a chat-done witnessed in store.turnCloses) the
  // monitor switches to "Worked for X" instead of faking activity for the
  // live window's ~2 minutes.
  const turnCloses = useStore((s) => s.turnCloses)
  const turnClosed = !!detail && (lastTurnClosed(detail.turns) || closedByClient(turnCloses[`${detail.meta.folder}/${detail.meta.id}`], detail.meta.mtime))
  // an open question / a plan waiting for approval: the claude is waiting
  // on YOU, not working — no "Running AskUserQuestion…" clock
  const liveMonitor =
    !activeVisible && !!detail && detail.meta.pendingAsk !== true && (isLive(detail.meta.mtime, nowTick) || toolInFlight(detail.meta, nowTick)) && !turnClosed
  const blocks = useMemo(() => {
    if (!liveMonitor || allBlocks.length === 0) return allBlocks
    const last = allBlocks[allBlocks.length - 1]!
    return last.kind === 'streak' ? allBlocks.slice(0, -1) : allBlocks
  }, [allBlocks, liveMonitor])

  // the last turn index that ALREADY existed when this session view
  // mounted (the `key`-based remount in Chat.tsx guarantees this means
  // "on opening THIS session", not an app-global value). Any turn with an
  // index above this line "just arrived" during the current view and gets
  // animated; the history loaded on open never does.
  const lastPrevIndexRef = useRef<number | null>(null)
  if (lastPrevIndexRef.current === null) {
    lastPrevIndexRef.current = total > 0 ? turns[total - 1]!.index : -1
  }
  const isNewIndex = (index: number): boolean => index > lastPrevIndexRef.current!

  // turn receipts: the open session's, anchored after the last persisted
  // turn with ts <= receipt.ts (lib/receipts.ts). The one for the turn
  // STILL visible as `active` (the window between chat-done and the
  // cleanup/refetch) is excluded from anchoring — it's painted at the end
  // of the live block, exactly where the StatusLine was, so it doesn't jump.
  const receiptsMap = useStore((s) => s.receipts)
  const sessionReceipts = useMemo(() => (selectedKey ? (receiptsMap[selectedKey] ?? []) : []), [receiptsMap, selectedKey])
  const anchoredReceipts = useMemo(
    () =>
      assignReceipts(
        visible,
        sessionReceipts.filter((r) => r.turnId !== active?.turnId),
      ),
    [visible, sessionReceipts, active?.turnId],
  )
  const activeReceipt = active ? (sessionReceipts.find((r) => r.turnId === active.turnId) ?? null) : null

  // "N still running" — ONLY real data: context subagents with no endedAt
  // + THIS session's keep automations with a running run. Only makes
  // sense as the transcript's queue status (the last turn's receipt): an
  // old receipt doesn't get now's truth applied to it. A staleness guard —
  // a background subagent only earns its endedAt when its
  // <task-notification> lands in the SAME JSONL; if the session died
  // first, it would count as "running" forever. A session that's no
  // longer live (mtime past LIVE_MS, or its own turn in progress keeping
  // it fresh) can't claim in-flight work: 0.
  const automations = useStore((s) => s.automations)
  const sessionLive = activeVisible || (!!detail && (isLive(detail.meta.mtime, nowTick) || backgroundWorking(detail.meta, nowTick)))
  const runningNow = !sessionLive
    ? 0
    : (detail?.context?.agents.filter((a) => !a.endedAt).length ?? 0) +
      automations.filter((a) => a.thread.mode === 'keep' && a.thread.sessionId === selected?.id && a.lastRun?.status === 'running').length
  const lastVisibleIndex = visible.length > 0 ? visible[visible.length - 1]!.index : -1

  // ("streaming looks jerky"): the live turn isn't painted in the store's
  // 80ms batch jumps — a smooth reveal with adaptive catch-up
  // (lib/smoothing.ts). The bottom-lock follows the REVEALED text, not the
  // received one: height grows frame by frame and scroll has to keep up.
  // a live transcript with no echo: the active block only paints what's
  // NOT YET persisted in detail.turns — text from liveTrim.chars, chips
  // from liveTrim.tools (store.refetchDelta / lib/active-trim.ts).
  const trim = useStore((s) => s.liveTrim)
  const smoothText = useSmoothText((active?.text ?? '').slice(trim.chars).trimStart(), activeVisible && active?.status === 'streaming')
  const liveTools = active ? active.tools.slice(trim.tools) : []

  const { pinned, scrollToBottom } = useBottomLock(scrollRef, [turns.length, smoothText, active?.tools.length, execOut])

  // saves the scrollHeight BEFORE expanding the window and compensates the
  // scrollTop after the repaint (requestAnimationFrame) — without this,
  // the ~200 new turns inserted ABOVE push down everything the user was
  // looking at (the browser doesn't compensate on its own for a
  // scrollHeight that grows above the visible viewport).
  function expandWindow(): void {
    const el = scrollRef.current
    const heightBefore = el?.scrollHeight ?? 0
    setWindowSize((v) => Math.min(total, v + WINDOW_STEP))
    requestAnimationFrame(() => {
      if (scrollRef.current) compensateScrollAfter(scrollRef.current, heightBefore)
    })
  }

  // a KNOWN conversation whose transcript hasn't arrived yet (selected set,
  // detail null — openSession clears it while fetching): a loader in place,
  // never the "pick a conversation"/project-selector empty states, which
  // would claim there is nothing open.
  if (!detail && selected && !activeVisible && !execOut) {
    return <TranscriptLoading />
  }

  // with no open session and no turn in progress: EmptyState fills the
  // gap — which variant depends on whether there's a team, whether the
  // chosen agent has sessions, or whether one just needs opening/starting.
  if (!detail && !activeVisible && !execOut) {
    const emptyTeam = agents.filter((a) => a.id !== MASTER_ID).length === 0
    const agent = agents.find((a) => a.id === selectedAgentId) ?? null
    if (emptyTeam) {
      return (
        <div className="relative flex-1 overflow-hidden">
          <EmptyState variant="no-agent" />
        </div>
      )
    }
    if (agent) {
      // master with no open session replaces EmptyState with the project
      // selector — regardless of its sessionCount (unlike a normal agent,
      // which only distinguishes "no sessions" from "pick one").
      if (agent.id === MASTER_ID) {
        return (
          <div className="relative flex-1 overflow-hidden">
            <ProjectSelector />
          </div>
        )
      }
      return (
        <div className="relative flex-1 overflow-hidden">
          {agent.sessionCount === 0 ? <EmptyState variant="no-sessions" name={agent.name} /> : <EmptyState variant="choose-session" />}
        </div>
      )
    }
    // there's a team but no agent chosen yet (selectedAgentId null) —
    // Threads.tsx always showed "Choose an agent" for this gap; it was
    // lost in the migration.
    return (
      <div className="relative flex-1 overflow-hidden">
        <EmptyState variant="choose-agent" />
      </div>
    )
  }

  // the root for THIS session's image URLs — turns only carry refs
  // (metadata), the lazy <img> resolves against
  // /api/sessions/<f>/<id>/media/<ref>. With no persisted session there
  // are no refs to resolve (a streaming turn carries no images), '' is inert.
  const mediaBase = selected ? `/api/sessions/${selected.folder}/${selected.id}` : detail ? `/api/sessions/${detail.meta.folder}/${detail.meta.id}` : ''

  // the last exchange's monitor no longer lives at the end of the
  // scrollable flow — it's a persistent strip below the scroller, visible
  // even while reading old turns. Also applies to NATIVE sessions with no
  // turn of their own in memory: after a refresh `active` is lost and the
  // monitor derived from the JSONL is the only truth available.
  // ownReceiptTs avoids a duplicate "Worked for" when THIS client did
  // witness the chat-done (its inline receipt already counts it).
  const externalMonitor = !activeVisible && detail
  const lastOwnReceipt = sessionReceipts.length > 0 ? sessionReceipts[sessionReceipts.length - 1] : undefined

  return (
    <MediaScope base={mediaBase}>
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="relative min-h-0 flex-1">
          <div ref={scrollRef} className="h-full overflow-y-auto px-4 py-6">
            {/* the threads column disappeared (a unified sidebar) — the chat
            absorbs the freed-up width. A step from 46rem→48rem (~2ch at
            15px): keeps the reading line under ~75ch (48rem/15px ≈ 51ch at
            normal weight, with margin to spare) without leaving the text
            stranded in the middle of the screen now that there's more room. */}
            <div className="mx-auto flex max-w-[48rem] flex-col gap-4">
              {hasHidden ? (
                <button
                  type="button"
                  onClick={expandWindow}
                  className="mx-auto rounded-full border border-line px-3 py-1 text-xs text-ink-2 hover:border-terracotta hover:text-terracotta"
                >
                  Show earlier turns
                </button>
              ) : null}

              {blocks.map((b) => {
                const firstIndex = b.kind === 'turn' ? b.turn.index : b.turns[0]!.index
                const lastIndex = b.kind === 'turn' ? b.turn.index : b.turns[b.turns.length - 1]!.index
                // the anchor can land on a tools-only turn that groupTurns
                // merged in the MIDDLE of the streak (a turn ending in
                // tool-only + external activity continuing it) — receipts are
                // collected from ANY index in the block, not just the last
                // one, so none get silently lost.
                const blockReceipts = b.kind === 'turn' ? anchoredReceipts.get(b.turn.index) : b.turns.flatMap((t) => anchoredReceipts.get(t.index) ?? [])
                return (
                  <Fragment key={firstIndex}>
                    {b.kind === 'turn' ? (
                      <Turn turn={b.turn} isNew={isNewIndex(b.turn.index)} limit={limitInfo} />
                    ) : (
                      <ToolStreak turns={b.turns} isNew={isNewIndex(b.turns[0]!.index)} />
                    )}
                    {blockReceipts?.map((r) => (
                      <ReceiptLine
                        key={r.turnId}
                        receipt={r}
                        // the live background count only on the transcript's
                        // queue receipt — it's NOW's truth, not an old turn's
                        // (and with the turn still active, the queue is its own).
                        stillRunning={lastIndex === lastVisibleIndex && !activeVisible ? runningNow : 0}
                      />
                    ))}
                  </Fragment>
                )
              })}

              {activeVisible && active ? (
                <>
                  {/* active.userText can carry memory mode's hidden preamble
                  (Composer prepends it client-side, unlike skills', which
                  the server adds) — stripped the same way as an
                  already-persisted turn (Turn.tsx). */}
                  {!userTextPersisted ? (
                    <div className="ml-auto max-w-[85%] rounded-2xl bg-panel px-4 py-2 text-[15px] whitespace-pre-wrap break-words">
                      {stripAgentContext(active.userText)}
                    </div>
                  ) : null}
                  <div className="w-full">
                    <Markdown text={smoothText} highlight={false} />
                    <span data-testid="cursor-streaming" aria-hidden="true" className="inline-block w-[0.5em] animate-pulse motion-reduce:animate-none">
                      ▌
                    </span>
                    {liveTools.length > 0 ? (
                      <div className="mt-2 flex flex-wrap items-start gap-1.5">
                        {liveTools.map((name, i) => (
                          <ToolChip key={`${name}-${i}`} tool={name} />
                        ))}
                      </div>
                    ) : null}
                    {/* when the turn ends, the status line does NOT vanish —
                    it mutates into its receipt, in the same spot; when
                    `active` clears (100ms + refetch) the same receipt
                    reappears anchored after the already-persisted turn. */}
                    {active.status === 'streaming' ? (
                      <StatusLine />
                    ) : activeReceipt ? (
                      <div className="mt-2">
                        <ReceiptLine receipt={activeReceipt} stillRunning={runningNow} />
                      </div>
                    ) : null}
                  </div>
                </>
              ) : null}

              {/* queued messages go HERE, shaded inside the conversation (like
              claude.ai), not as chips over the input — always at the
              bottom, after the turn in progress, in drain order. */}
              <PendingQueue />

              {execOut ? (
                <div className="rounded-lg bg-panel p-3 font-mono text-xs">
                  {execOut.stdout ? (
                    <div>
                      <div className="mb-1 text-ink-2">stdout</div>
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap">{execOut.stdout}</pre>
                    </div>
                  ) : null}
                  {execOut.stderr ? (
                    <div className="mt-2">
                      <div className="mb-1 text-ink-2">stderr</div>
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap text-terracotta">{execOut.stderr}</pre>
                    </div>
                  ) : null}
                  <div className="mt-2 text-ink-2">
                    exit code: {execOut.code ?? '—'}
                    {execOut.truncated ? ' (truncated)' : ''}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {!pinned && activeVisible ? (
            // aligned to the content COLUMN (max-w-[48rem], same as the rest of
            // the transcript), not the whole scroller — if Sidebar/Threads
            // aren't symmetric, centering against the entire scroller leaves
            // the button off-center relative to the text above it.
            <div className="pointer-events-none absolute inset-x-0 bottom-4 mx-auto flex max-w-[48rem] justify-center px-4">
              <button
                type="button"
                aria-label="scroll to bottom"
                onClick={scrollToBottom}
                className="pointer-events-auto rounded-full bg-terracotta p-2 text-on-terracotta hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
              >
                <ArrowDown size={16} />
              </button>
            </div>
          ) : null}

          {externalMonitor ? (
            // a fade over the scroller's bottom edge: content passing under
            // the monitor strip blends instead of being cut off sharply (no
            // hard border — the Composer doesn't carry one either).
            <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-canvas to-transparent" />
          ) : null}
        </div>

        {externalMonitor && detail ? (
          <div className="shrink-0 px-4 pb-2">
            <div className="mx-auto max-w-[48rem]">
              <ExternalStatus
                turns={detail.turns}
                live={liveMonitor}
                contextTokens={detail.meta.contextTokens}
                model={detail.meta.model}
                queue={detail.meta.queue}
                ownReceiptTs={lastOwnReceipt?.ts}
                harness={detail.meta.harness}
              />
            </div>
          </div>
        ) : null}
      </div>
    </MediaScope>
  )
}
