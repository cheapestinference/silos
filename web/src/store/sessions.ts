// store/sessions.ts — agents and their conversations: the overview,
// the selected agent and open conversation (its detail), the sidebar list,
// unread, and the new-conversation draft (title, pending console).
import type { StateCreator } from 'zustand'
import { api } from '../lib/api'
import { chainTip } from '../lib/grouping'
import { MASTER_ID } from '../lib/constants'
import { signInAgentOf } from '../lib/home'
import type { SessionDetail } from '../lib/types'
import { readSidebarList, writeSidebarList } from '../lib/tasks-prefs'
import type { Page } from './types'
import type { State } from './state'
import { renameSessionInAgents, markSeenInAgents, WARMING_RETRY_MS } from './helpers'
import type { ChatEngine } from './engine'

export type SessionsSlice = Pick<
  State,
  | 'agents'
  | 'warming'
  | 'serverBuild'
  | 'home'
  | 'selectedAgentId'
  | 'selected'
  | 'detail'
  | 'filter'
  | 'sidebarList'
  | 'unreadAgentIds'
  | 'nowTick'
  | 'chosenProject'
  | 'newChatOpen'
  | 'newChatTitle'
  | 'pendingConsoleId'
  | 'consoleCue'
  | 'readingSession'
  | 'loadOverview'
  | 'selectAgent'
  | 'openSession'
  | 'closeSession'
  | 'renameSession'
  | 'setFilter'
  | 'setSidebarList'
  | 'chooseProject'
  | 'readSession'
  | 'closeReading'
  | 'startNewConversation'
  | 'setNewChatTitle'
  | 'setPendingConsole'
  | 'askAgentAboutFile'
  | 'askSignIn'
  | 'pinConsoleCue'
  | 'dropConsoleCue'
>

export const createSessionsSlice =
  (engine: ChatEngine): StateCreator<State, [], [], SessionsSlice> =>
  (set, get) => {
    const { clearLiveRefetchTimer } = engine
    // the pending re-read of a partial overview (see loadOverview).
    let warmingRetry: ReturnType<typeof setTimeout> | null = null

    return {
      agents: [],
      warming: false,
      home: '',
      selectedAgentId: null,
      selected: null,
      detail: null,
      filter: '',
      sidebarList: readSidebarList(),
      unreadAgentIds: new Set(),
      nowTick: Date.now(),
      chosenProject: null,
      readingSession: null,
      newChatOpen: false,
      newChatTitle: null,
      pendingConsoleId: null,
      consoleCue: null,

      async loadOverview() {
        const ov = await api.overview()
        set({ agents: ov.agents, warming: ov.warming, home: ov.home ?? '', serverBuild: ov.build })
        // a list read while the server's index is still warming (right after
        // a restart, the reconnect resync lands there) is PARTIAL, and nothing
        // else reloads it: "indexing sessions…" stayed under the logo for
        // good. Ask again until the index is ready — one
        // timer at a time.
        if (ov.warming && warmingRetry === null) {
          warmingRetry = setTimeout(() => {
            warmingRetry = null
            void get()
              .loadOverview()
              .catch(() => undefined)
          }, WARMING_RETRY_MS)
        }
        if (!get().selectedAgentId) {
          const candidate = ov.agents.find((a) => a.id !== MASTER_ID && a.sessions.length > 0)
          if (candidate) set({ selectedAgentId: candidate.id })
        }
      },

      selectAgent(id) {
        set((s) => {
          // clicking an agent's row in the Sidebar ALWAYS navigates to its
          // AGENT DOSSIER — the full page (header plate + facets, landing on
          // Sessions), never straight to a conversation. Starting to chat is
          // now an explicit act (clicking a #topic or "+ New conversation"),
          // so this no longer depends on whether the agent has sessions or
          // not (the dossier itself is reachable with a single tap, whether
          // it has sessions or not).
          //
          // Closes any conversation that was open (selected/detail/
          // newChatOpen) — otherwise a different agent than that
          // session's real owner could end up showing someone ELSE's
          // conversation (selected was never touched by selectAgent before;
          // see openSession, which now does the reverse path: it syncs
          // selectedAgentId/page to the REAL agent owning the session being opened).
          //
          // chosenProject also resets — it belonged to the chat that was
          // being composed on the previous agent.
          const page: Page = { kind: 'agent', id }
          const base = {
            selectedAgentId: id,
            execOut: null,
            mobileView: 'chat' as const,
            chosenProject: null,
            selected: null,
            detail: null,
            newChatOpen: false,
            newChatTitle: null,
            agentFrom: null,
            viewingFile: null,
            knowsDrawer: null,
            providerPanel: null,
            page,
            tab: 'threads' as const,
            lastAgentId: id,
            // the visible cascade belonged to the previous conversation.
            convPrefs: {},
            pendingConvPrefs: {},
            turnOverrides: {},
          }
          // remembered so the rail's "Agents" preset returns here.
          if (!s.unreadAgentIds.has(id)) return base
          const unreadAgentIds = new Set(s.unreadAgentIds)
          unreadAgentIds.delete(id)
          return { ...base, unreadAgentIds }
        })
      },

      async openSession(folder, id, opts) {
        // follow the chain to where the conversation IS now (a `--resume`
        // fork wrote a newer file) — unless the caller wants exactly this
        // one (reading where a conversation continued from). Never across a
        // /clear: that started a new conversation, and this one reads as
        // its own transcript.
        if (!opts?.exact) {
          const tip = chainTip(
            get().agents.flatMap((a) => a.sessions),
            folder,
            id,
            { continuation: true },
          )
          folder = tip.folder
          id = tip.id
        }
        // the navigation selection settles SYNCHRONOUSLY, BEFORE the
        // transcript fetch's await. The session's owner is resolved from the
        // already-loaded overview (each agent carries its own session list),
        // which is the same truth as detail.meta.agentId but available
        // without waiting on the network. With this, a composite gesture
        // (selectAgent + openSession, e.g. ⌘K/Board/Project) leaves ALL of
        // its navigation in the same tick → the router reflects it as ONE
        // single history entry (its microtask coalescer reads the already-
        // settled state), with no collapse heuristics. `detail` (the
        // transcript) does arrive after the await; it's cleared to null while
        // loading (an honest loading state, the same pattern as a fork) — it
        // isn't part of the URL, so its latency doesn't affect history.
        const ownerSync = get().agents.find((a) => a.sessions.some((s) => s.folder === folder && s.id === id))?.id
        // durable unseen: mark it seen on disk (fire-and-forget). The
        // interplay with unreadAgentIds (in memory): two "unseen" layers with
        // different meanings that must NOT fight each other — see the
        // Sidebar's dot.
        //   · unreadAgentIds (memory): a 0-latency pulse for "a turn finished
        //     while I WASN'T looking" — cleared right here (below) and in selectAgent.
        //   · session.unread (server, durable): "the agent replied and I
        //     haven't opened it" — SURVIVES closing your machine. Cleared
        //     optimistically here (markSeenInAgents) and confirmed by this PATCH + the next overview.
        // Opening ONE conversation clears BOTH for that conversation/agent.
        // Promise.resolve wraps the return: robust against an api patched
        // without this surface (test mocks) and against a network failure —
        // neither breaks opening the conversation.
        void Promise.resolve(api.markSeen(folder, id)).catch(() => {})
        set((s) => {
          const owner = ownerSync ?? s.selectedAgentId
          const unreadAgentIds = owner && s.unreadAgentIds.has(owner) ? new Set([...s.unreadAgentIds].filter((a) => a !== owner)) : s.unreadAgentIds
          return {
            selected: { folder, id },
            agents: markSeenInAgents(s.agents, folder, id),
            detail: null,
            execOut: null,
            mobileView: 'chat',
            // opening an already-existing session also resets the chosen
            // project — it's no longer needed (the session carries its own
            // cwd) and must not survive to the next time a new master chat is composed.
            chosenProject: null,
            // opening a session is the single source of truth for "which
            // agent owns this conversation" — syncs selectedAgentId/page to
            // the REAL owner, not whoever was selected before (needed for
            // peeking at a NON-selected agent, see SesionesExpandidas). With
            // ownerSync we already have it here; if it weren't in the
            // overview (rare), it gets corrected after the fetch with
            // detail.meta.agentId, below.
            ...(ownerSync ? { selectedAgentId: ownerSync, page: { kind: 'agent' as const, id: ownerSync }, lastAgentId: ownerSync } : {}),
            // a pending new chat is already resolved.
            agentFrom: null,
            viewingFile: null,
            knowsDrawer: null,
            providerPanel: null,
            newChatOpen: false,
            newChatTitle: null,
            unreadAgentIds,
            // the cascade's visible levels are PER CONVERSATION — they reset
            // when switching conversations; this one's real prefs arrive
            // right below (a fire-and-forget fetch).
            convPrefs: {},
            pendingConvPrefs: {},
            turnOverrides: {},
          }
        })
        let detail: SessionDetail
        try {
          detail = await api.sessionDetail(folder, id)
        } catch (e) {
          // the session couldn't load (deleted/unreadable between the
          // overview and the click): reverts the optimistic selection if
          // it's still this one, and re-throws so the caller (the router
          // applies its honest fallback to the agent's dossier; a direct
          // gesture simply stays where it was) can handle it.
          set((s) => (s.selected && s.selected.folder === folder && s.selected.id === id ? { selected: null } : {}))
          throw e
        }
        const agentId = detail.meta.agentId
        set((s) => {
          // guard: if the user already navigated to another session while it
          // was loading, nothing is overwritten (the same criterion as the
          // prefs fetch below).
          if (!s.selected || s.selected.folder !== folder || s.selected.id !== id) return {}
          // corrects the owner only if the synchronous guess missed (or there wasn't one).
          const corrects = agentId !== s.selectedAgentId
          const unreadAgentIds = corrects && s.unreadAgentIds.has(agentId) ? new Set([...s.unreadAgentIds].filter((a) => a !== agentId)) : s.unreadAgentIds
          return {
            detail,
            unreadAgentIds,
            ...(corrects ? { selectedAgentId: agentId, page: { kind: 'agent' as const, id: agentId }, lastAgentId: agentId } : {}),
          }
        })
        // the open conversation's prefs — best effort with a guard: if the
        // user already navigated to another session by the time it resolves,
        // nothing is overwritten. (async+try instead of .then/.catch: also
        // degrades safely if the api is patched without this surface — e.g. old test mocks.)
        void (async () => {
          try {
            const prefs = await api.conversationPrefs.get(folder, id)
            if (!prefs) return
            const sel = get().selected
            if (sel && sel.folder === folder && sel.id === id) set({ convPrefs: prefs })
          } catch {
            /* no prefs → {} already set */
          }
        })()
      },

      closeSession() {
        clearLiveRefetchTimer()
        // without this reset, closing the open session left mobileView at
        // 'chat' — a dead end on <md (a chat column with no session and no
        // header back button). The destination goes back to 'list' — the
        // unified sidebar replaces that column. The special case where the
        // AGENT is also lost (archiving the open agent, AgentModal) overrides
        // this right after, in the caller's same setState. startNewConversation()
        // needs the opposite destination — see that action, below.
        //
        // closing the session also closes any facet that was covering it and
        // turns off "new chat" mode — a closed conversation must not leave either one hanging.
        set({
          selected: null,
          detail: null,
          execOut: null,
          mobileView: 'list',
          agentFrom: null,
          viewingFile: null,
          knowsDrawer: null,
          providerPanel: null,
          newChatOpen: false,
          newChatTitle: null,
          convPrefs: {},
          pendingConvPrefs: {},
          turnOverrides: {},
        })
      },

      // the single source of truth for renaming: applied optimistically in
      // agents (the session list) and in detail.meta (if that session is
      // open); if api.rename fails, reverts both and surfaces the global error.
      async renameSession(folder, id, title) {
        // capture just the ORIGINAL title (not a whole-slice snapshot) so a
        // failure reverts only this session's title on the CURRENT state —
        // otherwise WS updates (new messages, unread, another session appearing)
        // that land during the in-flight PATCH get wiped by a stale rollback.
        const original = get()
          .agents.flatMap((a) => a.sessions)
          .find((se) => se.folder === folder && se.id === id)?.title
        set((s) => ({
          agents: renameSessionInAgents(s.agents, folder, id, title),
          detail: s.detail && s.detail.meta.folder === folder && s.detail.meta.id === id ? { ...s.detail, meta: { ...s.detail.meta, title: title } } : s.detail,
        }))
        try {
          await api.rename(folder, id, title)
        } catch (e) {
          const revert = original ?? title
          set((s) => ({
            agents: renameSessionInAgents(s.agents, folder, id, revert),
            detail:
              s.detail && s.detail.meta.folder === folder && s.detail.meta.id === id ? { ...s.detail, meta: { ...s.detail.meta, title: revert } } : s.detail,
            error: e instanceof Error ? e.message : String(e),
          }))
        }
      },

      setFilter(q) {
        set({ filter: q })
      },

      setSidebarList(v) {
        writeSidebarList(v)
        set({ sidebarList: v })
      },

      // chosen from ProjectSelector.tsx (a list of already-seen projects, or
      // a free absolute path) — enables master's composer and makes send()
      // send `cwd` in the new chat.
      chooseProject(cwd) {
        set({ chosenProject: cwd })
      },

      readSession(folder, id) {
        set({ readingSession: { folder, id } })
      },

      closeReading() {
        set({ readingSession: null })
      },

      startNewConversation() {
        get().closeSession() // zeroes out selected/detail
        set({ mobileView: 'chat', newChatOpen: true, newChatTitle: null, pendingConsoleId: null, consoleCue: null })
      },

      setNewChatTitle(title) {
        set({ newChatTitle: title })
      },

      setPendingConsole(id) {
        set({ pendingConsoleId: id })
      },

      pinConsoleCue(console) {
        const cue = get().consoleCue
        if (cue && cue.console === null) set({ consoleCue: { ...cue, console } })
      },

      dropConsoleCue() {
        set({ consoleCue: null })
      },

      askAgentAboutFile(filePath) {
        const { agents } = get()
        const slash = filePath.lastIndexOf('/')
        const dir = slash > 0 ? filePath.slice(0, slash) : '/'
        // the owning agent: the DEEPEST configured folder that contains the
        // file (master excluded — it's the fallback, never an owner). A folder
        // owns the file if it IS the file's folder or a parent of it; the
        // trailing slash makes the prefix test respect path boundaries
        // (/a/foo must not be treated as a parent of /a/foobar/x).
        const owner = agents
          .filter((a) => a.id !== MASTER_ID && a.folder)
          .filter((a) => {
            const base = a.folder!.endsWith('/') ? a.folder! : `${a.folder!}/`
            return filePath === a.folder || filePath.startsWith(base)
          })
          .sort((a, b) => b.folder!.length - a.folder!.length)[0]
        const targetId = owner ? owner.id : MASTER_ID
        // selectAgent navigates to the agent and resets chosenProject; the
        // inbox has no folder of its own, so scope it to the file's directory
        // AFTER selecting so the agent runs where the file lives.
        get().selectAgent(targetId)
        if (!owner) get().chooseProject(dir)
        get().startNewConversation()
        // seed the composer with the file reference; the user types the change.
        set({ composerSeed: { agentId: targetId, text: `\`${filePath}\`\n\n` } })
      },

      askSignIn(folder, draft, prefer) {
        const pick = signInAgentOf(get().agents, folder, prefer)
        if (!pick) return false
        get().selectAgent(pick.id)
        // a real console: only the interactive engine hands a waiting server
        // its own sign-in tools (an SDK chat has none — measured 24-11)
        get().setChatMode('console')
        get().startNewConversation()
        // the sentence beside the new console, to copy — the owner sends it;
        // Silos never types into the console for them
        set({ consoleCue: { agentId: pick.id, console: null, text: draft } })
        return true
      },
    }
  }
