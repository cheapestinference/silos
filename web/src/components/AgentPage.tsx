// AgentPage.tsx — the header+sidebar redesign: the conversation is the
// protagonist, the agent is the second protagonist in its own band. This
// file mounts ONE of two modes, decided by whether a conversation is in
// progress (selected!==null || newChatOpen):
//   - ConversationView: `#` + editable title + meta (above) → AgentBand
//     (a small seal + name + role + the agent's FACETS, with no "Chat"
//     between them — the conversation ALREADY IS the page) → the transcript
//     → the Context column. An agent thing clicked from a conversation
//     NAVIGATES to the agent page (the old DossierPane over the transcript
//     is gone), whose header then
//     carries a `‹ <conversation title>` return chip (store.agentFrom).
//   - AgentDossier: the full plaque (large seal, name, role, mono line,
//     stats) + the facets bar as real tabs, landing on Sessions — no
//     chat/composer here; starting a conversation is an explicit act (a
//     #topic or "+ New conversation").
// The global Esc shortcut (cancel turn / '?' for shortcuts) lives HERE,
// mounted whenever an agent page is open; it cancels a streaming turn ONLY
// while that conversation is on screen (store.turnOnScreen).
//
// MODEL reference (not style): Silos' AgentDetailView.tsx — a plaque + a
// segmented-control-style tab bar. Here without gradients/shadows (a flat
// surface, the claude palette — see theme.css) and with terracotta reserved
// for send/live/skill chips/the seal.
import { useEffect, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { ChevronLeft, GitBranch, Mail, MessageSquarePlus, SquareTerminal } from 'lucide-react'
import { useStore, sessionViewOf, turnOnScreen } from '../store'
import { ConversationTask } from './tasks/TaskBits'
import { MASTER_ID, ANYWHERE_LABEL } from '../lib/constants'
import { basename } from '../lib/routes'
import { goBackTo, routeOf } from '../lib/router'
import { relTime } from '../lib/rel-time'
import { conversationsAndRuns, countsOf } from '../lib/counts'
import { Chat, ModeSelector } from './Chat'
import { fallbackBadge } from '../lib/providers'
import { useHarness } from '../lib/harnesses'
import { ContextColumn, useRunsOn } from './ContextColumn'
import { KnowsDrawer } from './knows/KnowsDrawer'
import { ProviderPanel } from './ProviderPanel'
import { KnowsSheet, isLgViewport } from './knows/KnowsSheet'
import type { Tab } from '../store'
import { AgentTab } from './agent/AgentTab'
import { ANYWHERE_ROLE } from './agent/WhoCard'
import { agentSignal } from './agent/NowCard'
import { Fact, HeaderButton, PageHeader, Seal } from './PageHeader'
import { useNewMessages } from '../hooks/useNewMessages'
import { AgentFold, AgentPill, useAgentRowPref } from './agent/AgentTabsMenu'
import { GiveDialog } from './tasks/GiveDialog'
import { useTasks } from '../hooks/useTasks'
import { taskPage } from '../lib/tasks'
import { NewIcon } from '../lib/icons'
import type { AgentView, BranchState } from '../lib/types'
import { missionLine } from '../lib/mission'

// ---------------------------------------------------------------------------
// AgentHeader — AGENT DOSSIER ONLY (no open conversation): a large seal +
// identity + mono line + stats on the right. Compact on mobile (only
// seal+name+tabs, see TabsBar below with horizontal scroll): the rest
// (role/mono line/stats) is hidden under `sm`. The CONVERSATION VIEW has
// its own header (ConversationHeader, further below) — much smaller, with
// the session's title as the protagonist and the agent reduced to a band.
// ---------------------------------------------------------------------------
// the header's quick actions — the same store actions as the sidebar's
// inline "+" (see Sidebar.tsx, aria-label "new conversation with <name>"):
// select the agent, then start a new conversation. Console additionally
// pins chatMode to 'console' FIRST, so Chat.tsx's ModeSelector lands on the
// real console for the fresh session instead of the sticky chat default.
function startNewConversationWith(agentId: string): void {
  useStore.getState().selectAgent(agentId)
  useStore.getState().startNewConversation()
}

function startConsoleWith(agentId: string): void {
  useStore.getState().setChatMode('console')
  startNewConversationWith(agentId)
}

function AgentHeader({ agent }: { agent: AgentView }) {
  const detail = useStore((s) => s.detail)
  const chosenProject = useStore((s) => s.chosenProject)
  const nowTick = useStore((s) => s.nowTick)
  const isMaster = agent.id === MASTER_ID

  const name = isMaster ? ANYWHERE_LABEL : agent.name
  const role = isMaster ? ANYWHERE_ROLE : missionLine(agent)
  // master has no folder of its own — the same criterion as AgentBand below.
  const project = isMaster ? (chosenProject ?? detail?.meta.cwd ?? null) : agent.folder
  // the seal carries the agent's own two-state signal (the sidebar's dot
  // vocabulary, one level up): a ring that blinks while it works, solid
  // when a conversation waits for you. No chips, no counters.
  const signal = agentSignal(agent, nowTick)
  const changePage = useStore((s) => s.changePage)
  // the agent's settings are its last tab, by name (AgentTab) — no ⚙
  // on the name: that icon is the platform's Settings
  // «Give it a task»: the ONE New task dialog with
  // this agent as the owner — the plans load only once it opens
  const [giving, setGiving] = useState(false)
  const taskReading = useTasks(giving)
  const agents = useStore((s) => s.agents)

  const from = useStore((s) => s.agentFrom)
  const fromKnown = useStore((s) => sessionViewOf(s.agents, s.agentFrom))
  const fromTitle = fromKnown?.title ?? 'the conversation'

  return (
    <div className="shrink-0">
      <PageHeader
        testId="agent-header"
        joined
        // where it lives: its project (each crumb a door up). Anywhere has no
        // project of its own — its crumb is its own name, a place, not a door.
        crumbs={
          project && !isMaster
            ? [{ label: basename(project), title: project, onClick: () => changePage({ kind: 'project', folder: project }) }]
            : [{ label: ANYWHERE_LABEL }]
        }
        // where you came from: the agent
        // page reached from a conversation says so — `‹ <conversation title>`.
        // It rides the URL (?from=), so a refresh, a deep link and the phone
        // keep it. A «back»: the browser's Back when the conversation is right
        // below; else it opens it, replacing — never stacking a conversation ⇄
        // agent page ping-pong
        aside={
          from ? (
            <button
              type="button"
              data-testid="return-chip"
              onClick={() =>
                goBackTo(
                  routeOf({ page: { kind: 'agent', id: fromKnown?.agentId ?? MASTER_ID }, selected: from }),
                  () => void useStore.getState().openSession(from.folder, from.id, { exact: true }),
                )
              }
              title={`Back to “${fromTitle}”`}
              className="flex min-w-0 items-center gap-0.5 hover:text-terracotta"
            >
              <ChevronLeft size={13} aria-hidden="true" className="shrink-0" />
              <span className="max-w-[18rem] truncate">{fromTitle}</span>
            </button>
          ) : null
        }
        seal={
          <Seal testId="agent-seal" signal={signal}>
            {agent.emoji}
          </Seal>
        }
        title={name}
        facts={
          <>
            {role ? (
              <Fact truncate>
                <span className="min-w-0 truncate" title={role}>
                  {role}
                </span>
              </Fact>
            ) : null}
            {/* the counts only — the last activity is the sidebar's */}
            <Fact>{conversationsAndRuns(countsOf(agent))}</Fact>
            {fallbackBadge(agent) ? (
              <Fact bare>
                <span className="shrink-0 rounded-full bg-terracotta-soft px-2 py-0.5 text-[11px] text-terracotta">{fallbackBadge(agent)}</span>
              </Fact>
            ) : null}
          </>
        }
        // secondary first, the primary (New chat — the single most common act
        // from the page) last on the right. Console needs a folder (the route
        // resumes/starts a real `claude` there); the folder-less master keeps
        // New chat but never Console.
        actions={
          <>
            {agent.folder && !isMaster ? (
              <HeaderButton testId="give-task" onClick={() => setGiving((g) => !g)} label="Give it a task" expanded={giving}>
                <NewIcon size={15} aria-hidden="true" className="sm:hidden" />
                <span className="hidden sm:inline">Give it a task</span>
              </HeaderButton>
            ) : null}
            {agent.folder ? (
              <HeaderButton onClick={() => startConsoleWith(agent.id)} label="New console">
                <SquareTerminal size={15} aria-hidden="true" className="sm:hidden" />
                <span className="hidden sm:inline">New console</span>
              </HeaderButton>
            ) : null}
            <HeaderButton primary onClick={() => startNewConversationWith(agent.id)} label="New chat">
              <MessageSquarePlus size={15} aria-hidden="true" className="sm:hidden" />
              <span className="hidden sm:inline">New chat</span>
            </HeaderButton>
          </>
        }
      />
      {giving ? (
        <div className="border-b border-line bg-panel px-4 pb-3">
          {taskReading.state === 'ready' ? (
            <GiveDialog
              all={taskReading.tasks}
              agents={agents}
              initialOwner={agent.id}
              onClose={() => setGiving(false)}
              onCreated={(nt) => {
                setGiving(false)
                if (!nt.started) changePage(taskPage(nt))
              }}
            />
          ) : (
            <p className="mt-3 text-[12px] text-ink-3" aria-live="polite">
              {taskReading.state === 'loading' ? 'Reading tasks…' : 'The tasks could not be read — try again in a moment.'}
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}

// The body of the agent page. Every facet is a SECTION of it:
// AgentTab lands on it and writes the facet back to the page's tab when the
// operator moves. The old facet ids survive as DEEP LINKS (routes, ⌘K, the
// context column); 'threads' (the old landing) is the page itself.
function TabBody({ tab, agent }: { tab: Tab; agent: AgentView }) {
  const focus = tab === 'threads' ? null : tab === 'identity' ? 'who' : tab
  return <AgentTab agent={agent} focus={focus} />
}

// ---------------------------------------------------------------------------
// ConversationHeader — the conversation is the protagonist. An inline
// editable title (font-display text-2xl) and NOTHING else: the old
// right-side meta cluster (live/relative time · branch · PR · % context)
// is gone — none of it made sense there; where the
// session stands (project · branch) lives with the agent in AgentBand.
// With no session yet (newChatOpen, detail still null) the title falls back
// to "New conversation" and isn't editable.
// ---------------------------------------------------------------------------
// Where this conversation continues from: the sessions a
// thread went through (a `--resume`, a "Continue in Silos", a rotation)
// are not sidebar rows — the header names the one right before this, in
// words, and the click reads it (that transcript says where it went on).
// A /clear started a NEW conversation: no line, it isn't this one's past.
function ContinuesFrom() {
  const known = useStore((s) => sessionViewOf(s.agents, s.selected))
  const agents = useStore((s) => s.agents)
  const nowTick = useStore((s) => s.nowTick)
  if (!known?.parentKey || known.parentKind === 'clear') return null
  const parent = agents.flatMap((a) => a.sessions).find((s) => `${s.folder}/${s.id}` === known.parentKey)
  if (!parent) return null
  return (
    <p className="flex min-w-0 shrink items-center gap-1 text-[13px] text-ink-2" data-testid="continues-from">
      <span className="shrink-0">continues</span>
      <button
        type="button"
        onClick={() => void useStore.getState().openSession(parent.folder, parent.id, { exact: true })}
        title={`Read “${parent.title}”`}
        className="min-w-0 truncate rounded px-0.5 text-ink hover:text-terracotta"
      >
        “{parent.title}”
      </button>
      <span className="shrink-0 tabular-nums">{relTime(parent.mtime, nowTick)}</span>
    </p>
  )
}

// Beside the branch, on the place line: is its work in the default branch?
// From the worktree record the System silo keeps (server branchStateOf).
// Quiet on purpose — a branch at work is unmerged all day, that is no alert;
// the alert is a task said done whose work has not landed, and it is said
// beside the task (ConversationTask `unlanded`). The door is the record's
// home, System › Worktrees.
function branchSaid(state: BranchState): string | null {
  if (state.missing > 0) return `${state.missing} not in ${state.base}`
  if (state.changes > 0) return 'uncommitted changes'
  // a branch that holds nothing yet has nothing to have merged: say nothing
  return state.merged && state.commits > 0 ? 'merged' : null
}
function BranchStateMark({ state }: { state: BranchState }) {
  const changePage = useStore((s) => s.changePage)
  const said = branchSaid(state)
  if (!said) return null
  return (
    <button
      type="button"
      data-testid="conversation-branch-state"
      data-merged={state.merged ? 'true' : 'false'}
      onClick={() => changePage({ kind: 'silo', id: 'system', view: 'worktrees' })}
      title={
        state.merged
          ? `Everything on ${state.branch} is in ${state.base} — open System › Worktrees`
          : `${state.branch} holds work ${state.base} does not have — open System › Worktrees`
      }
      className={`shrink-0 rounded-sm tabular-nums hover:text-terracotta ${state.merged ? '' : 'text-ink-2'}`}
    >
      <span aria-hidden="true" className="px-1.5 text-ink-3/70">
        ·
      </span>
      {said}
    </button>
  )
}

// why this conversation exists when Silos opened it (origin 'message' —
// HISTORY: no message wakes anyone any more; saved
// conversations still carry it): to work ONE message. Said once under the
// subtitle, in the same muted register; the gist opens the agent's Inbox
// section over the conversation, where the message and its answer live
// (one home for the message).
function OpenedForMessage() {
  const known = useStore((s) => sessionViewOf(s.agents, s.selected))
  const agents = useStore((s) => s.agents)
  const origin = known?.origin?.kind === 'message' ? known.origin : null
  if (!origin) return null
  const sender = origin.from === 'owner' ? 'your' : `${agents.find((a) => a.id === origin.from)?.name ?? origin.from}'s`
  return (
    // a phone reads it as a sentence on up to two lines (the gist is the
    // point of it — cut to a quote mark it said nothing); desktop keeps one
    <p className="mt-0.5 min-w-0 text-[12px] text-ink-3 max-md:line-clamp-2 md:flex md:items-center md:gap-1" data-testid="opened-for-message">
      <Mail size={11} aria-hidden="true" className="shrink-0 max-md:mr-1 max-md:inline max-md:align-[-1px]" />
      <span className="shrink-0">Opened for {sender} message </span>
      <button
        type="button"
        onClick={() => useStore.getState().openDossier('inbox')}
        title="Open it in the agent's inbox"
        className="rounded px-0.5 text-left text-ink-2 underline decoration-line decoration-dotted underline-offset-2 hover:text-terracotta hover:decoration-terracotta max-md:inline md:min-w-0 md:truncate"
      >
        “{origin.gist}”
      </button>
    </p>
  )
}

function ConversationHeader({ agent, extra }: { agent: AgentView; extra?: ReactNode }) {
  const detail = useStore((s) => s.detail)
  const renameSession = useStore((s) => s.renameSession)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')

  const meta = detail?.meta ?? null
  // can a STARTED conversation switch console ⇄ chat on this engine?
  // (descriptor modeSwitch — both engines; read only with meta)
  const modeSwitch = useHarness(meta?.harness).modeSwitch
  // naming at birth: while the conversation is NEW (no meta yet), the same
  // click-to-edit gesture edits the draft name — it travels as `title` on
  // the first send and lands as the manual rename at chat-init.
  const newChatOpen = useStore((s) => s.newChatOpen)
  const newChatTitle = useStore((s) => s.newChatTitle)
  const setNewChatTitle = useStore((s) => s.setNewChatTitle)
  // identity first: while a KNOWN conversation's transcript
  // is loading (selected set, detail still null) the title is the one the
  // overview already carries — never the new-conversation placeholder.
  // Editing waits for meta (the rename needs the persisted session).
  const known = useStore((s) => sessionViewOf(s.agents, s.selected))
  const selected = useStore((s) => s.selected)
  // the rule: "New conversation" ONLY when the conversation
  // IS new (nothing selected). With a conversation selected and no title
  // yet from any source (overview not loaded, a session the overview
  // doesn't list…) the header says it's loading — never the placeholder.
  const title = meta?.title ?? known?.title ?? (selected ? null : (newChatTitle ?? 'New conversation'))

  function startEditingTitle(): void {
    if (meta) setValue(meta.title)
    else if (newChatOpen) setValue(newChatTitle ?? '')
    else return
    setEditing(true)
  }

  function confirmEdit(): void {
    setEditing(false)
    const trimmed = value.trim()
    if (meta) {
      if (trimmed && trimmed !== meta.title) void renameSession(meta.folder, meta.id, trimmed)
    } else if (newChatOpen) {
      setNewChatTitle(trimmed === '' ? null : trimmed)
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') confirmEdit()
    else if (e.key === 'Escape') {
      // without preventDefault, the global Esc handler (below, in AgentPage)
      // would see the free event and read it as "cancel turn" — closing the
      // rename input must consume the Esc.
      e.preventDefault()
      setEditing(false)
    }
  }

  function onClickTitle(): void {
    startEditingTitle()
  }

  const changePage = useStore((s) => s.changePage)
  const chosenProject = useStore((s) => s.chosenProject)
  const isMaster = agent.id === MASTER_ID
  const name = isMaster ? ANYWHERE_LABEL : agent.name
  const role = isMaster ? ANYWHERE_ROLE : missionLine(agent)
  // the conversation's OWN folder — the overview already knows it, no need to
  // wait for the transcript (identity first). It may differ from the agent's
  // home: then the facts say so.
  const where = meta?.cwd ?? known?.cwd ?? (isMaster ? (chosenProject ?? null) : agent.folder) ?? null
  const away = !isMaster && agent.folder != null && where != null && where !== agent.folder
  const gitBranch = detail?.context?.flags.gitBranch ?? null
  // said only of the branch it names (a record of another branch says nothing of this one)
  const branchState = detail?.branchState && detail.branchState.branch === gitBranch ? detail.branchState : null

  // the header's first line is the AGENT's, its title line the
  // conversation's (owner 23-11, after four review rounds): the agent is one
  // pill [seal name │ ▾] — name → its page (Now), ▾ → its sections unfolded
  // at the header's foot, under the title (folded by default, remembered per viewer; a phone:
  // a sheet). Its unread messages ride beside the pill — a mark, only while
  // there are some and the fold is closed (open, «Messages N» is there).
  // The role line left the conversation's subtitle: it heads the fold.
  const openAgentPage = (): void => useStore.getState().openDossier('threads')
  const newMessages = useNewMessages(isMaster ? null : agent.id)
  const [rowOpen, setRowOpen] = useAgentRowPref()
  // its own pin (provider/model/style) vs its agent's — the column's runs-on truth
  const runsOwn = useRunsOn(agent)
  const messagesMark =
    newMessages > 0 ? (
      <button
        type="button"
        data-testid="agent-messages-mark"
        onClick={() => useStore.getState().openDossier('inbox')}
        aria-label={`${newMessages} new ${newMessages === 1 ? 'message' : 'messages'} for ${name}`}
        title={`${newMessages} new ${newMessages === 1 ? 'message' : 'messages'} for ${name}`}
        className={`-my-2 flex items-center gap-1 rounded-sm py-2 font-mono text-[10.5px] text-terracotta hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-terracotta ${rowOpen ? 'md:hidden' : ''}`}
      >
        <Mail size={11} aria-hidden="true" className="shrink-0" />
        <span>
          {newMessages}
          <span className="max-md:hidden"> new</span>
        </span>
      </button>
    ) : undefined

  const titleNode = editing ? (
    <input
      autoFocus
      type="text"
      aria-label="new session title"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={confirmEdit}
      className="w-full min-w-0 rounded-md border border-terracotta bg-canvas px-1.5 py-0.5 font-display text-[22px] text-ink outline-none"
    />
  ) : title === null ? (
    <span data-testid="title-loading" aria-live="polite" className="text-ink-2/60">
      Loading…
    </span>
  ) : (
    <button
      type="button"
      onClick={onClickTitle}
      disabled={!meta && !newChatOpen}
      className={`block max-w-full text-left disabled:cursor-default md:truncate ${meta || newChatOpen ? 'hover:opacity-80' : ''}`}
    >
      {/* a phone: two lines of it, then the ellipsis (a button is one
          atomic box — the clamp lives on its text) */}
      <span className="max-md:line-clamp-2">{title}</span>
    </button>
  )

  return (
    <PageHeader
      testId="conversation-header"
      // where it lives: project › agent — each a door up. The agent opens its
      // page (identity, inbox, knows, machinery) with the way back on it.
      crumbs={[
        ...(where ? [{ label: basename(where), title: where, onClick: () => changePage({ kind: 'project', folder: where }) }] : []),
        {
          label: name,
          title: `${name}’s page`,
          onClick: openAgentPage,
          mark: messagesMark,
          node: <AgentPill agent={agent} name={name} role={role} inboxNew={newMessages} open={rowOpen} onOpen={setRowOpen} />,
        },
      ]}
      place={
        gitBranch ? (
          <span data-testid="conversation-branch" className="flex min-w-0 items-center">
            <span className="flex min-w-0 items-center gap-1 font-mono">
              <GitBranch size={11} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 truncate" title={gitBranch}>
                {gitBranch}
              </span>
            </span>
            {branchState ? <BranchStateMark state={branchState} /> : null}
          </span>
        ) : undefined
      }
      fold={rowOpen ? <AgentFold agent={agent} name={name} inboxNew={newMessages} /> : undefined}
      // no seal on the title: the agent's seal lives in its pill above — the
      // title line is the conversation's alone
      title={titleNode}
      // a phone holds a dozen letters of it on one line: two lines there
      wrapTitle="phone"
      // on a phone the role stays on the agent's page (the crumb above is
      // its door). WHERE it lives — project, agent, branch and whether its
      // work landed — is the place line above the title; under the title is
      // what it WORKS on (the task) and what it continues, whole facts only
      facts={
        <>
          <span data-testid="conversation-subtitle" className="contents">
            {runsOwn.pinnedHere ? (
              <Fact>
                <button
                  type="button"
                  data-testid="conversation-runs-own"
                  onClick={() => useStore.getState().openProviderPanel(null)}
                  title={`This conversation runs on ${runsOwn.runsOn} — not ${name}’s default`}
                  className="hover:text-terracotta"
                >
                  on {runsOwn.runsOn.split(' · ')[0]} here
                </button>
              </Fact>
            ) : null}
            {away ? <Fact>away from home, in {basename(where!)}</Fact> : null}
          </span>
          <Fact truncate bare>
            <ConversationTask
              sessionId={selected?.id ?? null}
              unlanded={branchState && !branchState.merged && branchSaid(branchState) ? `not in ${branchState.base} yet` : null}
            />
          </Fact>
          <Fact truncate>
            <ContinuesFrom />
          </Fact>
        </>
      }
      // Console|Chat while the conversation is NEW, and for a TERMINAL session
      // once started: there the switch is real (its transcript in chat, or
      // `claude --resume` in the console) and the selector is the only way
      // from chat to the console (Chat.tsx: chat by choice has no line of its
      // own). A Silos-native session is the SDK's and the selector would
      // promise a switch that cannot happen — hidden. A
      // mode-switch engine (OpenCode: the TUI and `opencode run --session
      // <id>` write the SAME session) keeps it once started; the server hands
      // the session over. On a phone a started session's selector would crush
      // the title, and an xterm is no place for a thumb: desktop only then.
      actions={
        <>
          {!meta ? (
            <ModeSelector inBand />
          ) : meta.native === false || modeSwitch ? (
            <div className="hidden md:block">
              <ModeSelector inBand />
            </div>
          ) : null}
          {extra}
        </>
      }
      // why it was opened and what the fence refused: said once under the
      // facts, in the same muted register — facts, never alerts
      notes={<OpenedForMessage />}
    />
  )
}

// ---------------------------------------------------------------------------
// ConversationView — selected!==null || newChatOpen. Title+meta → the
// transcript → the Context column (only here: Context belongs to the
// CONVERSATION, never to the dossier).
// ---------------------------------------------------------------------------
function ConversationView({ agent }: { agent: AgentView }) {
  const contextOpen = useStore((s) => s.contextOpen)
  const toggleContext = useStore((s) => s.toggleContext)
  const detail = useStore((s) => s.detail)

  // every facet — memory, skills, context included — NAVIGATES to the
  // agent page's section (store.openDossier). The
  // drawer keeps In charge and the live toast.

  // below lg the column never shows, so the pill opens the Knows bottom
  // sheet instead (KnowsSheet.tsx). The sheet steps aside whenever the
  // drawer opens (an "In charge" tap) — in the same commit, so it
  // "becomes" the drawer — and the flag resets so closing it returns to
  // the conversation, not to the sheet. An agent link in the sheet leaves
  // the conversation altogether (the agent page, with ?from=).
  const knowsDrawerOpen = useStore((s) => s.knowsDrawer !== null)
  const [sheetOpen, setSheetOpen] = useState(false)
  useEffect(() => {
    if (knowsDrawerOpen) setSheetOpen(false)
  }, [knowsDrawerOpen])
  const showSheet = sheetOpen && !knowsDrawerOpen

  // the "Context" pill — ALWAYS in the DOM, but lg:hidden while contextOpen
  // is true (the real column takes over there) — below lg it stays visible
  // no matter what (tablet/mobile: context always reachable). From lg up a
  // click reopens the column; below lg it opens the Knows sheet and leaves
  // the pref alone.
  const contextPill = (
    <button
      type="button"
      onClick={() => (isLgViewport() ? toggleContext() : setSheetOpen(true))}
      aria-label="context tab"
      className={`ml-1 flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-ink-2 hover:bg-canvas/60 hover:text-ink ${
        contextOpen ? 'lg:hidden' : ''
      }`}
    >
      Context
      {detail?.context?.pending ? <span aria-hidden="true">⚑</span> : null}
      {detail?.context?.plan ? (
        <span className="font-mono text-[11px]">
          {detail.context.plan.done}/{detail.context.plan.total}
        </span>
      ) : null}
    </button>
  )

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <ConversationHeader agent={agent} extra={contextPill} />
      <div className="flex flex-1 overflow-hidden">
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          <Chat modeSelector={false} />
          {/* anchored to this container's right edge = the context
              column's edge; over the transcript's edge only, never a full cover */}
          <KnowsDrawer agent={agent} />
          <ProviderPanel agent={agent} />
          {showSheet ? <KnowsSheet agent={agent} onClose={() => setSheetOpen(false)} /> : null}
        </div>
        {contextOpen ? <ContextColumn agent={agent} /> : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AgentDossier — selected===null && !newChatOpen: the full header + the one
// composed page (no tab bar). No chat/composer here — starting to chat is
// an explicit act (the header's "New conversation" / "Console").
// ---------------------------------------------------------------------------
function AgentDossier({ agent }: { agent: AgentView }) {
  const tab = useStore((s) => s.tab)

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AgentHeader agent={agent} />
      <div className="flex-1 overflow-hidden">
        <TabBody tab={tab} agent={agent} />
      </div>
    </div>
  )
}

// /agent/<id> for an agent Silos doesn't list here — said in the Home's own
// voice (the UnknownProject pattern), with the doors that land: Home, and
// Settings › Archived agents, where one is restored. Nothing on this
// page starts a conversation.
function UnknownAgent({ id }: { id: string }) {
  const changePage = useStore((s) => s.changePage)
  return (
    <div data-testid="unknown-agent" className="flex flex-1 flex-col overflow-y-auto">
      <div className="flex max-w-[52rem] flex-col gap-2 px-5 pb-12 pt-5 sm:px-8">
        <h1 className="break-all font-display text-[21px] leading-snug text-ink">No agent «{id}» here</h1>
        <p className="font-mono text-[11px] text-ink-3">Archived or removed — nothing runs as it, and nothing opens here.</p>
        <div className="mt-2 flex flex-wrap gap-4 font-mono text-[11px] text-ink-2">
          <button type="button" onClick={() => changePage(null)} className="hover:text-terracotta">
            Back to Home ›
          </button>
          <button type="button" onClick={() => changePage({ kind: 'settings', tab: 'archived' })} className="hover:text-terracotta">
            Archived agents in Settings ›
          </button>
        </div>
      </div>
    </div>
  )
}

export function AgentPage() {
  const page = useStore((s) => s.page)
  const agents = useStore((s) => s.agents)
  const selected = useStore((s) => s.selected)
  const newChatOpen = useStore((s) => s.newChatOpen)

  // a Claude Code-style Esc shortcut (hint "esc to interrupt"): mounted
  // whenever an agent page is open — with or without an agent found (a
  // cold start included). It cancels a streaming turn ONLY while that
  // conversation is on screen (turnOnScreen): on the agent page, or on another conversation, a turn
  // you can't see is never cancelled by a stray Esc.
  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent): void {
      // '?' opens the shortcuts cheat sheet, but only when focus is NOT in
      // a text field — and not if another modal is already open either.
      if (e.key === '?' && !e.defaultPrevented) {
        const el = document.activeElement
        const inTextField = el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
        const otherModalOpen = useStore.getState().modal !== null
        if (!inTextField && !otherModalOpen) {
          e.preventDefault()
          useStore.getState().setModal('shortcuts')
          return
        }
      }
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // Esc inside the terminal (xterm) belongs to the shell itself (e.g.
      // exiting an editor, cancelling a prompt) — it must never be read as
      // "cancel the turn". xterm doesn't always stopPropagation, so it's
      // filtered here by the panel's container (see data-terminal-panel in
      // TerminalPanel.tsx).
      const target = e.target
      if (target instanceof HTMLElement && target.closest('[data-terminal-panel]')) return
      const st = useStore.getState()
      const { cancel, memoryMode, exitMemoryMode } = st
      // the Esc contract: the turn in progress ON SCREEN gets cancelled
      // first — "running turn Esc still cancels" outranks closing UI.
      if (turnOnScreen(st)) {
        void cancel()
        return
      }
      // otherwise: Esc exits the composer's memory mode.
      if (memoryMode) exitMemoryMode()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const agent = page?.kind === 'agent' ? (agents.find((a) => a.id === page.id) ?? null) : null

  // an agent page for an id the store doesn't list (archived, removed, a
  // stale link, a beat door of an archived agent): NEVER the cold-start
  // Chat — Chat opens a real console (a `claude --session-id …` process)
  // for the selected id (third review round). The overview always carries
  // Anywhere, so a non-empty list that lacks the id is a final answer.
  if (page?.kind === 'agent' && !agent && agents.length > 0) return <UnknownAgent id={page.id} />

  if (!agent) {
    // a cold start / page isn't an agent page yet — Chat.tsx (which no
    // longer knows anything about agent identity) decides the correct
    // EmptyState via Transcript, reading selectedAgentId/agents straight
    // from the store.
    return <Chat />
  }

  if (selected || newChatOpen) return <ConversationView agent={agent} />
  return <AgentDossier agent={agent} />
}
