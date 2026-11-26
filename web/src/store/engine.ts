// store/engine.ts — the chat turn engine: sending, the WS event buffer,
// streaming batches, live refetch, finishing a turn.
import type { StoreApi } from 'zustand'
import { api } from '../lib/api'
import { activeTrim, NO_TRIM } from '../lib/active-trim'
import { pastVerbForTurn } from '../lib/thinking-verbs'
import type { ConvPrefs, Turn } from '../lib/types'
import { stepDesc } from '../lib/tool-summary'
import { resolveEffective } from '../lib/cockpit'
import type { ActiveStep, ChatTurnState, TurnReceipt } from './types'
import type { State } from './state'
import {
  BUFFER_TTL_MS,
  CLEAR_ACTIVE_DELAY_MS,
  RECEIPTS_CAP,
  LIVE_REFETCH_THROTTLE_MS,
  BATCH_FLUSH_MS,
  type ChatEvent,
  type BatchableEvent,
  isBatchable,
  markSeenInAgents,
} from './helpers'
import { sessionViewOf } from './selectors'

// the chat turn engine: the store's private machinery, created ONCE per store
// (see ../store.ts) and shared by the slices that need it. It owns the
// closure state the turn lifecycle lives on — the event-before-202 buffer,
// the streaming batch, the throttled live refetch — exactly as it lived
// inside the old single `create()` callback.
export function createChatEngine(set: StoreApi<State>['setState'], get: StoreApi<State>['getState']) {
  // a buffer for the event-arrives-before-the-202 race: turnId -> pending events to apply.
  const buffer = new Map<string, { ev: ChatEvent; ts: number }[]>()
  // turns the user explicitly cancelled: the chat-error or the error-subtype
  // chat-done that arrives after interrupting must not show up as a global
  // error (it's expected noise from the cancel itself).
  const interruptedTurns = new Set<string>()

  // live transcript: while a turn is active, each 'session' event for ITS
  // session fires at most one refetch every LIVE_REFETCH_THROTTLE_MS. A
  // trailing edge with no accumulation: if several 'session' events arrive
  // within the window, ONE deferred refetch is scheduled for the deadline
  // (not one per event). `liveRefetchInFlight` avoids overlapping with
  // chat-done's unconditional final refetch (both read detail.total when
  // called — a known minor edge case of overlapping refetches; this is the simple mitigation).
  let lastLiveRefetch = 0
  let liveRefetchTimer: ReturnType<typeof setTimeout> | null = null
  let liveRefetchInFlight = false

  // streaming performance: chat-delta/chat-thinking do NOT fire a set() per
  // event — they accumulate here and a single pending BATCH_FLUSH_MS
  // setTimeout applies them all at once (one render per burst instead of
  // one per event; a typical agentic turn sends ~12 deltas in a row). The
  // other chat-* events (init/tool/done/error) force the buffer's flush
  // BEFORE applying themselves — arrival order is preserved because the
  // flush applies what's accumulated and only then processes the new event.
  let pendingBatch: BatchableEvent[] = []
  let batchTimer: ReturnType<typeof setTimeout> | null = null

  function clearBatchTimer(): void {
    if (batchTimer !== null) {
      clearTimeout(batchTimer)
      batchTimer = null
    }
  }

  function applyDelta(acc: ChatTurnState, ev: BatchableEvent): ChatTurnState {
    if (ev.ev === 'chat-delta') return { ...acc, text: acc.text + ev.text, lastEvent: 'delta' }
    if (ev.ev === 'chat-thinking') return { ...acc, thinkingText: (acc.thinkingText ?? '') + ev.text, lastEvent: 'thinking' }
    // chat-usage: accumulated as-is from the SDK (not a delta to add up)
    // and doesn't touch lastEvent — it isn't a StatusLine phase, just a
    // counter. contextTokens doesn't always arrive on the same event — a
    // chat-usage with no such field must not erase the previously stored value,
    // so it's only overwritten when it arrives defined.
    return { ...acc, outputTokens: ev.outputTokens, ...(ev.contextTokens !== undefined ? { contextTokens: ev.contextTokens } : {}) }
  }

  // applies everything accumulated in pendingBatch with ONE set(), in
  // order. If active no longer exists (the turn was cleared while the
  // timeout was waiting) the buffer is simply discarded — there's nothing
  // to paint. Like the rest of this file's mutations, turnId is revalidated
  // before applying: in the CLEAR_ACTIVE_DELAY_MS window between a
  // chat-done and `active`'s actual cleanup, a direct send can start turn B
  // while a buffered delta from turn A is still pending — without this
  // filter, A's flush would bleed text onto B's active.
  function flushBatch(): void {
    clearBatchTimer()
    if (pendingBatch.length === 0) return
    const events = pendingBatch
    pendingBatch = []
    const current = get().active
    if (!current) return
    const own = events.filter((ev) => ev.turnId === current.turnId)
    if (own.length === 0) return
    set({ active: own.reduce(applyDelta, current) })
  }

  function scheduleBatchFlush(): void {
    if (batchTimer !== null) return // one is already pending — this event joins the same flush
    batchTimer = setTimeout(() => {
      batchTimer = null
      flushBatch()
    }, BATCH_FLUSH_MS)
  }

  function clearLiveRefetchTimer(): void {
    if (liveRefetchTimer !== null) {
      clearTimeout(liveRefetchTimer)
      liveRefetchTimer = null
    }
  }

  function purgeBuffer(): void {
    const now = Date.now()
    for (const [turnId, events] of buffer) {
      const fresh = events.filter((e) => now - e.ts < BUFFER_TTL_MS)
      if (fresh.length === 0) buffer.delete(turnId)
      else buffer.set(turnId, fresh)
    }
  }

  function bufferEvent(ev: ChatEvent): void {
    const list = buffer.get(ev.turnId) ?? []
    list.push({ ev, ts: Date.now() })
    buffer.set(ev.turnId, list)
  }

  function drainBuffer(turnId: string): ChatEvent[] {
    purgeBuffer()
    const list = buffer.get(turnId) ?? []
    buffer.delete(turnId)
    return list.map((e) => e.ev)
  }

  // the core of sending a chat: used both by send() (dest = the CURRENT
  // selection) and by draining the queue (dest = the snapshot captured
  // when queued) — never reads selectedAgentId/selected, so the drain
  // can't be diverted to wherever the user has navigated in the meantime.
  // Returns whether the turn was actually POSTed (true) or the request threw
  // (false) — the queue drain relies on this to not strand later messages when
  // one send fails (a network blip, or the dev server restarting mid-drain).
  async function sendTo(
    dest: { agentId: string; session: { folder: string; id: string } | null; cwd?: string; overrides?: ConvPrefs; convPrefs?: ConvPrefs; title?: string },
    text: string,
    memoryPath?: string,
  ): Promise<boolean> {
    set({ execOut: null })
    // an honest echo: what the cascade requests for THIS turn — for a
    // resume, the server also applies the destination conversation's
    // prefs. Those prefs travel in the dest's SNAPSHOT (captured on
    // send/queue), never from get() at drain time — the same contract as
    // session/cwd/overrides: the drain doesn't read the current selection.
    // chat-init will compare.
    const destAgent = get().agents.find((a) => a.id === dest.agentId)
    const effective = resolveEffective(destAgent?.model, dest.session ? (dest.convPrefs ?? {}) : {}, dest.overrides ?? {}, destAgent?.provider)
    try {
      // note: api.chat with an explicit `undefined` 4th argument DOES
      // differ from omitting it for the test mocks (toHaveBeenCalledWith
      // doesn't ignore a trailing undefined) — the whole argument is
      // omitted when there's no cwd.
      const hasOverrides = dest.overrides !== undefined && Object.keys(dest.overrides).length > 0
      const { turnId } =
        dest.title !== undefined
          ? await api.chat(dest.agentId, text, dest.session ?? undefined, dest.cwd, hasOverrides ? dest.overrides : undefined, dest.title)
          : hasOverrides
            ? await api.chat(dest.agentId, text, dest.session ?? undefined, dest.cwd, dest.overrides)
            : dest.cwd !== undefined
              ? await api.chat(dest.agentId, text, dest.session ?? undefined, dest.cwd)
              : await api.chat(dest.agentId, text, dest.session ?? undefined)
      set({
        active: {
          turnId,
          agentId: dest.agentId,
          text: '',
          tools: [],
          status: 'streaming',
          // the best client knowledge at send time — a continuation names
          // its conversation NOW (the column/transcript scope by it);
          // chat-init overwrites with the server's truth (a fork of an
          // external session lands on a NEW id).
          sessionKey: dest.session ? `${dest.session.folder}/${dest.session.id}` : null,
          userText: text,
          thinkingText: '',
          lastEvent: 'init',
          startedAt: Date.now(),
          requested: { ...(effective.model !== undefined ? { model: effective.model } : {}), permissionMode: effective.permissionMode },
          ...(memoryPath !== undefined ? { memoryPath } : {}),
        },
        userTextPersisted: false,
        liveTrim: NO_TRIM,
      })
      // this turn's WS events could have arrived before this POST resolved.
      for (const ev of drainBuffer(turnId)) applyChatEvent(ev)
      return true
    } catch (e) {
      // don't lose the message: the Composer restores it from failedDraft,
      // but only when the visible agent is dest.agentId.
      set({ error: e instanceof Error ? e.message : String(e), failedDraft: { agentId: dest.agentId, text } })
      return false
    }
  }

  // Pop the head of the queue and send it with the destination it captured
  // when it was queued (never the current selection). If the send FAILS, the
  // failed turn never starts, so no chat-done will fire to pump the queue —
  // re-insert the item at the front (nothing is lost, the error is surfaced by
  // sendTo) and stop, rather than dropping it and silently stranding every
  // message behind it. The next successful send/turn re-pumps the queue.
  async function drainNext(): Promise<void> {
    const { queue } = get()
    const first = queue[0]
    if (!first) return
    set({ queue: queue.slice(1) })
    const ok = await sendTo(
      {
        agentId: first.agentId,
        session: first.session,
        cwd: first.cwd,
        ...(first.overrides !== undefined ? { overrides: first.overrides } : {}),
        ...(first.convPrefs !== undefined ? { convPrefs: first.convPrefs } : {}),
        ...(first.title !== undefined ? { title: first.title } : {}),
      },
      first.text,
      first.memoryPath,
    )
    if (!ok) set((s) => ({ queue: [first, ...s.queue] }))
  }

  // best effort: a step opened by chat-tool may not carry a `desc` (the
  // startup content_block arrives empty/partial) — when the live refetch
  // brings turns with persisted toolUses, the most recent one matching by
  // name is used to fill in the step that still has no description. Never
  // blocks anything: with no match, the step stays as it was.
  // Steps and toolUses line up FROM THE END per name: the last Bash step
  // takes the last persisted Bash, the one before it the one before — so
  // three Bash in a row show three commands, not the last one three times.
  function enrichSteps(steps: ActiveStep[] | undefined, newTurns: Turn[]): ActiveStep[] | undefined {
    if (!steps || steps.length === 0) return steps
    const toolUses = newTurns.flatMap((t) => t.toolUses ?? [])
    if (toolUses.length === 0) return steps
    const seen = new Map<string, number>()
    const out = [...steps]
    for (let i = out.length - 1; i >= 0; i--) {
      const p = out[i]!
      const k = seen.get(p.name) ?? 0
      seen.set(p.name, k + 1)
      if (p.desc !== null) continue
      const same = toolUses.filter((tu) => tu.name === p.name)
      const match = same[same.length - 1 - k]
      const desc = match ? stepDesc(match.input) : null
      if (desc !== null) out[i] = { ...p, desc }
    }
    return out
  }

  // a delta refetch of the open session: new turns since detail.total.
  async function refetchDelta(): Promise<void> {
    const { selected, detail } = get()
    if (!selected) return
    const since = detail?.total ?? 0
    const patch = await api.sessionDetail(selected.folder, selected.id, since)
    set((s) => {
      if (!s.selected || s.selected.folder !== selected.folder || s.selected.id !== selected.id) return {}
      // dedupe by index: the throttled refetch and chat-done's unconditional
      // final refetch can overlap (both read since=detail.total when
      // called, before either resolves) and return the same turn twice —
      // don't concatenate what's already there.
      const existing = new Set((s.detail?.turns ?? []).map((t) => t.index))
      const newTurns = patch.turns.filter((t) => !existing.has(t.index))
      const turns = [...(s.detail?.turns ?? []), ...newTurns]
      // an echo-free live transcript: the trim generalizes the old
      // userTextPersisted — before, the optimistic bubble only hid if the
      // echo was the LAST turn, so it REAPPEARED as soon as the turn in
      // progress's first assistant turn landed; and streamed text/chips
      // never deduplicated (the same content stayed doubled until
      // chat-done). activeTrim finds the echo by skipping interSession
      // peers and strips the skills/memory preambles on both sides
      // (stripAgentContext, see lib/agent-context.ts) — the same nuances as
      // the logic it replaces.
      const trim = s.active ? activeTrim(turns, s.active.userText, s.active.text) : NO_TRIM
      const userTextPersisted = trim.echoed
      const enrichedSteps = s.active?.steps ? enrichSteps(s.active.steps, newTurns) : s.active?.steps
      // Everything but `turns` in a delta patch is COMPLETE (the server
      // computes context, subagents, execution… regardless of `since`), so
      // the patch replaces the previous detail field by field and a field
      // it lacks keeps its previous value. Listing fields by hand lost one
      // each time a field was added: `context` once (the whole column went
      // empty), then `execution` (Executing fell back to a plans/*.plan.json
      // count — "14 of 26" flickering with the record's "8 of 17").
      return {
        detail: { ...s.detail, ...patch, turns },
        userTextPersisted,
        liveTrim: trim,
        ...(s.active && enrichedSteps !== s.active.steps ? { active: { ...s.active, steps: enrichedSteps } } : {}),
      }
    })
  }

  // a throttled version of refetchDelta for 'session' with a turn active in
  // progress: records the instant and delegates to refetchDelta, guarded
  // against overlapping with chat-done's unconditional final refetch.
  async function liveRefetchNow(): Promise<void> {
    if (liveRefetchInFlight) return
    liveRefetchInFlight = true
    lastLiveRefetch = Date.now()
    try {
      await refetchDelta()
    } catch {
      // fire-and-forget (called with `void` from triggerLiveRefetch): a
      // failed live refetch must not surface as an unhandled rejection —
      // the next 'session' event or chat-done's final refetch already retry on their own.
    } finally {
      liveRefetchInFlight = false
    }
  }

  function triggerLiveRefetch(): void {
    const now = Date.now()
    if (now - lastLiveRefetch >= LIVE_REFETCH_THROTTLE_MS) {
      void liveRefetchNow()
      return
    }
    if (liveRefetchTimer !== null) return // one is already scheduled (trailing edge, no accumulation)
    const wait = LIVE_REFETCH_THROTTLE_MS - (now - lastLiveRefetch)
    liveRefetchTimer = setTimeout(() => {
      liveRefetchTimer = null
      void liveRefetchNow()
    }, wait)
  }

  // the shared close path for a finished turn: an unconditional final
  // refetch + clearing active (with a small delay so the UI doesn't
  // flicker) + draining the queue's first entry, if anything is waiting.
  // Used both by the real chat-done (below) and by resync()'s watchdog when
  // the server confirms the turn is no longer inflight and the real
  // chat-done was lost — both paths must behave IDENTICALLY.
  function finishTurn(turnId: string): void {
    clearLiveRefetchTimer() // the final refetch below makes this unnecessary
    // marking unread is decided HERE because finishTurn is the single
    // completion path (chat-done, resync's watchdog and chat-error all go
    // through here). Doesn't mark it when the turn belongs to the selected
    // agent AND the tab is visible (the user is already watching it
    // finish) — any other combination does.
    const turn = get().active
    if (turn && turn.turnId === turnId) {
      // Working != live: this client KNOWS the turn ended — the close is
      // recorded per session so ContextColumn doesn't keep saying "Working"
      // during the live window (~2 min) after it finishes.
      const closeKey = turn.sessionKey
      if (closeKey) {
        set((s) => ({ turnCloses: { ...s.turnCloses, [closeKey]: Date.now() } }))
      }
      const alreadyVisible = turn.agentId === get().selectedAgentId && !document.hidden
      // a finished automation run is not a reply waiting for you: it never
      // lights the agent's unread. The run's conversation
      // carries `origin` in the overview; a run that ASKS reaches you
      // through pendingAsk / Needs you, not through this dot.
      const slash = closeKey ? closeKey.indexOf('/') : -1
      // A conversation Silos once opened for a message (origin 'message',
      // history) is not a reply to you either: its answer reaches you on the message.
      const bornOfRun =
        closeKey && slash > 0 ? sessionViewOf(get().agents, { folder: closeKey.slice(0, slash), id: closeKey.slice(slash + 1) })?.origin !== undefined : false
      if (!alreadyVisible && !bornOfRun) {
        set((s) => ({ unreadAgentIds: new Set(s.unreadAgentIds).add(turn.agentId) }))
      }
      // durable unseen: if the turn that just finished belongs to the OPEN
      // and visible conversation, the owner is watching it right now → mark
      // it seen again (durably) and clear its optimistic dot. Without this,
      // the durable dot would reappear on the row you're looking at as soon
      // as the agent writes (mtime > lastSeen) — the same "alreadyVisible"
      // criterion that governs the in-memory pulse, applied to the durable layer.
      if (alreadyVisible && turn.sessionKey) {
        const i = turn.sessionKey.indexOf('/')
        if (i > 0) {
          const folder = turn.sessionKey.slice(0, i)
          const id = turn.sessionKey.slice(i + 1)
          const sel = get().selected
          if (sel && sel.folder === folder && sel.id === id) {
            void Promise.resolve(api.markSeen(folder, id)).catch(() => {})
            set((s) => ({ agents: markSeenInAgents(s.agents, folder, id) }))
          }
        }
      }
      // a memory-edit turn finished — AgentPage/MemoryDrawer, if it has
      // THAT file open, reloads its content (see its memorySaved useEffect).
      if (turn.memoryPath !== undefined) {
        set({ memorySaved: { path: turn.memoryPath, ts: Date.now() } })
      }
    }
    void refetchDelta()
    setTimeout(() => {
      if (get().active?.turnId !== turnId) return
      set({ active: null, liveTrim: NO_TRIM })
      // Drain the next queued message with the destination it captured WHEN
      // QUEUED, not the current selectedAgentId/selected (the user may have
      // navigated to another agent/session while this turn was finishing).
      void drainNext()
    }, CLEAR_ACTIVE_DELAY_MS)
  }

  function applyChatEvent(ev: ChatEvent): void {
    if (isBatchable(ev)) {
      const current = get().active
      if (!current || current.turnId !== ev.turnId) return
      pendingBatch.push(ev)
      scheduleBatchFlush()
      return
    }
    // chat-init/tool/done/error: forces the flush of what's accumulated
    // BEFORE applying itself — so a tool that arrives after two pending
    // deltas leaves both the deltas' text AND the tool applied, in that order.
    flushBatch()
    const current = get().active
    if (!current || current.turnId !== ev.turnId) return
    switch (ev.ev) {
      case 'chat-init': {
        const sel = get().selected
        // fork: the open session had an id and the turn starts on ANOTHER
        // one (continuing an external session as a new branch). `detail`
        // stays the old session's until chat-done's refetch — if it isn't
        // cleared now, its banner (e.g. "terminal session") stays stuck over
        // the new branch for the whole stream.
        const isFork = sel !== null && sel.id !== ev.sessionId
        // a new chat (newChatOpen) already has a genuinely persisted
        // session as soon as chat-init arrives — the flag turns off
        // (selected alone already sustains the CONVERSATION VIEW).
        if (!sel || isFork) set({ selected: { folder: ev.folder, id: ev.sessionId }, newChatOpen: false })
        // slash menu: THIS session's real commands (if the init brought
        // them) are cached under its key — the composer will offer them in
        // its '/' menu. A REPLACE of the entry (not a merge): the SDK
        // resends the full list.
        if (ev.slashCommands && ev.slashCommands.length > 0) {
          const key = `${ev.folder}/${ev.sessionId}`
          set((s) => ({ slashCommandsBySession: { ...s.slashCommandsBySession, [key]: ev.slashCommands! } }))
        }
        set({
          active: {
            ...current,
            sessionKey: `${ev.folder}/${ev.sessionId}`,
            // an honest echo: the truth of the process that started —
            // CockpitChips compares it against active.requested.
            echo: {
              ...(ev.model !== undefined ? { model: ev.model } : {}),
              ...(ev.permissionMode !== undefined ? { permissionMode: ev.permissionMode } : {}),
            },
          },
          ...(isFork ? { detail: null } : {}),
        })
        // a NEW chat already has a real conversation now — the pending
        // prefs (set before the first send) are assigned to its
        // folder/sessionId key (fire-and-forget persistence, the same
        // criterion as setConversationPref) and become the open
        // conversation's convPrefs.
        const pendingPrefs = get().pendingConvPrefs
        if (!sel && Object.keys(pendingPrefs).length > 0) {
          set({ convPrefs: pendingPrefs, pendingConvPrefs: {} })
          api.conversationPrefs.patch(ev.folder, ev.sessionId, pendingPrefs).catch((e: unknown) => {
            console.warn('failed to save the conversation preference:', e)
          })
        }
        // a fork changes the conversation's KEY — the visible convPrefs
        // were the origin key's and the shield could lie in the dangerous
        // direction (showing plan while actually running bypass). An
        // immediate reset + refetch of the new key (the server already
        // copied the origin's inheritance in its chat-init, so whatever
        // comes back is THIS branch's truth). The same async+try criterion as openSession.
        if (isFork) {
          set({ convPrefs: {} })
          void (async () => {
            try {
              const prefs = await api.conversationPrefs.get(ev.folder, ev.sessionId)
              if (!prefs) return
              const sel2 = get().selected
              if (sel2 && sel2.folder === ev.folder && sel2.id === ev.sessionId) set({ convPrefs: prefs })
            } catch {
              /* no prefs → {} already set */
            }
          })()
        }
        break
      }
      case 'chat-tool': {
        const now = Date.now()
        const isSubagent = ev.name === 'Task' || ev.name === 'Agent'
        // a sequential heuristic (v1): opening a new step closes any
        // previous step that was still open — a turn doesn't model
        // parallel tool calls.
        const closedSteps = (current.steps ?? []).map((p) => (p.end === null ? { ...p, end: now } : p))
        const newStep: ActiveStep = { name: ev.name, isSubagent, desc: stepDesc(ev.input), start: now, end: null }
        set({
          active: { ...current, tools: [...current.tools, ev.name], lastEvent: 'tool', steps: [...closedSteps, newStep] },
        })
        break
      }
      case 'chat-done': {
        // the SDK's result can arrive as an error 'result' (interrupt, max
        // turns, budget…) without going through an exception/chat-error.
        const isError = ev.subtype.startsWith('error')
        const wasInterrupted = interruptedTurns.has(ev.turnId)
        if (wasInterrupted) interruptedTurns.delete(ev.turnId)
        // the turn's receipt: only turns that finished WELL, with a
        // measured startedAt and a known session — an interrupted/error
        // turn leaves no "Brewed for X" (that would lie: it didn't finish).
        if (!isError && current.startedAt !== undefined && current.sessionKey) {
          const key = current.sessionKey
          const receipt: TurnReceipt = {
            turnId: ev.turnId,
            verb: pastVerbForTurn(ev.turnId),
            elapsedMs: Date.now() - current.startedAt,
            ...(current.outputTokens !== undefined ? { outputTokens: current.outputTokens } : {}),
            ts: Date.now(),
          }
          set((s) => ({
            receipts: { ...s.receipts, [key]: [...(s.receipts[key] ?? []), receipt].slice(-RECEIPTS_CAP) },
          }))
        }
        // a FAILED turn leaves its trace too — without it the failure lives
        // only in the 8s ErrorStrip toast and vanishes for anyone not
        // watching. Interrupted ≠ failed: the user chose that outcome.
        if (isError && !wasInterrupted && current.sessionKey) {
          const key = current.sessionKey
          const receipt: TurnReceipt = {
            turnId: ev.turnId,
            verb: pastVerbForTurn(ev.turnId),
            elapsedMs: current.startedAt !== undefined ? Date.now() - current.startedAt : 0,
            ts: Date.now(),
            error: ev.subtype,
          }
          set((s) => ({
            receipts: { ...s.receipts, [key]: [...(s.receipts[key] ?? []), receipt].slice(-RECEIPTS_CAP) },
          }))
        }
        set({
          active: { ...current, status: isError ? 'error' : 'done', costUsd: ev.costUsd },
          ...(isError && !wasInterrupted ? { error: ev.subtype } : {}),
        })
        finishTurn(ev.turnId)
        break
      }
      case 'chat-error': {
        // the SDK's exception path (unlike chat-done with an error subtype,
        // above): must finish the turn IDENTICALLY — otherwise the queue
        // never drains and the pending live-refetch timer is left hanging.
        const wasInterrupted = interruptedTurns.has(ev.turnId)
        if (wasInterrupted) interruptedTurns.delete(ev.turnId)
        // same durable-trace rule as chat-done's error subtype: the SDK's
        // exception path often persists NOTHING to the JSONL, so this
        // failed receipt is the only record the conversation will have.
        if (!wasInterrupted && current.sessionKey) {
          const key = current.sessionKey
          const receipt: TurnReceipt = {
            turnId: ev.turnId,
            verb: pastVerbForTurn(ev.turnId),
            elapsedMs: current.startedAt !== undefined ? Date.now() - current.startedAt : 0,
            ts: Date.now(),
            error: ev.error,
          }
          set((s) => ({
            receipts: { ...s.receipts, [key]: [...(s.receipts[key] ?? []), receipt].slice(-RECEIPTS_CAP) },
          }))
        }
        set({
          active: { ...current, status: 'error', error: ev.error },
          ...(wasInterrupted ? {} : { error: ev.error }),
        })
        finishTurn(ev.turnId)
        break
      }
    }
  }

  return { interruptedTurns, sendTo, refetchDelta, triggerLiveRefetch, clearLiveRefetchTimer, purgeBuffer, bufferEvent, applyChatEvent, finishTurn }
}

export type ChatEngine = ReturnType<typeof createChatEngine>
