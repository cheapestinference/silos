// CommandPalette.tsx — ⌘K/Ctrl+K from ANYWHERE (always mounted, like
// ShortcutsOverlay) — the ONE new floating element in this phase. Shares
// `modal`'s exclusive slot (never competes with create/create-skill/shortcuts).
// The list = a flat timeline of ALL conversations (lib/conversations.ts),
// filtered by title/agent/project/skill; ↑↓ moves the selection, Enter
// opens, Esc closes (Esc calls preventDefault so AgentPage's global
// handler doesn't read it as "cancel turn").
// a universal navigator: the navigation entries (Map·Org·
// Automations·Settings·Memories·Skills, plus Support where an agent keeps
// cases) are prepended to the conversation search, filtered by the same
// `q` that already filtered conversations.
// The Map's views among them come from the registry (`MAP_VIEWS`), not
// from a hand-written line — see navEntries(); «Map» opens its landing
// view, Uses. Entries navigate via changePage.
// The conversation search itself does NOT change (the same
// lib/conversations.ts, the same match criterion) — just one more
// section prepended to the same `idx`/↑↓/Enter that already existed.
// It finds TASKS too (lib/task-search.ts): by
// title or plan#id over the reading the web already holds, read only while the
// palette is open. An operator (is:untouched, is:mine, owner:finance) asks about
// tasks and nothing else, and offers its view of /tasks as the first row.
// In a conversation it offers the link both ways:
// «Link this conversation to a task…» picks among the agent's open tasks,
// its project first, and writes conversations[] through the silo's own
// append verb; «Make this a task» opens the New task dialog with the
// conversation's title and agent, and links it on create.
import { NEW_ENTRIES } from '../lib/new-entries'
import { useEffect, useMemo, useRef, useState } from 'react'
import { FilterIcon, NewIcon, SearchIcon } from '../lib/icons'
import { useStore } from '../store'
import { MASTER_ID, ANYWHERE_LABEL } from '../lib/constants'
import { useModalBehavior } from './Modal'
import { basename } from '../lib/routes'
import { relTime } from '../lib/rel-time'
import { api } from '../lib/api'
import { matchesConversation, allConversations, type ConversationItem } from '../lib/conversations'
import { mapPageOf, mapViewsFor } from '../lib/map-views'
import type { ArtifactItem, SearchHit } from '../lib/types'
import { descriptorOf } from '../lib/harnesses'
import { useOpenTasksBySession, useTasks, type SessionWork } from '../hooks/useTasks'
import { hasOperators, parseTaskOperators, searchTasks } from '../lib/task-search'
import { parseNewTask, type TaskDraft } from '../lib/new-task'
import { currentTasksOfSession, labelOfKey, linkCandidates, ownerSessionIds, siblingsOf, taskPage, withLiveFlow, type TaskView } from '../lib/tasks'
import { RELEASE_CHOICES, linkConversation, releaseOffersChoice, unlinkConversation } from '../lib/task-link'
import { askableTasks, type AskableTask } from '../lib/task-lines'
import { answerTask, droppedOf, stuckWords } from '../lib/answer-wait'
import { actError } from '../lib/task-gesture'
import { taskPageOfKey } from '../lib/task-origin'
import { refreshTasks } from '../hooks/useTasks'
import type { ReleaseState } from '../lib/api'
import { TasksIcon, UnlinkIcon } from '../lib/icons'
import type { TasksQuery } from '../lib/routes'
import { OwnerMark, TaskGlyph } from './tasks/TaskBits'

// the search's unsearched count by engine id; a server that sends only the
// total names no engine
function unsearchedOf(r: { unsearched?: number; unsearchedBy?: Record<string, number> }): Record<string, number> {
  if (r.unsearchedBy) return Object.fromEntries(Object.entries(r.unsearchedBy).filter(([, n]) => n > 0))
  return (r.unsearched ?? 0) > 0 ? { '': r.unsearched! } : {}
}

// "2 OpenCode conversations"; "2 OpenCode and 1 Fake conversations"; null when none
function unsearchedText(by: Record<string, number>): string | null {
  const entries = Object.entries(by).filter(([, n]) => n > 0)
  if (entries.length === 0) return null
  const total = entries.reduce((a, [, n]) => a + n, 0)
  const parts = entries.map(([id, n]) => (id === '' ? String(n) : `${n} ${descriptorOf(id).label}`))
  const list = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `${list} conversation${total === 1 ? '' : 's'}`
}

const MAX_RESULTS = 50
// artifacts: a secondary source (go behind conversations) — a shorter cap
// of its own so they don't flood the list with an empty query.
const MAX_ARTIFACTS = 20

// the aggregate artifacts list: the same "matches" criterion as
// conversations — the artifact's title or the session that produced it.
function matchesArtifact(a: ArtifactItem, filter: string): boolean {
  const q = filter.trim().toLowerCase()
  if (!q) return true
  return a.title.toLowerCase().includes(q) || a.sessionTitle.toLowerCase().includes(q)
}

// the entries — Settings/Memories/Skills share a page (SettingsPage.tsx, see its newer tabs) — `tab`
// deep-links the right tab on arrival (see each page's sync useEffect).
interface NavEntry {
  label: string
  onSelect: () => void
}

function navEntries(): NavEntry[] {
  const { changePage, selectAgent, silos, agents } = useStore.getState()
  // agents and projects are TYPED entries: «Agent · Acme», «Project · acme»
  // — a bare name collides (an agent Acme, the project ~/acme and a silo
  // page could all read «acme»).
  const liveAgents = agents.filter((a) => !a.archived && a.id !== MASTER_ID)
  const folders = [...new Set(liveAgents.flatMap((a) => [a.folder, ...(a.folders ?? [])]).filter((f): f is string => !!f))]
  return [
    // Home — the Board retired into it:
    // no «Board» row any more, Home's tiles are where its views live
    { label: 'Home', onSelect: () => changePage(null) },
    // every plan task, by preset (task-view phase 2) — «Tasks» names plan
    // tasks and nothing else
    { label: 'Tasks', onSelect: () => changePage({ kind: 'tasks' }) },
    // every page is reachable by its own name (not only through conditional
    // or rail doors) — the word the page's title says
    { label: 'Usage', onSelect: () => changePage({ kind: 'usage' }) },
    { label: 'System › Vitals', onSelect: () => changePage({ kind: 'system' }) },
    { label: 'System › Files', onSelect: () => changePage({ kind: 'files' }) },
    // the global background-work view — what every conversation's
    // subagents are doing right now, in one page.
    { label: 'Background work', onSelect: () => changePage({ kind: 'background' }) },
    // the Map and its sibling views — derived from the MAP_VIEWS registry
    // (product.md: a view that exists is reachable by name), so the
    // next view lands here for free. Typed like everything below:
    // a view is «Map › <its tab>», the Map itself is «Map».
    ...mapViewsFor(silos).map((v) => ({
      label: v.id === 'uses' ? 'Map' : `Map › ${v.label}`,
      onSelect: () => changePage(mapPageOf(v)),
    })),
    // the Vault page — the fleet's keyring (its own surface).
    { label: 'System › Vault', onSelect: () => changePage({ kind: 'vault' }) },
    { label: 'Automations', onSelect: () => changePage({ kind: 'automations' }) },
    { label: 'Settings', onSelect: () => changePage({ kind: 'settings' }) },
    // Settings' sections by their tab's name, typed «Settings › …» —
    // a bare «Memories» read as a page of its own. Silos is the inventory
    // (install, review, retire); its other door is the line under Home's pulse.
    { label: 'Settings › Silos', onSelect: () => changePage({ kind: 'settings', tab: 'silos' }) },
    { label: 'Settings › Memories', onSelect: () => changePage({ kind: 'settings', tab: 'memories' }) },
    { label: 'Settings › Skills', onSelect: () => changePage({ kind: 'settings', tab: 'skills' }) },
    // what a new project starts with — its one house (spec tools-origin §8)
    { label: 'Settings › New projects — what your Claude account sends', onSelect: () => changePage({ kind: 'settings', tab: 'accounts' }) },
    // every ACTIVE silo's list page — a derived surface (the standard: ⌘K is
    // the law of the house, nothing active hides from it). With zero active
    // silos nothing is added. Records are one hop away on the page itself;
    // the ones that need you already ride Home's inbox.
    ...silos
      .filter((s) => s.state === 'active')
      .map((s) => ({
        label: s.name ?? s.id,
        onSelect: () => changePage({ kind: 'silo', id: s.id }),
      })),
    ...liveAgents.map((a) => ({ label: `Agent · ${a.name}`, onSelect: () => selectAgent(a.id) })),
    // its Settings and Secrets tabs by name: who it is and
    // what it runs on · the keys it may use
    ...liveAgents.map((a) => ({
      label: `Agent · ${a.name} › Profile`,
      onSelect: () => {
        selectAgent(a.id)
        useStore.getState().changeTab('identity')
      },
    })),
    ...liveAgents.map((a) => ({
      label: `Agent · ${a.name} › Secrets`,
      onSelect: () => {
        selectAgent(a.id)
        useStore.getState().changeTab('vault')
      },
    })),
    // Anywhere (the master agent) has no sidebar row — its page was reachable
    // only by URL; it is typed like the others
    ...(agents.some((a) => a.id === MASTER_ID) ? [{ label: `Agent · ${ANYWHERE_LABEL}`, onSelect: () => selectAgent(MASTER_ID) }] : []),
    ...folders.map((f) => ({ label: `Project · ${basename(f)}`, onSelect: () => changePage({ kind: 'project', folder: f }) })),
    // what can be started — the same list as the sidebar's "+ New"
    ...NEW_ENTRIES.map((e) => ({ label: e.label, onSelect: e.run })),
  ]
}

type Row =
  | { kind: 'nav'; label: string; onSelect: () => void }
  | { kind: 'conv'; item: ConversationItem }
  | { kind: 'artifact'; item: ArtifactItem }
  // full-text hit INSIDE a conversation's messages (server-side scan) — a
  // different thing from 'conv' (a title/agent match on the client).
  | { kind: 'hit'; hit: SearchHit; item: ConversationItem | null }
  | { kind: 'task'; task: TaskView }
  // an operator's own view of /tasks
  | { kind: 'task-view'; query: TasksQuery; words: string; count: number }
  // the second gesture of the one search door: keep the query as
  // the sidebar list's filter — the sidebar's magnifier opens THIS palette,
  // so the list filter it used to reveal lives here, last, under its name
  | { kind: 'filter'; words: string }
  // «new task: <title> @agent»: the verb typed, the
  // ONE dialog on /tasks opens with it — never a second way to create
  | { kind: 'new-task'; draft: TaskDraft }
  // in a conversation: the two ways to tie it to a task
  | { kind: 'conv-verb'; verb: 'link' | 'make'; label: string }
  // …and the way to let one go: one row per task it is
  // CURRENTLY on — the release verb, the thread turns history
  | { kind: 'unlink-task'; task: SessionWork; choice: boolean }
  // …and, on an in-progress task's last current thread, what it becomes
  | { kind: 'unlink-as'; task: SessionWork; state: ReleaseState; words: string }
  // the link step: one of the agent's open tasks
  | { kind: 'link-task'; task: TaskView }
  // an agent's task that waits on you: «Answer «<asked>»» — its
  // options (or what you type) are the next step, written by answerWait
  | { kind: 'answer-ask'; ask: AskableTask<TaskView> }
  | { kind: 'answer-option'; ask: AskableTask<TaskView>; text: string; typed: boolean }

// the conversation on screen, when there is one a task can be tied to: an
// agent's (not Anywhere's — it owns no tasks), already started
interface ConversationHere {
  folder: string
  id: string
  title: string
  cwd: string | null
  agentId: string
  agentName: string
}
function conversationHere(): ConversationHere | null {
  const { page, selected, selectedAgentId, agents } = useStore.getState()
  if (!selected || (page !== null && page.kind !== 'agent')) return null
  const agent = agents.find((a) => a.id === selectedAgentId) ?? agents.find((a) => a.sessions.some((s) => s.folder === selected.folder && s.id === selected.id))
  if (!agent || agent.id === MASTER_ID) return null
  const s = agent.sessions.find((x) => x.folder === selected.folder && x.id === selected.id)
  return { folder: selected.folder, id: selected.id, title: s?.title ?? '', cwd: s?.cwd ?? agent.folder ?? null, agentId: agent.id, agentName: agent.name }
}

// content hits: a shorter cap — they ride behind the title matches.
const MAX_HITS = 12
// tasks: a few among the rest of the house, more when an operator asked for
// nothing but tasks (the view it offers holds them all)
const MAX_TASKS = 8
const MAX_OPERATOR_TASKS = 30
// the agents' questions to you: a few, the one on screen first
const MAX_ASKS = 4

export function CommandPalette() {
  const modal = useStore((s) => s.modal)
  const setModal = useStore((s) => s.setModal)
  const agents = useStore((s) => s.agents)
  const automations = useStore((s) => s.automations)
  const automationNames = useMemo(() => new Map(automations.map((a) => [a.id, a.name])), [automations])
  const selectAgent = useStore((s) => s.selectAgent)
  const openSession = useStore((s) => s.openSession)
  const open = modal === 'palette'
  const changePage = useStore((s) => s.changePage)
  const taskReading = useTasks(open)
  // the open tasks each conversation is current on — the sidebar's ☑, the
  // server's answer (the reading's walk while it comes)
  const currentBySession = useOpenTasksBySession(open)
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  // the link step (⌘K «Link this conversation to a task…»): the list is the
  // agent's open tasks; Backspace on an empty field steps back
  const [linking, setLinking] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  // «Unlink…» with a choice: the task whose disposition is being chosen
  const [unlinkingTask, setUnlinkingTask] = useState<SessionWork | null>(null)
  // «Answer «…»»: the question being answered (its options, or the typed words)
  const [answering, setAnswering] = useState<AskableTask<TaskView> | null>(null)
  // the server's words after a link or an unlink — said, then the palette closes
  const [said, setSaid] = useState<string | null>(null)
  // an answer that landed while its task stays stuck: said, and the palette
  // stays open on the door to the task's page (its two ways out are there)
  const [saidDoor, setSaidDoor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const here = useMemo(() => (open ? conversationHere() : null), [open, agents]) // eslint-disable-line react-hooks/exhaustive-deps
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([])
  const [hits, setHits] = useState<SearchHit[]>([])
  // conversations whose message text the search could not read (their
  // engine keeps no transcript file — e.g. OpenCode's database), by engine
  // id; titles still match
  const [unsearched, setUnsearched] = useState<Record<string, number>>({})
  const inputRef = useRef<HTMLInputElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  // opens from anywhere — respects the same exclusive slot as the rest of
  // the modals (doesn't open over another one already open).
  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (useStore.getState().modal === null) setModal('palette')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setModal])

  useEffect(() => {
    if (!open) return
    setQ('')
    setIdx(0)
    setLinking(false)
    setLinkError(null)
    setUnlinkingTask(null)
    setAnswering(null)
    setSaid(null)
    setSaidDoor(null)
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [open])

  // the aggregate artifacts list — requested when the palette OPENS (real
  // server data, already capped there), never per keystroke. Promise.resolve
  // + catch: the same defensive pattern as AccountFooter (a test automock /
  // a failed fetch → an empty source, the palette keeps working the same).
  useEffect(() => {
    if (!open) return
    let cancelled = false
    Promise.resolve(api.artifacts())
      .then((r) => {
        if (!cancelled) setArtifacts(r?.artifacts ?? [])
      })
      .catch(() => {
        if (!cancelled) setArtifacts([])
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // full-text search INSIDE messages — debounced per keystroke (the scan
  // reads real files server-side; 3+ chars so a bigram never triggers it).
  useEffect(() => {
    if (!open) return
    const query = q.trim()
    if (linking || query.length < 3 || hasOperators(parseTaskOperators(query))) {
      setHits([])
      setUnsearched({})
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      api
        .search(query)
        .then((r) => {
          if (!cancelled) {
            setHits(r.hits)
            setUnsearched(unsearchedOf(r))
          }
        })
        .catch(() => {
          if (!cancelled) {
            setHits([])
            setUnsearched({})
          }
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [open, q, linking])

  const allConvs = useMemo(() => allConversations(agents), [agents])
  const visibleConversations = useMemo(() => allConvs.filter((c) => matchesConversation(c, q)).slice(0, MAX_RESULTS), [allConvs, q])
  // navigation entries filtered by the SAME `q` — a case-insensitive
  // substring match on the label, empty = all of them.
  const visibleNav = useMemo(() => {
    const query = q.trim().toLowerCase()
    return navEntries().filter((e) => query === '' || e.label.toLowerCase().includes(query))
  }, [q])
  const visibleArtifacts = useMemo(() => artifacts.filter((a) => matchesArtifact(a, q)).slice(0, MAX_ARTIFACTS), [artifacts, q])
  const allTasks = useMemo(() => (open ? withLiveFlow(taskReading.tasks, agents, useStore.getState().nowTick) : []), [open, taskReading.tasks, agents])
  const taskSearch = useMemo(() => {
    const ctx = { agentIds: new Set(agents.map((a) => a.id)), ownerSessions: ownerSessionIds(agents) }
    return searchTasks(allTasks, q, ctx, agents, useStore.getState().nowTick)
  }, [allTasks, q, agents])
  const operators = hasOperators(parseTaskOperators(q))
  const draft = useMemo(() => parseNewTask(q, agents), [q, agents])
  // the tasks this conversation could be working (lib/tasks.ts linkCandidates):
  // the ones its thread already works left out — the header says those
  // — the ones it is CURRENT on left out (the header says those); one it was
  // unlinked from is offered again (linking revives the thread)
  const currentHere = useMemo(() => (here ? (currentBySession.get(here.id) ?? []) : []), [here, currentBySession])
  const candidates = useMemo(() => {
    if (!open || !here || !linking) return []
    const linked = new Set([...currentTasksOfSession(allTasks, here.id).map((t) => t.key), ...currentHere.map((t) => t.key)])
    return linkCandidates(allTasks, { agentId: here.agentId, cwd: here.cwd, linked, agents, now: useStore.getState().nowTick }, q)
  }, [open, here, linking, allTasks, agents, q, currentHere])
  // the agents' questions to you — the task on screen (its page, or the
  // conversation's) first
  const asks = useMemo(() => {
    if (!open) return []
    const { page } = useStore.getState()
    const first = new Set([...(page?.kind === 'task' ? [`${page.plan}/tasks/${page.task}`] : []), ...currentHere.map((t) => t.key)])
    const ids = new Set(agents.map((a) => a.id))
    return askableTasks(allTasks, (id) => ids.has(id), first)
  }, [open, allTasks, agents, currentHere])
  const rows: Row[] = useMemo(() => {
    if (answering) {
      const typed = q.trim()
      const opts = answering.options.filter((o) => typed === '' || o.toLowerCase().includes(typed.toLowerCase()))
      return [
        ...opts.map((text): Row => ({ kind: 'answer-option', ask: answering, text, typed: false })),
        ...(typed !== '' && !answering.options.some((o) => o.toLowerCase() === typed.toLowerCase())
          ? [{ kind: 'answer-option', ask: answering, text: typed, typed: true } as Row]
          : []),
      ]
    }
    if (unlinkingTask) {
      return RELEASE_CHOICES.map((c): Row => ({
        kind: 'unlink-as',
        task: unlinkingTask,
        state: c.state,
        words: c.state === 'blocked' ? 'blocked — on you' : c.words,
      }))
    }
    if (linking) return candidates.slice(0, MAX_OPERATOR_TASKS).map((task): Row => ({ kind: 'link-task', task }))
    const lead: Row[] = draft ? [{ kind: 'new-task', draft }] : []
    // the conversation's two verbs, filtered by the same words as the nav
    const typed = q.trim().toLowerCase()
    const unlinkLabel = (t: SessionWork): string => `Unlink… this conversation from «${t.title}»`
    const choiceOf = (t: SessionWork): boolean => {
      const full = allTasks.find((x) => x.key === t.key)
      return full ? releaseOffersChoice(full) : false
    }
    const verbs: Row[] =
      here && !operators && !draft
        ? [
            ...(
              [
                { kind: 'conv-verb', verb: 'link', label: 'Link this conversation to a task…' },
                { kind: 'conv-verb', verb: 'make', label: 'Make this a task' },
              ] as const
            ).filter((v) => typed === '' || v.label.toLowerCase().includes(typed)),
            ...currentHere
              .filter((t) => typed === '' || unlinkLabel(t).toLowerCase().includes(typed))
              .map((task): Row => ({ kind: 'unlink-task', task, choice: choiceOf(task) })),
          ]
        : []
    const askRows: Row[] =
      !operators && !draft
        ? asks
            .filter((a) => typed === '' || `answer ${a.asked} ${a.task.title}`.toLowerCase().includes(typed))
            .slice(0, MAX_ASKS)
            .map((ask): Row => ({ kind: 'answer-ask', ask }))
        : []
    const taskRows = taskSearch.tasks.slice(0, operators ? MAX_OPERATOR_TASKS : MAX_TASKS).map((task): Row => ({ kind: 'task', task }))
    if (operators) {
      return [
        ...lead,
        ...(taskSearch.view ? [{ kind: 'task-view', query: taskSearch.view.query, words: taskSearch.view.words, count: taskSearch.tasks.length } as Row] : []),
        ...taskRows,
      ]
    }
    // content hits behind title matches, deduped against them: a session
    // whose TITLE already matched doesn't need its snippet row too.
    const shown = new Set(visibleConversations.map((c) => `${c.folder}/${c.id}`))
    const byKey = new Map(allConvs.map((c) => [`${c.folder}/${c.id}`, c]))
    const hitRows = hits
      .filter((h) => !shown.has(`${h.folder}/${h.id}`))
      .slice(0, MAX_HITS)
      .map((h): Row => ({ kind: 'hit', hit: h, item: byKey.get(`${h.folder}/${h.id}`) ?? null }))
    const words = q.trim()
    return [
      ...lead,
      ...verbs,
      ...askRows,
      ...visibleNav.map((e): Row => ({ kind: 'nav', label: e.label, onSelect: e.onSelect })),
      ...taskRows,
      ...visibleConversations.map((item): Row => ({ kind: 'conv', item })),
      ...hitRows,
      ...visibleArtifacts.map((item): Row => ({ kind: 'artifact', item })),
      ...(words !== '' ? [{ kind: 'filter', words } as Row] : []),
    ]
  }, [
    visibleNav,
    visibleConversations,
    visibleArtifacts,
    hits,
    allConvs,
    taskSearch,
    operators,
    draft,
    here,
    linking,
    candidates,
    q,
    currentHere,
    unlinkingTask,
    allTasks,
    answering,
    asks,
  ])

  useEffect(() => setIdx(0), [q])

  function openConversation(item: ConversationItem): void {
    selectAgent(item.agentId)
    void openSession(item.folder, item.id)
    setModal(null)
  }

  function activate(row: Row): void {
    if (row.kind === 'conv-verb') {
      if (!here) return
      if (row.verb === 'link') {
        setLinking(true)
        setLinkError(null)
        setQ('')
        setIdx(0)
        inputRef.current?.focus()
      } else {
        // the ONE dialog (on /tasks), handed the conversation's title, its
        // agent as owner and the conversation to list once the task exists
        useStore.setState({ taskDraft: { title: here.title, owner: here.agentId, conversation: { folder: here.folder, id: here.id } } })
        changePage({ kind: 'tasks' })
        setModal(null)
      }
      return
    }
    const sayThenClose = (words: string): void => {
      setSaid(words)
      setTimeout(() => setModal(null), 1400)
    }
    const unlink = (task: SessionWork, state?: ReleaseState): void => {
      if (!here || busy) return
      setBusy(true)
      setLinkError(null)
      // «blocked — on you»: the wait rides the release's own write —
      // written only when it does land blocked
      unlinkConversation(task.key, here.id, state, state === 'blocked' ? { owner: 'owner', action: 'unblock it' } : null)
        .then((r) => sayThenClose(r.warn ? `${r.said} ${r.warn}` : r.said))
        .catch((e: unknown) => setLinkError(`Not unlinked: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => setBusy(false))
    }
    if (row.kind === 'answer-ask') {
      setAnswering(row.ask)
      setLinkError(null)
      setQ('')
      setIdx(0)
      inputRef.current?.focus()
      return
    }
    if (row.kind === 'answer-option') {
      if (busy) return
      setBusy(true)
      setLinkError(null)
      // ONE write (lib/answer-wait.ts answerTask): the gate's respond, or the
      // verb answer with the question this row painted; a refusal is said here
      const t = row.ask.task
      answerTask(t, row.text, new Set(useStore.getState().agents.map((a) => a.id)))
        .then((r) => {
          refreshTasks()
          const key = t.key
          const stuck = droppedOf(r.holds, t, taskReading.tasks)
          if (stuck.length > 0) {
            setSaid(
              `Answered — but ${stuckWords(stuck, (id) => labelOfKey(taskReading.tasks, `${key.slice(0, key.lastIndexOf('/tasks/'))}/tasks/${id}`, key))}.`,
            )
            setSaidDoor(key)
            setAnswering(null)
          } else sayThenClose(r.holds.length === 0 && !r.closed ? 'Answered — it is to pick up again.' : 'Answered.')
        })
        .catch((e: unknown) => setLinkError(`Not answered: ${actError(e)}`))
        .finally(() => setBusy(false))
      return
    }
    if (row.kind === 'unlink-task') {
      if (row.choice) {
        setUnlinkingTask(row.task)
        setQ('')
        setIdx(0)
        inputRef.current?.focus()
        return
      }
      unlink(row.task)
      return
    }
    if (row.kind === 'unlink-as') {
      unlink(row.task, row.state)
      return
    }
    if (row.kind === 'link-task') {
      if (!here || busy) return
      setBusy(true)
      setLinkError(null)
      linkConversation(row.task.key, here.id)
        .then((r) => (r.warn ? sayThenClose(`Linked. ${r.warn}`) : setModal(null)))
        .catch((e: unknown) => setLinkError(`Not linked: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => setBusy(false))
      return
    }
    if (row.kind === 'nav') {
      row.onSelect()
      setModal(null)
    } else if (row.kind === 'task') {
      changePage(taskPage(row.task))
      setModal(null)
    } else if (row.kind === 'filter') {
      // the filter is the conversations tree's; on a phone the list is its
      // own screen, so it comes up to show what the filter left
      const { setFilter, setSidebarList, sidebarList } = useStore.getState()
      setFilter(row.words)
      if (sidebarList !== 'conversations') setSidebarList('conversations')
      useStore.setState({ mobileView: 'list' })
      setModal(null)
    } else if (row.kind === 'new-task') {
      useStore.setState({ taskDraft: row.draft })
      changePage({ kind: 'tasks' })
      setModal(null)
    } else if (row.kind === 'task-view') {
      changePage({ kind: 'tasks', ...row.query })
      setModal(null)
    } else if (row.kind === 'artifact') {
      // the artifact lives on claude.ai — the URL opens as-is, with no
      // in-product navigation (the source conversation stays reachable via
      // the session's row, which already appears as 'conv' if it matches).
      window.open(row.item.url, '_blank', 'noopener,noreferrer')
      setModal(null)
    } else if (row.kind === 'hit') {
      if (row.item) openConversation(row.item)
      else {
        // a session the overview doesn't carry (e.g. an agent's older
        // thread) — openSession resolves the owning agent server-side.
        void openSession(row.hit.folder, row.hit.id)
        setModal(null)
      }
    } else {
      openConversation(row.item)
    }
  }

  useEffect(() => {
    if (!open) return
    function onKeyDown(e: globalThis.KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        setModal(null)
        return
      }
      // the link step (and the unlink choice): Backspace on an empty field steps back to everything
      if (e.key === 'Backspace' && (linking || unlinkingTask || answering) && inputRef.current?.value === '') {
        e.preventDefault()
        setLinking(false)
        setUnlinkingTask(null)
        setAnswering(null)
        setLinkError(null)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setIdx((i) => Math.min(i + 1, rows.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const row = rows[idx]
        if (row) activate(row)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rows, idx, linking, unlinkingTask, answering])

  // body scroll-lock, Tab focus-trap and focus-restore (its own handler above
  // owns Escape + arrow/enter nav; a second Escape here is idempotent).
  useModalBehavior(cardRef, () => setModal(null), { enabled: open, initialFocusRef: inputRef })

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/20 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setModal(null)
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={linking ? 'Link this conversation to a task' : 'Search conversations'}
        className="modal-pop flex max-h-[60vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-canvas shadow-lg"
      >
        {unlinkingTask && here ? (
          <div
            data-testid="palette-unlink-head"
            className="flex shrink-0 items-center gap-2 border-b border-line/70 bg-panel/50 px-3.5 py-2 text-[12px] text-ink-2"
          >
            <UnlinkIcon size={13} strokeWidth={2} aria-hidden="true" className="shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1 truncate">
              Unlink <span className="text-ink">«{here.title || 'this conversation'}»</span> — leave <span className="text-ink">«{unlinkingTask.title}»</span>…
            </span>
            <button
              type="button"
              onClick={() => {
                setUnlinkingTask(null)
                setLinkError(null)
                inputRef.current?.focus()
              }}
              className="shrink-0 text-[11.5px] text-ink-3 hover:text-ink"
              title="Back to everything (⌫ on an empty field)"
            >
              Back
            </button>
          </div>
        ) : null}
        {answering ? (
          <div
            data-testid="palette-answer-head"
            className="flex shrink-0 items-center gap-2 border-b border-line/70 bg-panel/50 px-3.5 py-2 text-[12px] text-ink-2"
          >
            <span className="min-w-0 flex-1 truncate">
              {agents.find((a) => a.id === answering.task.owner)?.name ?? answering.task.owner} asks <span className="text-ink">«{answering.asked}»</span>
              <span className="text-ink-3"> — {answering.task.title}</span>
            </span>
            <button
              type="button"
              onClick={() => {
                setAnswering(null)
                setLinkError(null)
                setQ('')
                inputRef.current?.focus()
              }}
              className="shrink-0 text-[11.5px] text-ink-3 hover:text-ink"
              title="Back to everything (⌫ on an empty field)"
            >
              Back
            </button>
          </div>
        ) : null}
        {said ? (
          <p role="status" data-testid="palette-said" className="shrink-0 border-b border-line/70 px-3.5 py-2 text-[12.5px] text-ink">
            {said}
            {saidDoor ? (
              <>
                {' '}
                <button
                  type="button"
                  data-testid="palette-said-door"
                  onClick={() => {
                    const p = taskPageOfKey(saidDoor)
                    setModal(null)
                    if (p) changePage(p)
                  }}
                  className="text-terracotta underline decoration-terracotta/40 underline-offset-2"
                >
                  Open the task ›
                </button>
              </>
            ) : null}
          </p>
        ) : null}
        {linking && here ? (
          <div
            data-testid="palette-link-head"
            className="flex shrink-0 items-center gap-2 border-b border-line/70 bg-panel/50 px-3.5 py-2 text-[12px] text-ink-2"
          >
            <TasksIcon size={13} strokeWidth={2} aria-hidden="true" className="shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1 truncate">
              Link <span className="text-ink">«{here.title || 'this conversation'}»</span> to one of {here.agentName}&apos;s open tasks
            </span>
            <button
              type="button"
              onClick={() => {
                setLinking(false)
                setLinkError(null)
                inputRef.current?.focus()
              }}
              className="shrink-0 text-[11.5px] text-ink-3 hover:text-ink"
              title="Back to everything (⌫ on an empty field)"
            >
              Back
            </button>
          </div>
        ) : null}
        <div className="relative shrink-0 border-b border-line px-3 py-2.5">
          <SearchIcon size={14} className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-ink-2" />
          <input
            ref={inputRef}
            type="text"
            aria-label="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              answering
                ? answering.options.length > 0
                  ? 'Pick an answer — or type your own'
                  : 'Type your answer'
                : linking
                  ? 'Which task is this conversation working on?'
                  : 'Search everything — or is:untouched, owner:finance, new task: … @finance'
            }
            className="w-full bg-transparent py-1 pl-6 pr-2 text-sm text-ink outline-none placeholder:text-ink-2"
          />
        </div>
        <ul role="listbox" aria-label="results" className="flex-1 overflow-y-auto p-1.5">
          {/* the filter row alone is not a result: nothing found says so */}
          {linking && rows.length === 0 && here ? (
            <li data-testid="palette-link-empty" className="px-3 py-3 text-[13px] text-ink-2">
              {q.trim() !== '' ? (
                <>None of {here.agentName}&apos;s open tasks matches.</>
              ) : (
                <>{here.agentName} has no open task this conversation isn&apos;t already on.</>
              )}{' '}
              <button
                type="button"
                onClick={() => activate({ kind: 'conv-verb', verb: 'make', label: '' })}
                className="text-ink underline decoration-line underline-offset-2 hover:text-terracotta"
              >
                Make this a task
              </button>
            </li>
          ) : answering && rows.length === 0 ? (
            <li data-testid="palette-answer-empty" className="px-3 py-3 text-[13px] text-ink-2">
              Type your answer — it goes to {agents.find((a) => a.id === answering.task.owner)?.name ?? answering.task.owner} as your note, and the wait clears.
            </li>
          ) : !linking && rows.every((r) => r.kind === 'filter') ? (
            <li className="px-3 py-3 text-sm text-ink-2">No results.</li>
          ) : null}
          {rows.map((row, i) =>
            row.kind === 'conv-verb' ? (
              <li key={`verb-${row.verb}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === idx}
                  data-testid={`palette-${row.verb}-task`}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => activate(row)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${i === idx ? 'bg-panel' : ''}`}
                >
                  {row.verb === 'link' ? (
                    <TasksIcon size={13} strokeWidth={2} aria-hidden="true" className="shrink-0 text-ink-2" />
                  ) : (
                    <NewIcon size={13} aria-hidden="true" className="shrink-0 text-terracotta" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{row.label}</span>
                  <span className="max-w-[45%] shrink-0 truncate text-[12px] text-ink-3">{here?.title ? `«${here.title}»` : ''}</span>
                </button>
              </li>
            ) : row.kind === 'unlink-task' ? (
              <li key={`unlink-${row.task.key}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === idx}
                  aria-disabled={busy || undefined}
                  data-testid="palette-unlink-task"
                  data-task={row.task.ref}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => activate(row)}
                  title="The task keeps this conversation in its history; it stops being the one working it"
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${i === idx ? 'bg-panel' : ''} ${busy ? 'opacity-60' : ''}`}
                >
                  <UnlinkIcon size={13} strokeWidth={2} aria-hidden="true" className="shrink-0 text-ink-2" />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    Unlink{row.choice ? '…' : ''} this conversation from <span className="text-ink">«{row.task.title}»</span>
                  </span>
                  <span className="max-w-[30%] shrink-0 truncate font-mono text-[11px] text-ink-3">
                    {allTasks.find((x) => x.key === row.task.key)?.label ?? row.task.ref}
                  </span>
                </button>
              </li>
            ) : row.kind === 'unlink-as' ? (
              <li key={`unlink-as-${row.state}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === idx}
                  aria-disabled={busy || undefined}
                  data-testid="palette-unlink-as"
                  data-state={row.state}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => activate(row)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${i === idx ? 'bg-panel' : ''} ${busy ? 'opacity-60' : ''}`}
                >
                  <UnlinkIcon size={13} strokeWidth={2} aria-hidden="true" className="shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    Unlink — leave it <span className={row.state === 'pending' ? 'font-medium' : ''}>{row.words}</span>
                  </span>
                  {row.state === 'pending' ? <span className="shrink-0 text-[11.5px] text-ink-3">default</span> : null}
                </button>
              </li>
            ) : row.kind === 'answer-ask' ? (
              <li key={`answer-${row.ask.task.key}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === idx}
                  data-testid="palette-answer-ask"
                  data-task={row.ask.task.ref}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => activate(row)}
                  title={`${row.ask.task.title} — ${row.ask.task.label}`}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${i === idx ? 'bg-panel' : ''}`}
                >
                  <span
                    aria-hidden="true"
                    className="flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-full border border-terracotta text-[9px] font-semibold leading-none text-terracotta"
                  >
                    ?
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">Answer «{row.ask.asked}»</span>
                  <span className="max-w-[35%] shrink-0 truncate text-[11.5px] text-ink-3">
                    {row.ask.options.length > 0 ? `${row.ask.options.length} ${row.ask.options.length === 1 ? 'choice' : 'choices'} · ` : ''}
                    {agents.find((a) => a.id === row.ask.task.owner)?.name ?? row.ask.task.owner}
                  </span>
                </button>
              </li>
            ) : row.kind === 'answer-option' ? (
              <li key={`answer-option-${row.typed ? 'typed' : row.text}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === idx}
                  aria-disabled={busy || undefined}
                  data-testid="palette-answer-option"
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => activate(row)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${i === idx ? 'bg-panel' : ''} ${busy ? 'opacity-60' : ''}`}
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    {row.typed ? (
                      <>
                        Answer <span className="font-medium">«{row.text}»</span>
                      </>
                    ) : (
                      <span className="font-medium">{row.text}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-[11.5px] text-ink-3">{row.typed ? 'your words' : 'its choice'}</span>
                </button>
              </li>
            ) : row.kind === 'link-task' ? (
              <li key={`link-${row.task.key}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === idx}
                  aria-disabled={busy || undefined}
                  data-testid="palette-link-option"
                  data-task={row.task.ref}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => activate(row)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${i === idx ? 'bg-panel' : ''} ${busy ? 'opacity-60' : ''}`}
                >
                  <span className="flex text-[13px]">
                    <TaskGlyph t={row.task} plan={siblingsOf(allTasks, row.task.planKey)} agents={agents} now={useStore.getState().nowTick} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{row.task.title}</span>
                  {/* where it lives: its plan, and its project only when it
                        is not this conversation's (those come first) */}
                  <span title={row.task.ref} className="max-w-[42%] shrink-0 truncate text-[11.5px] text-ink-3">
                    {/* the project's list has no name: only the project says where */}
                    {row.task.standingList ? (
                      row.task.folder ? (
                        basename(row.task.folder)
                      ) : (
                        ''
                      )
                    ) : (
                      <>
                        {row.task.planTitle}
                        {row.task.folder && !(here?.cwd && (here.cwd === row.task.folder || here.cwd.startsWith(`${row.task.folder}/`)))
                          ? ` · ${basename(row.task.folder)}`
                          : ''}
                      </>
                    )}
                  </span>
                </button>
              </li>
            ) : row.kind === 'nav' ? (
              <li key={`nav-${row.label}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === idx}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => activate(row)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${i === idx ? 'bg-panel' : ''}`}
                >
                  <span className="text-sm text-ink">{row.label}</span>
                </button>
              </li>
            ) : row.kind === 'filter' ? (
              <li key="filter-list" className="mt-1 border-t border-line pt-1">
                <button
                  type="button"
                  role="option"
                  aria-selected={i === idx}
                  data-testid="palette-filter-list"
                  // a name of its own, not the query echoed back: the row
                  // must never read as one more match for what was typed
                  aria-label="Filter the sidebar list to what you typed"
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => activate(row)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${i === idx ? 'bg-panel' : ''}`}
                >
                  <FilterIcon size={13} aria-hidden="true" className="shrink-0 text-ink-2" />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-2">
                    Filter the list to <span className="text-ink">“{row.words}”</span>
                  </span>
                </button>
              </li>
            ) : row.kind === 'new-task' ? (
              <li key="new-task">
                <button
                  type="button"
                  role="option"
                  aria-selected={i === idx}
                  data-testid="palette-new-task"
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => activate(row)}
                  className={`flex w-full items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left ${i === idx ? 'bg-panel' : ''}`}
                >
                  <NewIcon size={13} aria-hidden="true" className="shrink-0 self-center text-terracotta" />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    New task
                    {row.draft.title ? (
                      <>
                        : <span className="text-ink">“{row.draft.title}”</span>
                      </>
                    ) : (
                      '…'
                    )}
                  </span>
                  <span className="shrink-0 text-[12px] text-ink-2">
                    for{' '}
                    {row.draft.owner === null || row.draft.owner === 'owner' ? 'you' : (agents.find((a) => a.id === row.draft.owner)?.name ?? row.draft.owner)}
                  </span>
                </button>
              </li>
            ) : row.kind === 'task-view' ? (
              <li key="task-view">
                <button
                  type="button"
                  role="option"
                  aria-selected={i === idx}
                  data-testid="palette-task-view"
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => activate(row)}
                  className={`flex w-full items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left ${i === idx ? 'bg-panel' : ''}`}
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{row.words} in Tasks</span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-3">{row.count}</span>
                </button>
              </li>
            ) : row.kind === 'task' ? (
              <li key={`task-${row.task.key}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === idx}
                  data-testid="palette-task"
                  data-task={row.task.ref}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => activate(row)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${i === idx ? 'bg-panel' : ''}`}
                >
                  <span className="flex text-[13px]">
                    <TaskGlyph t={row.task} plan={siblingsOf(allTasks, row.task.planKey)} agents={agents} now={useStore.getState().nowTick} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{row.task.title}</span>
                  <span className="max-w-[40%] shrink-0 truncate font-mono text-[11px] text-ink-3" title={row.task.ref}>
                    {row.task.label}
                  </span>
                  <OwnerMark owner={row.task.owner} agents={agents} compact />
                </button>
              </li>
            ) : row.kind === 'hit' ? (
              <li key={`hit-${row.hit.folder}/${row.hit.id}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === idx}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => activate(row)}
                  className={`flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left ${i === idx ? 'bg-panel' : ''}`}
                >
                  <span className="w-full truncate text-sm text-ink">
                    <span className="text-ink-2">in:</span> {row.item?.title ?? 'conversation'}
                    {row.hit.count > 1 ? <span className="ml-1.5 font-mono text-[10px] text-ink-3">×{row.hit.count}</span> : null}
                  </span>
                  <span className="w-full truncate text-[12px] text-ink-2">{row.hit.snippet}</span>
                </button>
              </li>
            ) : row.kind === 'artifact' ? (
              <li key={`artifact-${row.item.sessionKey}:${row.item.url}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === idx}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => activate(row)}
                  className={`flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left ${i === idx ? 'bg-panel' : ''}`}
                >
                  <span className="w-full truncate text-sm text-ink">
                    <span className="text-ink-2">artifact:</span> {row.item.title}
                  </span>
                  <div className="flex w-full items-center gap-1.5 font-mono text-[11px] text-ink-2">
                    <span className="truncate"># {row.item.sessionTitle}</span>
                    {Number.isFinite(Date.parse(row.item.ts)) ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="shrink-0">{relTime(Date.parse(row.item.ts))}</span>
                      </>
                    ) : null}
                  </div>
                </button>
              </li>
            ) : (
              <li key={`${row.item.folder}/${row.item.id}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === idx}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => activate(row)}
                  className={`flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left ${i === idx ? 'bg-panel' : ''}`}
                >
                  <span className="w-full truncate text-sm text-ink">{row.item.title}</span>
                  <div className="flex w-full items-center gap-1.5 font-mono text-[11px] text-ink-2">
                    <span className="truncate">
                      {row.item.agentEmoji} {row.item.agentId === MASTER_ID ? 'Anywhere' : row.item.agentName}
                    </span>
                    {/* an automation's conversation says so — findable, labelled, never hidden */}
                    {row.item.automationId ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="truncate" data-testid="palette-automation">
                          ⚡ {automationNames.get(row.item.automationId) ?? 'automation'}
                        </span>
                      </>
                    ) : null}
                    {/* a conversation a /clear left behind: not in the sidebar, found here, and it says so */}
                    {row.item.archived ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="shrink-0" data-testid="palette-archived">
                          archived
                        </span>
                      </>
                    ) : null}
                    {row.item.project ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="truncate">{basename(row.item.project)}</span>
                      </>
                    ) : null}
                    <span aria-hidden="true">·</span>
                    <span className="shrink-0">{relTime(row.item.mtime)}</span>
                  </div>
                </button>
              </li>
            ),
          )}
        </ul>
        {linkError ? (
          <p role="alert" className="border-t border-line px-3 py-1.5 text-[12px] text-terracotta">
            {linkError}
          </p>
        ) : null}
        {linking && rows.length > 0 ? (
          <p className="border-t border-line px-3 py-1.5 text-[11px] text-ink-3">↵ links it — the task lists this conversation · ⌫ back</p>
        ) : null}
        {unsearchedText(unsearched) && q.trim().length >= 3 ? (
          <p className="border-t border-line px-3 py-1.5 font-mono text-[10px] text-ink-3">
            Message text not searched in {unsearchedText(unsearched)} — titles are
          </p>
        ) : null}
      </div>
    </div>
  )
}
