// store/state.ts — the whole store's State: one interface, consumed literally
// by many components — don't change shapes here without updating them too.
// Each slice (./sessions, ./chat, ./live…) implements a Pick of it.
import { api } from '../lib/api'
import type { ActiveTrim } from '../lib/active-trim'
import type { ConversationSlot, OrderedChain } from '../lib/grouping'
import type { MachineryScope } from '../lib/automations'
import type {
  AgentView,
  Automation,
  ConvPrefs,
  ExecResult,
  KnowsEvent,
  ModelInfo,
  PendingResume,
  ProviderView,
  ProjectsPrefs,
  Run,
  SessionDetail,
  SiloDescriptor,
  UsesPrefs,
  WsEvent,
} from '../lib/types'
import type { PrefsPatch } from '../lib/cockpit'
import type { KnowsKind } from '../lib/knows'
import type { SidebarList } from '../lib/tasks-prefs'
import type { HomeSheet } from '../lib/routes'
import type { TaskDraft } from '../lib/new-task'
import type { TerminalTab, ChatTurnState, TurnReceipt, NavFilter, NavState, Page, Tab, ProjectTab, FilesPart, QueueItem } from './types'

// `said`: the turn's text so far (capped — the first meeting's card reads an
// agent's first reply from it)
export interface TurnPulse {
  tool: string | null
  lastAt: number
  ended?: 'done' | 'error'
  error?: string
  said?: string
}

export interface State {
  agents: AgentView[]
  warming: boolean
  // the build id the server says it serves (Overview.build) — the
  // stale-tab banner (UpdateBand) compares it against lib/build.ts ownBuild.
  serverBuild?: string
  home: string // the user's home dir — the root of the Files explorer (from /api/overview)
  selectedAgentId: string | null
  selected: { folder: string; id: string } | null // the open session
  detail: SessionDetail | null
  filter: string
  // the sidebar's list body: the conversations tree, or the plan tasks
  // (the «Conversations | Tasks» switch, remembered per
  // viewer in localStorage, lib/tasks-prefs.ts)
  sidebarList: SidebarList
  active: ChatTurnState | null // the turn in progress (streaming)
  execOut: ExecResult | null // the result of the last !command
  // AgentModal only handles 'create' (create) now — editing an agent no
  // longer opens a modal or drawer, it navigates to AgentPage (page/tab='settings').
  // 'palette' (palette) — the command palette (⌘K, CommandPalette.tsx), the
  // only new floating element in this phase — reuses the same exclusive
  // modal slot as shortcuts/create/create-skill (never two overlays at once).
  modal: 'create' | 'create-skill' | 'shortcuts' | 'palette' | 'new-project' | null
  // the first run skipped («Skip for now»): Home takes the pane though the
  // install is still empty — per browser, a convenience (localStorage)
  welcomeSkipped: boolean
  skipWelcome(): void
  // the sidebar's «+» menu, open — also from the empty list's door
  newMenuOpen: boolean
  setNewMenuOpen(open: boolean): void
  // the folder prefilled when opening 'create' from a Sidebar group header's
  // "+ agent" hover, or from ProjectPage's "+ Create an agent for these" —
  // null when opened from anywhere else (the regular "+ New agent"). Cleared
  // together with `modal` — see setModal.
  modalFolder: string | null
  // a name the opener proposes for the agent being created — the new
  // project flow's default agent, named after its folder
  modalName: string | null
  error: string | null // a global, displayable error
  // an action the ErrorStrip offers next to `error` — tied to the exact
  // message it was raised for, so a later, unrelated error (set by any of
  // the many `set({ error })` sites) never inherits a stale button.
  errorAction: { forMessage: string; label: string; run: () => void } | null
  // the strip's message is a REPORT, not a failure (a delete that also
  // stopped its processes says what it stopped): tied to the exact message
  // like errorAction, drawn quiet and dismissed like any other
  reportOnly: string | null
  // the text that was attempted to send and failed, with the agent it was
  // headed to — the Composer only restores it if the selected agent
  // matches (a queue-drain failure almost always targets a DIFFERENT agent
  // than the one visible; restoring it blindly would misdeliver the text between agents).
  failedDraft: { agentId: string; text: string } | null
  // a one-shot seed for the Composer of a NEWLY opened chat — same
  // agent-matching guard as failedDraft (only consumed when selectedAgentId
  // matches). Used by edit-by-chat (askAgentAboutFile) to pre-fill the
  // conversation with the file being discussed. Cleared once consumed.
  composerSeed: { agentId: string; text: string } | null
  queue: QueueItem[] // messages written while a turn was streaming, each with its destination already fixed
  userTextPersisted: boolean // active's userText echo is already persisted — the optimistic bubble can hide
  // an echo-free live transcript: how much of the active block (streamed
  // text / chips) is ALREADY persisted in detail.turns — the Transcript
  // only paints the remaining queue. Fully recomputed on every refetchDelta
  // (see lib/active-trim.ts).
  liveTrim: ActiveTrim
  // turn closes known to THIS client (chat-done/watchdog), by sessionKey —
  // ContextColumn uses these to avoid saying "Working" during the ~2 min
  // live window after one of its own turns ends (external CLI sessions
  // have their own signal, the turn_duration marker; see lib/live.ts).
  turnCloses: Record<string, number>
  connection: 'connected' | 'reconnecting' // the WS's state, fed by WsClient.onStatus from App
  // agentIds with a finished turn the user hasn't seen yet — marked from
  // finishTurn (the single completion path) and cleared when that agent is
  // selected. App.tsx derives document.title's '● ' prefix from
  // unreadAgentIds.size; the Sidebar paints a static dot (not the live Pulse).
  unreadAgentIds: Set<string>
  // receipts for turns that finished in this view, by sessionKey
  // (`folder/id`) — see TurnReceipt above. Capped per session at RECEIPTS_CAP.
  receipts: Record<string, TurnReceipt[]>
  // its own clock to derive `live` client-side (isLive(mtime, nowTick), see
  // lib/live.ts) — starts at Date.now() when the store is created, refreshes
  // every 30s via an interval mounted in App (the WsClient's boot), and also
  // on every applied 'session' event, so fresh activity lights up the badge
  // without waiting for the tick.
  nowTick: number
  // the visible column level on <md screens (mobile, via a tunnel) — from
  // md up, both columns coexist (the sidebar collapsed to icons, with a
  // sessions overlay) or both go full-width on lg, so this flag is inert
  // there (CSS-gated by breakpoint, see App.tsx/Sidebar.tsx/Chat.tsx). The
  // unified sidebar absorbed the threads column — from three levels
  // (agents→threads→chat) down to TWO ('list' includes team+sessions
  // expanded inline, 'chat' is the page — a conversation, or Home). The
  // entry level is 'chat' showing Home: the phone lands on Home; the list
  // is one tap away (Home's ‹).
  mobileView: 'list' | 'chat'
  // the project chosen for master's new chat (the project selector, see
  // ProjectSelector.tsx) — resets when the agent changes (selectAgent) or
  // a session opens (openSession). Only relevant for MASTER_ID; send() uses
  // it to decide whether to send `cwd`.
  chosenProject: string | null
  // the projects menu's preferences (~/.silos/ui.json, GET/PATCH
  // /api/prefs) — manual order, pinned and collapse state per Sidebar
  // project. Loaded once at boot (App, alongside loadOverview) and every
  // mutation persists fire-and-forget (see persistProjectsPrefs): a save
  // failure must NEVER break the UI, only console.warn.
  projectsPrefs: ProjectsPrefs
  // the composer's memory mode — the CURRENT chat (whichever agent/session
  // were already chosen, unchanged) ends up pointing at a memory file: the
  // next Enter sends the text with a hidden preamble containing the file's
  // path and current content (read fresh right before sending, see
  // Composer.tsx) instead of sending the text as-is. null = mode off (a normal composer).
  memoryMode: { path: string; name: string } | null
  // the panel's "Edit with chat" can't call composerRef directly (it lives
  // outside Chat.tsx's tree) — it requests focus by incrementing this
  // counter; Composer.tsx observes it and focuses when it changes. A
  // number, not a boolean: two requests in a row with nothing else
  // changing must still fire the effect twice.
  composerFocusRequest: number
  // REAL slash commands per session (`${folder}/${sessionId}` → list),
  // captured from each session's chat-init. The composer offers the open
  // conversation's in its '/' menu. With no entry (a new chat with no init
  // yet) the menu falls back to skills only — a safe degradation, never an empty menu.
  slashCommandsBySession: Record<string, string[]>
  // the "Run on…" panel asks the open console to restart (kill + relaunch
  // with the conversation's pins) — a counter the console view observes,
  // the same pattern as composerFocusRequest
  consoleRestartRequest: number
  // the conversation the main pane is showing AS ITS REAL CONSOLE
  // ("folder/id"), null when it shows a transcript/chat — Chat writes it,
  // the context column reads it: an open question in a console is answered
  // in Claude's own dialog, so the column doesn't repeat it
  consoleShown: string | null
  // overwritten every time a turn sent in memory mode finishes (finishTurn)
  // — AgentPage/MemoryDrawer observes it to reload the open file if its
  // path matches the one that was just saved. `ts` (not a boolean) because
  // the same path can be saved twice in a row.
  memorySaved: { path: string; ts: number } | null
  // see Page/Tab above — page/tab/contextOpen are the only three fields in
  // this block genuinely in use so far (nav exists with its defaults, no UI yet, see selectFilter).
  nav: NavState
  // the Silo Standard's registry (GET /api/silos): descriptors of every
  // installed silo — ⌘K, the rail (rail-granted ones) and the silo pages
  // read them. Empty while none is installed: the whole surface is invisible.
  silos: SiloDescriptor[]
  // The conversation view: 'console' (the real claude) or 'chat' (our own).
  // Sticky (not reset per session); starts in console by default.
  chatMode: 'chat' | 'console'
  page: Page
  tab: Tab
  // ProjectPage's active tab — independent of `tab` (AgentPage's), see ProjectTab above.
  projectTab: ProjectTab
  // the Files tab's part on the agent page and the project page (files |
  // artifacts) — back to 'files' on every move to another tab or page
  filesPart: FilesPart
  // the row a project tab opens on, named by a door (a plugin skill's «Tools
  // in x ›», a failed server's «Turn off ›») — cleared by the next move
  projectItem: string | null
  // the chip a door narrows that tab to (Tools' «need your sign-in») —
  // cleared with projectItem
  projectFilter: string | null
  // the same for the agent page's tab a door opened (openDossier's `open`:
  // the column's «Turn off ›» on a server that didn't start) — cleared by
  // the next tab move
  dossierItem: string | null
  dossierFilter: 'sign-in' | null
  // a memory of "where I was" so the rail can return to the same spot (the
  // Agents preset → the last agent page seen; the Projects preset → the
  // last project) instead of always restarting at the first in the list.
  // Updated by selectAgent/changePage.
  lastAgentId: string | null
  lastProjectFolder: string | null
  // AgentPage's context column — persisted in ~/.silos/ui.json as
  // `contextOpen` (api.patchPrefsContext), loaded in loadPrefs().
  contextOpen: boolean
  // how wide the context column's MACHINERY reaches (prefs.contextScope) —
  // everything else in the column is already about the open conversation.
  // Defaults to 'conversation': what you read is what it talks about.
  contextScope: MachineryScope
  // the context column's "Agent setup" zone — expanded or not, persisted
  // as `setup` in ~/.silos/ui.json (api.patchPrefsSetup, loaded in
  // loadPrefs()). Defaults to false: the column is operational-first, the
  // agent's setup peeks out collapsed at the bottom.
  setupOpen: boolean
  // where the agent page was reached FROM: a conversation's agent things
  // navigate to the agent page, which
  // shows a `‹ <conversation title>` return chip while this is set. It rides
  // the URL (`?from=<folder>/<id>`), so refresh / deep link / mobile keep
  // it. Cleared by every other navigation (selectAgent, openSession,
  // changePage, closeSession); kept by changeTab (tabs within the page).
  agentFrom: { folder: string; id: string } | null
  // the tile's list open over Home or a project's Now (it rides the URL, so
  // Back from a task lands on the sheet it came from)
  homeSheet: HomeSheet | null
  // the file open in the ONE viewer, over whatever page this is: a file is
  // a sheet, never a change of place. Rides the URL as
  // ?file=<path>, so Back closes it and a reload keeps it; cleared by every
  // change of place.
  viewingFile: string | null
  // a «New task» handed from another door (⌘K «new task: … @agent»):
  // /tasks opens its ONE dialog with it and clears it — never a URL fact.
  // `conversation`: ⌘K «Make this a task» — the task, once created, lists
  // this conversation
  taskDraft: (TaskDraft & { conversation?: { folder: string; id: string } }) | null
  // the composer's unsent text per conversation:
  // key = draftKeyOf(selected, agentId) — `<folder>/<id>`, or `new:<agentId>`
  // for an agent's new chat. Kept while the Composer is unmounted (the agent
  // page, another conversation) and restored on return; cleared on send.
  drafts: Record<string, string>
  // the Knows Drawer (memory / skills / context) sliding over part of the
  // transcript, next to the column — null = closed. It opens the library
  // on `kind`; `openItem` opens one item (a path, or a skill's name). Like
  // the conversation's own UI, it belongs to the open conversation: switching or closing
  // it closes the drawer. Responsibility is NOT a kind here — it stays a
  // dossier facet.
  // openScope: set only by the live toast, whose openItem is a bare basename
  // from the WS event — the library resolves (kind, openScope, basename of
  // the item's path) to the item's row once its rows are read
  // 'mission' opens the drawer's compact Mission panel (no list)
  // 'produced' | 'start' and `filter` aim the library (KnowsLibrary) — a
  // kind it shows and a facet it opens on
  knowsDrawer: {
    kind: KnowsKind | 'mission' | 'produced' | 'start'
    openItem?: string
    openScope?: string
    filter?: 'outside-index' | 'recent' | 'here'
  } | null
  // the "Run on…" panel (ProviderPanel.tsx): pick a login or paste a key
  // without leaving the conversation. reason = the provider's own words for
  // why the conversation cannot run (lib/providers cannotRun), null when
  // opened by choice from the account chip.
  providerPanel: { reason: string | null } | null
  // Knows live — fed by the server's `knows` WS event for the
  // VISIBLE agent (applyWs). knowsVersion: a per-kind invalidation counter;
  // the column's KnowsBlock and the drawer's list both re-fetch that kind
  // when it moves (they fetch separately, so both must listen).
  // knowsPulse: when each kind last changed (the row counter pulses ~1.6 s).
  // knowsToast: the ONE visible toast — the latest event replaces it and
  // restarts its 6 s auto-dismiss.
  knowsVersion: Record<KnowsKind, number>
  knowsPulse: Partial<Record<KnowsKind, number>>
  knowsToast: { kind: KnowsKind; name: string; scope: string; action: KnowsEvent['action']; ts: number } | null
  // plansVersion: per-folder invalidation counter fed by the server's
  // `knows` event of kind 'plans' (a <folder>/plans/*.plan.json write).
  // The column's TeamPlanBlock re-reads its plans when the counter of any
  // of their folders moves — no conversation write needed.
  plansVersion: Record<string, number>
  // a conversation being READ as a window over everything (SessionModal):
  // reached from a run's row, without leaving the conversation you are in.
  // Transient; never in the URL — it is a look, not a place.
  readingSession: { folder: string; id: string } | null
  // "+ New conversation" (Sidebar/⋯ menu) requested a new chat for the
  // selected agent — with no `selected` yet (no session persists until the
  // first chat-init), the CONVERSATION VIEW must still mount (composer/
  // project selector), not the dossier. Turns itself off (goes inert) as
  // soon as `selected` is genuinely set — see applyChatEvent/chat-init.
  newChatOpen: boolean
  // naming at birth: the title typed on the "New conversation" header
  // before the first message — travels as `title` on the first send (the
  // server applies it as the manual rename at chat-init) and is consumed
  // there. null = the conversation will be named by its content (raw/auto).
  newChatTitle: string | null
  // the real console's new conversation: the server names the session id
  // up front (`--session-id` = console key) but nothing persists until the
  // first message. Remembered here so the session event for THAT id hands
  // the new chat off to its session (selected/detail/title) the way
  // chat-init does for the SDK engine — without it the header stayed on
  // "New conversation" and the sidebar grew a separate "(untitled)" row.
  pendingConsoleId: string | null
  // the sentence a new real console was opened to send («Sign in ›», spec
  // tools-origin §9): shown beside that console with a copy button — never
  // typed for the owner. `console`: the key the console was born with (null
  // until the server names it), so the cue stays with THAT console once its
  // conversation exists; cleared by the next new conversation or its ×.
  consoleCue: { agentId: string; console: string | null; text: string } | null
  // Map › Uses: the axes and window last chosen — persisted as `uses`
  // (api.patchPrefsUses, loaded in loadPrefs()). Empty = the view's defaults.
  usesPrefs: UsesPrefs
  // agentIds whose row is collapsed in the Sidebar (a chevron, persisted in
  // ~/.silos/ui.json — api.patchPrefsCollapsedAgents, loaded in loadPrefs()).
  // Collapsed = only the agent's row is visible, without its topic list
  // (neither compact nor expanded).
  collapsedAgents: string[]
  // agentIds whose "▸ N older" fold is open in the Sidebar. The fold is a
  // fact about the AGENT, not about one rendering of its list: that list
  // remounts whenever the agent becomes (or stops being) the selected one
  // — opening one of the unfolded conversations does exactly that — and
  // local state would fold the older rows away again. In
  // memory only, not persisted.
  olderOpenAgents: string[]
  toggleOlderOpen(agentId: string): void
  // the owner's drag order of agent rows (prefs.agentOrder) — a global
  // list of agentIds; applied per project by the Sidebar (applyAgentOrder).
  agentOrder: string[]
  // conversations the owner dragged to a FIXED position in an agent's list
  // (prefs.conversationSlots): agentId → { key, at }. Every other
  // conversation flows by latest activity, newest first —
  // see orderWithSlots (lib/grouping.ts).
  conversationSlots: Record<string, ConversationSlot[]>
  // conversations detached from their chain by drag (prefs.detachedChains).
  detachedChains: string[]
  // the terminal panel under the chat (TerminalPanel.tsx) — `terminals` is
  // GLOBAL (survives switching agents, like a persistent console),
  // `activeTerminalId` is the visible tab, `terminalOpen` is the panel's
  // collapsed state (the PTYs stay alive server-side even when collapsed),
  // `terminalHeight` (px) persists in ~/.silos/ui.json (`terminal.height`).
  terminals: TerminalTab[]
  activeTerminalId: string | null
  terminalOpen: boolean
  terminalHeight: number
  // font size (px) of every xterm pane (real console and shell tabs) —
  // persists as `terminal.fontSize`; Settings › Appearance owns the control.
  terminalFontSize: number
  // the automations resident — the full list (every automation for every
  // agent, the server doesn't paginate) + runs waiting for approval (for
  // the rail's badge and the dimension sidebar's Needs approval block).
  // `automationRuns` is ONLY the runs for whichever automation's detail
  // page is open right now (the Runs tab) — reloaded on navigating to
  // another, see openAutomation.
  automations: Automation[]
  /** the list has answered at least once — before that, an id that is not
   *  in `automations` is UNKNOWN, not deleted (the deep link must not lie) */
  automationsLoaded: boolean
  automationsPending: Run[]
  automationRuns: Run[]
  // Auto-resume of interactive chats: durable records (key
  // "folder/sessionId") of rate-limited turns that Silos will resume on
  // its own — hydrated at startup (GET /api/pending-resumes) and kept
  // current via WS. The rate-limit banner reads from here to promise a
  // resume ONLY when one genuinely exists (proof-of-life). `providers` is
  // the provider list (to resolve the fallback's name and know whether an
  // agent is already on cheapestinference → don't show it the nudge).
  pendingResumes: Record<string, PendingResume>
  // bumped by the `silos` WS event: Home re-fetches the board at once
  siloTick: number
  // bumped when the server's inbox may have moved — an `inbox` WS event (its
  // composition changed) or a run that ended (a failure may have just
  // entered): Home re-fetches the board at once
  inboxTick: number
  // every engine turn the WS stream speaks of, by turnId — its last tool and
  // when it last said anything, and how it ended: what the task's live line
  // adds to the server's facts («X is on it · <tool> · <n>s ago», TaskLive.tsx)
  turnPulse: Record<string, TurnPulse>
  providers: ProviderView[]
  // the cockpit's selectors: an honest model catalog (GET /api/models —
  // ALWAYS from the SDK via the server, never hardcoded; empty = an honest
  // empty and CockpitChips falls back to "models seen in use") + the
  // cascade's three visible levels. `convPrefs` are the OPEN conversation's
  // prefs (loaded in openSession); `pendingConvPrefs` are a NEW chat's,
  // with no session yet (PATCHed to the real conversation as soon as its
  // chat-init arrives); `turnOverrides` is the one-shot ("next turn"):
  // consumed on the next send and cleared.
  catalog: ModelInfo[]
  convPrefs: ConvPrefs
  pendingConvPrefs: ConvPrefs
  turnOverrides: ConvPrefs
  // actions
  loadOverview(): Promise<void>
  loadPrefs(): Promise<void>
  // boot-only (App) — failure = no records (the banner promises nothing), never blocks startup.
  loadPendingResumes(): Promise<void>
  loadProviders(): Promise<void>
  // the rate-limit banner's "Cancel": removes the scheduled resume
  // (optimistic + reconciled by the pending-resume-removed WS event).
  cancelPendingResume(folder: string, id: string): Promise<void>
  // collapses/expands a project (a group header row) — persisted.
  toggleProjectCollapse(key: string): void
  // pins a project at `newOrder` (the full order of active keys after
  // drag/drop or the up/down button) — a pinned project wins over the
  // activity-based automatic order and is never demoted to "Inactive".
  pinProject(key: string, newOrder: string[]): void
  moveToStash(key: string): void
  removeFromStash(key: string): void
  pinItem(source: string, ref: string): void
  selectAgent(id: string): void
  openSession(folder: string, id: string, opts?: { exact?: boolean }): Promise<void>
  closeSession(): void
  chooseProject(cwd: string): void
  // decides chat vs. exec by the '!' prefix; queues if a turn is in
  // progress. `memory` marks the turn as a memory edit — see ChatTurnState.memoryPath.
  send(text: string, memory?: { path: string }): Promise<void>
  // boot-only (App, alongside loadPrefs) — failure = an honest empty
  // catalog, never blocks startup.
  loadCatalog(): Promise<void>
  // boot-only (App, next to loadCatalog) — a failure, no answer or an
  // invalid shape keeps the seeded list, never blocks startup.
  loadHarnesses(): Promise<void>
  // sets a CONVERSATION-LEVEL override (persisted server-side; null on a
  // field = revert to the agent's default). With no session open yet, it
  // goes to pendingConvPrefs and is assigned to the conversation at its chat-init.
  setConversationPref(patch: PrefsPatch): void
  // the same pin, awaited: what the server could do about a live OpenCode
  // console ('live' | 'restart' | 'next-turn'); a new chat → 'pending'
  applyConversationPref(patch: PrefsPatch): Promise<'live' | 'restart' | 'next-turn' | 'pending'>
  // sets/clears the NEXT turn's one-shot override ("next turn").
  setTurnOverride(patch: PrefsPatch): void
  cancel(): Promise<void>
  renameSession(folder: string, id: string, title: string): Promise<void>
  applyWs(ev: WsEvent): void
  setFilter(q: string): void
  setSidebarList(v: SidebarList): void
  // `folder` is optional — only used by the "+ agent" hovers on a Sidebar
  // group header and ProjectPage's "+ Create an agent for these" when
  // opening 'create'; any other call (the regular "+ New agent", closing
  // with null, etc.) omits it and modalFolder stays null. `name` proposes
  // the agent's name (the new project flow).
  setModal(m: State['modal'], folder?: string, name?: string): void
  clearError(): void
  removeFromQueue(i: number): void
  // steps back from 'chat' to 'list' (a no-op on 'list' — there's no
  // third level to fall back to anymore). Called by the chat header's back button.
  backToMobileList(): void
  // resync after the WS reconnects: reloads overview + the open session (if
  // any) and arms the active turn's watchdog (see the comment in the
  // implementation) — chat-done could have been lost while the WS was down.
  resync(): Promise<void>
  // enters/exits the composer's memory mode — see `memoryMode`.
  enterMemoryMode(path: string, name: string): void
  exitMemoryMode(): void
  requestComposerFocus(): void
  requestConsoleRestart(): void
  setConsoleShown(key: string | null): void
  // a minimal patch for one axis of the faceted filter — no UI yet, but the
  // contract already demands this binding.
  selectFilter(axis: keyof NavFilter, values: string[]): void
  changePage(p: Page): void
  setHomeSheet(sheet: HomeSheet | null): void
  setViewingFile(path: string | null): void
  changeTab(t: Tab): void
  setChatMode(m: 'chat' | 'console'): void
  // the Silo Standard's registry (descriptors) — loaded at boot and on the
  // `silos` WS event; best-effort, never blocks startup.
  loadSilos(): Promise<void>
  changeProjectTab(t: ProjectTab): void
  setFilesPart(p: FilesPart): void
  setProjectItem(item: string | null, filter?: string | null): void
  // collapses/expands AgentPage's context column — persisted (see contextOpen above).
  toggleContext(): void
  // collapses/expands the context column footer's "Agent setup" zone —
  // persisted (see setupOpen above), the same pattern as toggleContext.
  toggleSetup(): void
  // sets Map › Uses' axes/window — optimistic + persisted (see usesPrefs
  // above), a value setter in toggleContext's pattern.
  setUsesPrefs(p: UsesPrefs): void
  // navigates to the agent page on facet f, carrying the open conversation
  // as agentFrom (navigation C)
  // `open`: the row the tab opens on (a GET …/loads row key) or the chip it
  // opens narrowed to
  openDossier(f: Tab, open?: { item?: string; filter?: 'sign-in' }): void
  // restores the agent page's return chip (router, ?from=) — see agentFrom
  setAgentFrom(from: { folder: string; id: string } | null): void
  // the composer's draft for a key (empty text deletes it) — see drafts
  setDraft(key: string, text: string): void
  // opens/closes the Knows Drawer (see knowsDrawer above); opening replaces
  // whatever kind/options were open.
  openKnows(
    kind: KnowsKind | 'mission' | 'produced' | 'start',
    opts?: { openItem?: string; openScope?: string; filter?: 'outside-index' | 'recent' | 'here' },
  ): void
  closeKnows(): void
  openProviderPanel(reason?: string | null): void
  closeProviderPanel(): void
  dismissKnowsToast(): void
  // a click on an automation from WITHIN a conversation (the column): its full context where you are — the agent's
  // automations facet over the transcript (or the dossier page's section
  // when no conversation is open), landing on THAT automation. Switches to
  // the owning agent first when needed. Distinct from openAutomation
  // (Board → the automation's own page): there is no conversation to keep.
  // the same destination as openAutomation, for callers that only know an
  // id that may not exist any more (a removed automation's rows).
  showAutomation(id: string): void
  // read a conversation as a window over everything / close it
  readSession(folder: string, id: string): void
  closeReading(): void
  // closes the open session (if any) and readies the CONVERSATION VIEW for
  // a new chat (composer/project selector) for the already-selected agent —
  // used by "+ New conversation" (the Sidebar and the ⋯ menu).
  startNewConversation(): void
  // naming at birth — see State.newChatTitle (null clears the draft name)
  setNewChatTitle(title: string | null): void
  setPendingConsole(id: string | null): void
  // edit-by-chat: opens a fresh conversation aimed at editing `filePath`.
  // Targets the agent whose folder contains the file (deepest match); with
  // no such agent, the inbox (master) scoped to the file's directory. Seeds
  // the Composer with a reference to the file so the user just types the
  // change. Navigates to that agent's chat.
  askAgentAboutFile(filePath: string): void
  // «Sign in ›» on a Tools row that needs your sign-in (spec tools-origin
  // §9): a NEW real console of an agent that starts in `folder` (`prefer` —
  // the agent whose conversation read it — when it is one), the row's
  // sentence (its engine's words, the server's exact name) beside it as
  // consoleCue — the owner sends it; nothing is sent or typed for them. The
  // interactive engine hands that console its own sign-in tools for the
  // waiting server. False: no agent starts there (no door).
  askSignIn(folder: string, draft: string, prefer?: string): boolean
  // the new console the cue was shown beside got its key (its session id)
  pinConsoleCue(console: string): void
  dropConsoleCue(): void
  // collapses/expands an agent's row in the Sidebar — persisted (see collapsedAgents above).
  toggleAgentCollapse(agentId: string): void
  // widens/narrows the column's machinery radius — persisted (see contextScope).
  setContextScope(scope: MachineryScope): void
  // drag-only reorder of agent rows: `visible` is the current display
  // order of all agent rows; the result is persisted whole (agentOrder).
  reorderAgents(visible: readonly string[], dragged: string, target: string): void
  // a conversation dropped at index `at` of its agent's list stays fixed
  // there; release lets it flow by activity again. Only that agent's slots
  // are persisted — the server merges per agent.
  fixConversationAt(agentId: string, dragged: OrderedChain, at: number): void
  releaseConversation(agentId: string, chain: OrderedChain): void
  // chains: drag a nested conversation out (detach) or back onto its chain's head (attach).
  setChainDetached(key: string, detached: boolean): void
  // opens the panel — if there's no terminal yet, creates the first one
  // (the same destination criterion as newTerminal). If terminals already
  // exist, it just unfolds the panel (doesn't create a new one).
  openTerminalPanel(): Promise<void>
  // creates a new terminal (tab) for the selected agent — resolves
  // agentId/cwd, calls POST /api/terminals, adds it to `terminals` and
  // makes it active. Does nothing if there's no valid destination yet
  // (master with no project chosen and no session open).
  newTerminal(): Promise<void>
  // closes a tab: kills the PTY server-side (fire-and-forget) and removes
  // it from `terminals` — if it was the active one, activates the next (or
  // collapses the panel if none remain).
  closeTerminal(id: string): void
  selectTerminalTab(id: string): void
  toggleTerminalPanel(): void
  // resizes the panel live (dragging); `persist` only fires on release —
  // avoids a PATCH per mousemove pixel.
  resizeTerminal(px: number, persist?: boolean): void
  // clamps to [TERMINAL_FONT_MIN, TERMINAL_FONT_MAX], applies at once
  // (open panes re-fit live) and persists.
  setTerminalFontSize(px: number): void
  // the automations resident — loadAutomations() brings list()+pending()
  // all at once (boot, alongside loadOverview, and after each simple
  // optimistic mutation); single-id mutations (pause/resume/delete/
  // run-now/approve/skip) update `automations`/`automationsPending` in
  // place instead of reloading everything.
  loadAutomations(): Promise<void>
  loadAutomationRuns(id: string): Promise<void>
  createAutomation(input: Parameters<typeof api.automations.create>[0]): Promise<Automation>
  updateAutomation(id: string, patch: Partial<Omit<Automation, 'id' | 'createdAt'>>): Promise<Automation>
  deleteAutomation(id: string): Promise<void>
  runNowAutomation(id: string): Promise<void>
  pauseAutomation(id: string): Promise<void>
  resumeAutomation(id: string): Promise<void>
  approveRun(runId: string): Promise<void>
  skipRun(runId: string): Promise<void>
  openAutomation(id: string): void
}
