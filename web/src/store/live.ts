// store/live.ts — the WebSocket side: applyWs (every server event),
// resync after a reconnect (with the turn watchdog), and Knows live
// (version counters, pulse, toast).
import type { StateCreator } from 'zustand'
import { api } from '../lib/api'
import { chainTip } from '../lib/grouping'
import type { KnowsEvent } from '../lib/types'
import { territoriesOf } from '../lib/territory'
import type { State } from './state'
import { WATCHDOG_ALIVE_GRACE_MS, KNOWS_TOAST_MS, isChatEvent, applyCounts, upsertSessionInAgents, removeSessionFromAgents } from './helpers'
import type { ChatEngine } from './engine'
import { pulseOf } from '../lib/turn-pulse'

export type LiveSlice = Pick<
  State,
  | 'connection'
  | 'knowsVersion'
  | 'knowsPulse'
  | 'knowsToast'
  | 'plansVersion'
  | 'siloTick'
  | 'inboxTick'
  | 'turnPulse'
  | 'applyWs'
  | 'resync'
  | 'dismissKnowsToast'
>

export const createLiveSlice =
  (engine: ChatEngine): StateCreator<State, [], [], LiveSlice> =>
  (set, get) => {
    const { refetchDelta, triggerLiveRefetch, purgeBuffer, applyChatEvent, bufferEvent, finishTurn } = engine
    // WS resilience: resync() is idempotent but not reentrant — if two
    // reconnecting→connected transitions arrive nearly back to back (tunnel
    // flapping), the second coalesces into the first instead of duplicating
    // overview+refetch.
    let resyncInFlight = false

    // Knows live: only the VISIBLE agent's events count — the column's agent
    // (the open conversation's) or the agent page's (where the drawer lives).
    // folder '' is global (~/.claude/CLAUDE.md, user skills): every agent
    // knows it. An event with agentId is that agent's alone.
    let knowsToastTimer: ReturnType<typeof setTimeout> | null = null
    function applyKnowsEvent(e: KnowsEvent): void {
      // plans are not a Knows kind: any folder's counter moves (a plan card
      // may show a foreign folder's plan), no toast, no Knows refetch.
      if (e.kind === 'plans') {
        set((st) => ({ plansVersion: { ...st.plansVersion, [e.folder]: (st.plansVersion[e.folder] ?? 0) + 1 } }))
        return
      }
      const kind = e.kind
      const s = get()
      const ids = new Set<string>()
      if (s.detail?.meta.agentId) ids.add(s.detail.meta.agentId)
      if (s.page?.kind === 'agent') ids.add(s.page.id)
      const visible = s.agents.some(
        (a) =>
          ids.has(a.id) &&
          (e.agentId === undefined || e.agentId === a.id) &&
          // any territory counts (folder or folders[]; the watcher emits them
          // normalised) — the raw primary too, for agent memory's own folder.
          (e.folder === '' || e.folder === (a.folder ?? '') || territoriesOf(a).includes(e.folder)),
      )
      if (!visible) return
      const now = Date.now()
      // a file given to ONE conversation is that conversation's (its column
      // block re-reads on the counter), never news about what the agent knows
      if (e.scope === 'conversation') {
        set((st) => ({ knowsVersion: { ...st.knowsVersion, [kind]: st.knowsVersion[kind] + 1 } }))
        return
      }
      set((st) => ({
        knowsVersion: { ...st.knowsVersion, [kind]: st.knowsVersion[kind] + 1 },
        knowsPulse: { ...st.knowsPulse, [kind]: now },
        knowsToast: { kind, name: e.name, scope: e.scope, action: e.action, ts: now },
      }))
      if (knowsToastTimer !== null) clearTimeout(knowsToastTimer)
      knowsToastTimer = setTimeout(() => {
        knowsToastTimer = null
        set({ knowsToast: null })
      }, KNOWS_TOAST_MS)
    }

    return {
      connection: 'connected',
      knowsVersion: { memory: 0, context: 0, skills: 0 },
      plansVersion: {},
      knowsPulse: {},
      knowsToast: null,
      siloTick: 0,
      inboxTick: 0,
      turnPulse: {},

      applyWs(ev) {
        if (ev.ev === 'session') {
          // refresh nowTick here too, not only via App's 30s interval — so a
          // session that starts up RIGHT NOW lights its badge as soon as the
          // event arrives, without waiting on when the next tick lands.
          // what the store knew of this session BEFORE the event: a /clear
          // child is followed only at the birth of its link (below).
          const before =
            get()
              .agents.flatMap((a) => a.sessions)
              .find((s) => s.folder === ev.meta.folder && s.id === ev.meta.id) ?? null
          set((s) => ({ agents: applyCounts(upsertSessionInAgents(s.agents, ev.meta), ev.counts), nowTick: Date.now() }))
          const { selected, active, newChatOpen, pendingConsoleId } = get()
          // the console's new conversation just persisted its first message:
          // this IS the session the open "New conversation" page was waiting
          // for — open it (title, detail, sidebar row). `exact`: no chain walk.
          if (!selected && newChatOpen && pendingConsoleId !== null && ev.meta.id === pendingConsoleId) {
            // naming at birth, console engine: the SDK engine lands the typed
            // title at chat-init (server-side), and THIS is the console's
            // equivalent moment — the session just gained its identity on
            // disk. Same landing path (the manual rename), captured BEFORE
            // openSession resets the draft. Rename first, THEN open: the
            // fetched detail already resolves the manual title, no flash of
            // the raw one.
            const draftTitle = get().newChatTitle?.trim()
            set({ pendingConsoleId: null, newChatTitle: null })
            void (async () => {
              if (draftTitle) await get().renameSession(ev.meta.folder, ev.meta.id, draftTitle)
              await get().openSession(ev.meta.folder, ev.meta.id, { exact: true })
            })()
            return
          }
          // a /clear in the console (or a keep-thread rotation) CONTINUED the
          // open conversation in a new session id: the arriving session is a
          // child of the selected one. The conversation is the chain, and the
          // focus follows its tip — the same rule openSession applies on
          // entry, applied when the tip moves under you. Without it the
          // selected row became a folded ancestor: no highlighted row, a view
          // frozen on the finished transcript. Deliberately
          // reading an 'earlier' entry is untouched — a rotation parents to
          // the TIP, not to the ancestor being read. The tip is the selected
          // session's own chainTip, so the focus moves only when the child is
          // MORE RECENTLY active than the open session (a real rotation is);
          // a stale child's event never steals a live thread.
          // A /clear child is a NEW conversation (its own sidebar row), so
          // `continuation` keeps chainTip from crossing into it — its
          // activity (every message typed in that console) never steals the
          // page from the cleared-away parent being read.
          // Except ONCE, at the birth of the link: the owner just typed
          // /clear in the console they are looking at, the parent is being
          // archived (the sidebar stops listing it), and the new, still
          // empty conversation is where that console is now. Staying put
          // left no highlighted row and a page frozen on a finished
          // transcript. "Birth of the link" = the store did
          // not know this child under this parent before the event (the
          // rotation hook can lose the race against the index: an orphan
          // first, re-announced with its parentKey once absorbed). A child
          // older than the open session is a stale link, never a /clear
          // under you.
          if (selected && ev.meta.id !== selected.id && ev.meta.parentKey === `${selected.folder}/${selected.id}`) {
            const sessions = get().agents.flatMap((a) => a.sessions)
            if (ev.meta.parentKind === 'clear') {
              const linkIsNew = before === null || before.parentKey !== ev.meta.parentKey
              const open = sessions.find((s) => s.folder === selected.folder && s.id === selected.id)
              if (linkIsNew && (!open || ev.meta.mtime >= open.mtime)) {
                void get().openSession(ev.meta.folder, ev.meta.id, { exact: true })
                return
              }
            } else {
              const tip = chainTip(sessions, selected.folder, selected.id, { continuation: true })
              if (tip.folder !== selected.folder || tip.id !== selected.id) {
                void get().openSession(tip.folder, tip.id, { exact: true })
                return
              }
            }
          }
          if (!selected || selected.folder !== ev.meta.folder || selected.id !== ev.meta.id) return
          if (!active) {
            void refetchDelta()
            return
          }
          // a turn active in progress for THIS session: a live transcript, a
          // throttled refetch instead of total silence until chat-done. "Its
          // session" = a sessionKey already set by chat-init, or a new chat
          // (no sessionKey yet) for the same agent as the open session.
          const key = `${selected.folder}/${selected.id}`
          const activeBelongsToThisSession =
            active.sessionKey === key || ((active.sessionKey === undefined || active.sessionKey === null) && active.agentId === ev.meta.agentId)
          if (activeBelongsToThisSession) triggerLiveRefetch()
          return
        }

        if (ev.ev === 'removed') {
          set((s) => ({ agents: applyCounts(removeSessionFromAgents(s.agents, ev.folder, ev.id), ev.counts) }))
          const { selected } = get()
          if (selected && selected.folder === ev.folder && selected.id === ev.id) get().closeSession()
          return
        }

        if (isChatEvent(ev)) {
          set((s) => ({ turnPulse: pulseOf(s.turnPulse, ev, Date.now()) }))
          purgeBuffer()
          const { active } = get()
          if (active && active.turnId === ev.turnId) applyChatEvent(ev)
          else bufferEvent(ev)
        }

        // 'automation' (create/patch/pause/resume) upserts by id; 'run' only
        // touches `automationsPending` (enters if waiting_approval, leaves on
        // any other status) and, if the open detail page owns this run, also
        // `automationRuns` — the same upsert-by-id criterion as the rest of
        // the store (never a full refetch for a live event).
        if (ev.ev === 'automation') {
          set((s) => {
            const exists = s.automations.some((a) => a.id === ev.automation.id)
            const automations = exists ? s.automations.map((a) => (a.id === ev.automation.id ? ev.automation : a)) : [...s.automations, ev.automation]
            return { automations }
          })
          return
        }
        if (ev.ev === 'run') {
          set((s) => {
            const waitingApproval = ev.run.status === 'waiting_approval'
            const wasAlready = s.automationsPending.some((r) => r.id === ev.run.id)
            const automationsPending = waitingApproval
              ? wasAlready
                ? s.automationsPending.map((r) => (r.id === ev.run.id ? ev.run : r))
                : [...s.automationsPending, ev.run]
              : s.automationsPending.filter((r) => r.id !== ev.run.id)
            const pageOwnsIt = s.page?.kind === 'automation' && s.page.id === ev.run.automationId
            const alreadyInRuns = s.automationRuns.some((r) => r.id === ev.run.id)
            const automationRuns = !pageOwnsIt
              ? s.automationRuns
              : alreadyInRuns
                ? s.automationRuns.map((r) => (r.id === ev.run.id ? ev.run : r))
                : [ev.run, ...s.automationRuns]
            // a run that ended may have entered (or healed) the inbox — a
            // failure, a retry on hold — so Home re-fetches the board now
            const ended = ev.run.status !== 'running' && ev.run.status !== 'queued'
            return { automationsPending, automationRuns, ...(ended ? { inboxTick: s.inboxTick + 1 } : {}) }
          })
          return
        }
        if (ev.ev === 'inbox' || ev.ev === 'digest') {
          set((s) => ({ inboxTick: s.inboxTick + 1 }))
          return
        }

        // Auto-resume: upsert/remove by key "folder/sessionId". The
        // rate-limit banner reacts live — a resume gets scheduled and the
        // reassurance line appears, it's cancelled and disappears.
        if (ev.ev === 'pending-resume') {
          const key = `${ev.pending.folder}/${ev.pending.sessionId}`
          set((s) => ({ pendingResumes: { ...s.pendingResumes, [key]: ev.pending } }))
          return
        }
        if (ev.ev === 'pending-resume-removed') {
          const key = `${ev.folder}/${ev.id}`
          set((s) => {
            if (!(key in s.pendingResumes)) return {}
            const rest = { ...s.pendingResumes }
            delete rest[key]
            return { pendingResumes: rest }
          })
          return
        }
        if (ev.ev === 'knows') {
          applyKnowsEvent(ev.knows)
          return
        }
        if (ev.ev === 'silos') {
          set((s) => ({ siloTick: s.siloTick + 1 }))
          // an active silo's state/freshness/counts may have moved too — the
          // descriptors ride the same signal (tiny GET, idempotent).
          void get().loadSilos()
          return
        }
        // 'hello' / 'pong' → no-op
      },

      async resync() {
        // single-flight: two reconnecting→connected transitions arriving
        // nearly back to back (a tunnel flap) coalesce into the resync
        // already in progress — it's fresh enough, no need to duplicate the work.
        if (resyncInFlight) return
        resyncInFlight = true
        try {
          await get().loadOverview()
          void get().loadAutomations() // the same resync after a WS drop — fire-and-forget, doesn't block the rest
          // Knows (column block, drawer) fetched while the server was down
          // stayed empty for good — and any `knows` event lost with the WS
          // never arrives: every kind re-fetches, quietly (no pulse, no toast).
          set((st) => ({ knowsVersion: { memory: st.knowsVersion.memory + 1, context: st.knowsVersion.context + 1, skills: st.knowsVersion.skills + 1 } }))
          // if an automation's detail page is open, its Runs only used to
          // update via the live WS 'run' event (store.ts's 'run' branch,
          // gated on pageOwnsIt) — any run that ran WHILE the WS was down
          // used to get lost until the owner navigated away and back to
          // open the automation. The same fire-and-forget criterion as
          // loadAutomations.
          const pageAtResync = get().page
          // ('new' is the editor creating one — there are no runs to read)
          if (pageAtResync?.kind === 'automation' && pageAtResync.id !== 'new') void get().loadAutomationRuns(pageAtResync.id)
          // the transcript part (refetchDelta) DOES depend on having an open
          // session — with no selected there's nothing to refetch. The
          // watchdog below, on the other hand, only needs `active`: a new
          // chat (its POST already resolved, chat-init not arrived yet) has
          // no `selected` yet and must NOT skip the watchdog, or `active`
          // would stay 'streaming' forever if the turn finishes during a WS drop.
          if (get().selected) await refetchDelta()

          const activeAtResync = get().active
          if (!activeAtResync || activeAtResync.status !== 'streaming') return
          const turnId = activeAtResync.turnId

          // a watchdog with the server's truth: the "did the persisted
          // transcript advance?" heuristic is useless on a turn with several
          // tool calls (intermediate results don't persist a turn) — the
          // ChatService is asked directly whether the turn is genuinely still inflight.
          let alive: boolean
          try {
            ;({ alive } = await api.chatAlive(turnId))
          } catch {
            return // if the check fails, don't risk closing a turn that might still be alive
          }
          if (alive) return // the server confirms it's still running — the live refetch already paints whatever arrives

          // the server says it's no longer inflight: it's given a grace
          // period in case the real chat-done is in transit (a WS buffer) and
          // wins the race against this timeout — the guard below respects that.
          setTimeout(() => {
            const s = get()
            if (!s.active || s.active.turnId !== turnId || s.active.status !== 'streaming') return
            set({ active: { ...s.active, status: 'done' } })
            finishTurn(turnId)
          }, WATCHDOG_ALIVE_GRACE_MS)
        } finally {
          resyncInFlight = false
        }
      },

      dismissKnowsToast() {
        if (knowsToastTimer !== null) clearTimeout(knowsToastTimer)
        knowsToastTimer = null
        if (get().knowsToast !== null) set({ knowsToast: null })
      },
    }
  }
