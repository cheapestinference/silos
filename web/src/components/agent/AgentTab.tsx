// AgentTab.tsx — the agent page: EVERYTHING the agent reaches, each thing
// with its owner — scope matters here: show what it can access, filtered by
// scope. Measured on
// the owner's fleet, most of what an agent reaches is not its own — the
// project folder's (Builder, Finance, Writer and Helpdesk read the same 274 notes and
// 14 folder skills) or the operator's machine (62 skills, ~19 MCP servers
// on every agent). So every list groups by owner — the agent · the
// project · Silos · you — with one scope filter, each group saying whom
// else it reaches and linking to its house; switches only live there.
//   - tabs: Now · Messages · Memory · Files · Skills · Tools · Secrets ·
//     At start · Settings;
//   - Now = what is alive, and what happens without you in ONE block: the
//     control ladder, its heartbeat, its limits and its automations;
//   - Secrets = what of the Vault reaches it, each with whom it is shared
//     with — the same grammar as Skills and Tools;
//   - At start = what a new conversation starts with, measured per mode;
//   - Settings = the last tab, ONE flat page: who it is, what it runs on.
//     The rule: a thing with a list is edited in its list; Settings
//     holds only the agent's own fields, each edited in the card that
//     shows it. (It had four sub-tabs — Identity · Runs on · Secrets ·
//     Automations — a drawer for whatever had no tab.)
// Every link (a URL facet, the conversation's column) lands on its tab;
// moving writes the facet back. Nouns, not questions.
import { toolsDoorWords } from '../../lib/loads-view'
import { Tile, TileGrid } from '../Tile'
import { SectionTabs } from '../HeaderTabs'
import { useEffect, useState, type ReactNode } from 'react'
import { MissionHeader } from './MissionHeader'
import { FileViewer } from '../FileViewer'
import { NowCard } from './NowCard'
import { WhoCard } from './WhoCard'
import { SiloAgentSections } from '../silo/SiloAgentSection'
import { MessagesTab } from './MessagesTab'
import { GivenToConversations } from './GivenToConversations'
import { RunsOnCard } from './RunsOnCard'
import { AgentVaultZone } from './VaultZone'
import { effectiveVaultFor } from '../../lib/vault-view'
import { ArtifactsBlock, FilesParts } from '../ArtifactsBlock'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { memoryNotes } from '../../lib/knows-anatomy'
import { useKnowsSources } from '../knows/KnowsAnatomy'
import { useFromConversation } from './from-conversation'
import { KnowsLibrary } from '../knows/KnowsLibrary'
import { MemoryDetail } from '../knows/KnowsDetail'
import { AtStart, leadMode, useAgentStartedWith } from './AtStart'
import { useTasks } from '../../hooks/useTasks'
import { ControlSwitch } from './ControlSwitch'
import { Section } from './Section'
import { AgentAutomations, useAgentAutomationsFigure } from './Automations'
import { FirstMeeting } from './FirstMeeting'
import { isFinished } from '../../lib/team-plan'
import { MASTER_ID } from '../../lib/constants'
import type { AgentView } from '../../lib/types'
import type { Tab } from '../../store'
import { agentTabs, agentToolsFigure, AGENT_TAB_FACET, type AgentSectionId } from '../../lib/agent-tabs'
import { tabSignal } from './tab-signal'

export type AgentFocus = 'memory' | 'vault' | 'control' | 'who' | 'skills' | 'context' | 'mission' | 'loaded' | 'tools' | 'inbox' | null

type SectionId = AgentSectionId

// where a facet (a URL, a column link) lands
function landing(focus: AgentFocus): { section: SectionId } {
  switch (focus) {
    case 'memory':
      return { section: 'memory' }
    case 'context':
      return { section: 'files' }
    case 'skills':
      return { section: 'skills' }
    case 'tools':
      return { section: 'tools' }
    case 'loaded':
      return { section: 'starts' }
    case 'inbox':
      return { section: 'messages' }
    case 'who':
      return { section: 'settings' }
    // its mission heads its Profile; its control is set on its Automations (owner 24-11)
    case 'mission':
      return { section: 'settings' }
    case 'control':
      return { section: 'automations' }
    case 'vault':
      return { section: 'secrets' }
    default:
      return { section: 'now' }
  }
}

// and back: the facet a tab (and a settings part) is addressed by
const FACET = AGENT_TAB_FACET

export function AgentTab({ agent, focus = null }: { agent: AgentView; focus?: AgentFocus }) {
  const first = landing(focus)
  const [section, setSection] = useState<SectionId>(first.section)
  // Files · Artifacts — an address, the same two parts as the project's Files
  const files = useStore((s) => s.filesPart)
  // the Settings card whose editor is open — one at a time
  const [editing, setEditing] = useState<'who' | 'runs' | null>(null)
  const [writingOwn, setWritingOwn] = useState(false)
  const [viewerPath, setViewerPath] = useState<string | null>(null)
  const changeTab = useStore((s) => s.changeTab)
  // the conversation this page was opened from (the return chip): opening an
  // agent's tab leaves the conversation, so `selected` is gone — agentFrom is it
  const selectedId = useStore((s) => s.selected?.id ?? s.agentFrom?.id)
  const selectedFolder = useStore((s) => s.selected?.folder ?? s.agentFrom?.folder)
  const knowsVersion = useStore((s) => s.knowsVersion)
  const src = useKnowsSources(agent, knowsVersion.memory + knowsVersion.skills + knowsVersion.context)
  // opened from one of its conversations: Tools, Skills and Memory gain
  // that conversation's line in each row's «Where it loads»
  const fromHere = useFromConversation(agent, src)
  // the row (or chip) a door named — the column's «Turn off ›», its sign-ins
  const dossierItem = useStore((s) => s.dossierItem)
  const dossierFilter = useStore((s) => s.dossierFilter)
  const [inboxNew, setInboxNew] = useState(0)
  // moving writes the facet back — the URL names where you are
  const address = (t: Tab): void => {
    changeTab(t)
  }

  // a new link (or another agent in the same instance) re-aims the page
  useEffect(() => {
    setSection(landing(focus).section)
    setEditing(null)
    setWritingOwn(false)
    setViewerPath(null)
  }, [agent.id, focus])

  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => api.messages.list(agent.id, 'new'))
      .then((m) => {
        if (!cancelled) setInboxNew(Array.isArray(m) ? m.length : 0)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [agent.id])

  // what of the Vault reaches it — the Secrets tab's count
  const [secrets, setSecrets] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    setSecrets(null)
    Promise.resolve(api.vault.list())
      .then((v) => {
        if (!cancelled && v) setSecrets(effectiveVaultFor(v, agent.id, agent.folder).length)
      })
      .catch(() => {
        /* unread: the tab opens without a count */
      })
    return () => {
      cancelled = true
    }
  }, [agent.id, agent.folder, section])

  // its tasks and whether its tasks wake it — the cover answers «how do I know?»
  // without a visit to the silo page; the fact is the BINDING
  // alone, never a claim about heartbeats or plan watches (those are the
  // autonomy block's)
  const changePage = useStore((s) => s.changePage)
  const loadSilos = useStore((s) => s.loadSilos)
  useEffect(() => {
    void loadSilos()
  }, [loadSilos])
  const tasksReading = useTasks(section === 'now')
  const openTasks = tasksReading.tasks.filter((t) => t.owner === agent.id && !isFinished(t.state))

  // what a new conversation starts with — MEASURED per mode, never estimated
  const atStart = useAgentStartedWith(agent.id)
  const lead = leadMode(atStart)
  const leadM = lead ? atStart![lead]! : null
  const notes = memoryNotes(src.memory)
  const learned = notes.filter((n) => n.author === agent.id).length
  const ownMemory = src.memory?.agent ?? null
  const deliverables = src.context?.agent.length ?? 0
  const shared = src.context?.shared.length ?? 0
  const working = src.produced?.length ?? 0
  const activeSkills = (src.catalog ?? []).filter((s) => (s.state ?? 'active') === 'active').length
  const projectName = agent.folder ? agent.folder.slice(agent.folder.lastIndexOf('/') + 1) : null
  const live = agent.sessions.some((s) => s.live)
  // what it loads: its own servers and, where its folder is a project, the
  // inventory's things that load there (a plugin once, its servers with it)
  const tools = agentToolsFigure(src)
  const automationsFigure = useAgentAutomationsFigure(agent.id)

  // the one list (lib/agent-tabs.ts) — the conversation header's ▾ draws the same
  const tabs: { id: SectionId; label: string; signal: ReactNode }[] = agentTabs({
    agentId: agent.id,
    live,
    inboxNew,
    src,
    secrets,
    tools,
    automations: automationsFigure,
    atStartTotal: leadM ? leadM.total : null,
  }).map((t) => ({ id: t.id, label: t.label, signal: tabSignal(t.signal) }))

  function go(id: SectionId): void {
    setSection(id)
    setEditing(null)
    setWritingOwn(false)
    address(FACET[id])
  }

  // a door on the cover as a tile: the tab's figure, and what it holds in a line
  const doorTile = (id: SectionId, label: string, figure: string, text: string, accent = false): ReactNode => (
    <Tile key={id} testId={`door-${id}`} name={label} accent={accent} door="Open" onOpen={() => go(id)} lead={figure}>
      <span className="line-clamp-2 text-[12.5px] leading-snug text-ink-2">{text}</span>
    </Tile>
  )

  let body: ReactNode
  if (section === 'now') {
    body = (
      <div className="flex flex-col gap-3">
        {/* just created in this tab: its proof of life first */}
        <FirstMeeting agent={agent} />
        {/* what is live first; then how its unattended work went — its
            rounds, what it decided, what waits on you. Now edits nothing:
            where each is set is its Automations tab (owner 24-11) */}
        <NowCard agent={agent} />
        {agent.id !== MASTER_ID && agent.folder ? <ControlSwitch agent={agent} part="activity" testId="control" /> : null}
        {/* the cover's doors are tiles (never lists stacked
            one under another): what each tab holds, in a figure and a line */}
        <TileGrid className="mt-2">
          <SiloAgentSections agent={agent} />
          {/* tiles say data, never filler (no placeholders) — a
              tile with nothing to say is absent, and a count that has not
              been READ is not a count: zeros wait for src.ready */}
          {openTasks.length > 0 ? (
            <Tile
              testId="door-tasks"
              name="Tasks"
              door="Open"
              onOpen={() => changePage({ kind: 'tasks', agent: [agent.id] })}
              lead={`${openTasks.length} open`}
            >
              {/* the wake truth lives in the On its own block — the tile only counts */}
              <span className="line-clamp-2 text-[12.5px] leading-snug text-ink-2">in its plans</span>
            </Tile>
          ) : null}
          {inboxNew > 0 ? doorTile('messages', 'Messages', `${inboxNew} new`, 'from other agents', true) : null}
          {src.ready ? (
            <>
              {doorTile(
                'memory',
                'Memory',
                `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`,
                `it reads${projectName ? ` — ${projectName}’s` : ''} · ${learned} learned in its conversations`,
              )}
              {doorTile(
                'files',
                'Files',
                `${deliverables + working + shared} ${deliverables + working + shared === 1 ? 'file' : 'files'}`,
                `${deliverables} of its own · ${working} working · ${shared} shared${projectName ? ` in ${projectName}` : ''}`,
              )}
              {doorTile('skills', 'Skills', `${activeSkills} ${activeSkills === 1 ? 'skill' : 'skills'}`, 'it can use')}
              {doorTile(
                'tools',
                'Tools',
                src.loads && src.loads.engines.length > 0
                  ? `${tools ?? 0} ${tools === 1 ? 'tool' : 'tools'}`
                  : `${tools ?? 0} MCP ${tools === 1 ? 'server' : 'servers'}`,
                src.loads && src.loads.engines.length > 0 ? toolsDoorWords(src.loads, Date.now()) : 'it sees at start',
              )}
              {agent.id !== MASTER_ID && secrets !== null && secrets > 0
                ? doorTile('secrets', 'Secrets', `${secrets} ${secrets === 1 ? 'secret' : 'secrets'}`, 'of the Vault reach it')
                : null}
            </>
          ) : null}
          {leadM && lead
            ? doorTile(
                'starts',
                'At start',
                `~${leadM.total.toLocaleString('en-US')} tokens`,
                `a new ${lead === 'run' ? 'automation run' : `${lead} conversation`} · measured over ${leadM.n}${(leadM.owners.agent ?? 0) > 0 ? '' : ' · none of it its own'}`,
              )
            : null}
        </TileGrid>
        {src.ready && src.failed ? (
          <p className="mt-2 text-xs text-ink-3">
            Some of this couldn’t be read — these counts may be short.{' '}
            <button type="button" className="underline hover:text-terracotta" onClick={src.reload}>
              Reload
            </button>
          </p>
        ) : null}
      </div>
    )
  } else if (section === 'automations') {
    // what it does without you, set: the ladder, its heartbeat's rhythm,
    // Proactive, its limits — and every automation you gave it
    body = (
      <div className="flex max-w-3xl flex-col gap-3">
        {agent.id !== MASTER_ID && agent.folder ? <ControlSwitch agent={agent} part="settings" testId="control" /> : null}
        <Section label="Its automations">
          <AgentAutomations agent={agent} all />
        </Section>
      </div>
    )
  } else if (section === 'messages') {
    body = <MessagesTab agent={agent} />
  } else if (section === 'memory') {
    body = (
      <div className="flex flex-col gap-3">
        {/* everything it reads, each group with its owner (the scope
            filter in the list); its own memory file is the only part that is
            the agent's — offered when it has none */}
        {!ownMemory?.exists && !writingOwn ? (
          <button type="button" onClick={() => setWritingOwn(true)} className="self-end text-[12px] text-ink-2 hover:text-terracotta">
            + Write {agent.name}’s own memory
          </button>
        ) : null}
        {writingOwn && ownMemory ? (
          <div className="rounded-lg border border-line bg-panel">
            <p className="px-4 pt-3 text-[12px] text-ink-2">
              Its own memory is read at the start of every conversation of {agent.name} — and of no other agent.
            </p>
            <MemoryDetail
              path={ownMemory.path}
              name={`${agent.name}’s own memory`}
              exists={false}
              startEditing
              onDirty={() => {}}
              onSaved={() => {
                setWritingOwn(false)
                src.reload()
              }}
            />
          </div>
        ) : null}
        <KnowsLibrary
          agent={agent}
          src={fromHere.src}
          focus={{ kind: 'memory' }}
          kinds={['memory']}
          memoryScope="agent"
          scoped="agent"
          bare
          wide
          hereId={selectedId}
          {...(fromHere.from ? { from: fromHere.from } : {})}
        />
      </div>
    )
  } else if (section === 'files') {
    body = (
      <div className="flex flex-col gap-3">
        <FilesParts
          count={src.context || src.produced ? deliverables + working + shared : null}
          folder={agent.folder ?? null}
          browseLabel="Browse its folder"
        />
        {files === 'files' ? (
          <>
            <KnowsLibrary
              agent={agent}
              src={src}
              focus={{ kind: 'files' }}
              kinds={['files']}
              filesScope="agent"
              scoped="agent"
              bare
              wide
              hereId={selectedId}
              {...(selectedFolder ? { hereFolder: selectedFolder } : {})}
              {...(selectedId ? { fromConversation: { id: selectedId } } : {})}
            />
            {/* what the owner gave single conversations — folded, never mixed into its own */}
            <GivenToConversations agent={agent} onOpenFile={setViewerPath} />
          </>
        ) : (
          <ArtifactsBlock agentId={agent.id} />
        )}
      </div>
    )
  } else if (section === 'skills' || section === 'tools') {
    body = (
      <KnowsLibrary
        key={section}
        agent={agent}
        src={fromHere.src}
        focus={{ kind: section, ...(dossierItem ? { item: dossierItem } : {}), ...(dossierFilter ? { filter: dossierFilter } : {}) }}
        kinds={[section]}
        scoped="agent"
        bare
        wide
        {...(fromHere.from ? { from: fromHere.from } : {})}
      />
    )
  } else if (section === 'secrets') {
    body = (
      <div className="flex max-w-3xl flex-col gap-3">
        <p className="text-[13px] leading-relaxed text-ink-2">
          What of the Vault reaches {agent.name} when a conversation starts — its own, its project’s and the ones you share with every agent.
        </p>
        <AgentVaultZone agent={agent} />
      </div>
    )
  } else if (section === 'starts') {
    body = <AtStart agent={agent} sw={atStart} />
  } else {
    // ONE flat page: who it is, then what it runs on — each card edits itself
    body = (
      <div className="flex max-w-3xl flex-col gap-3">
        {/* the head of its profile: why it acts, in your words */}
        {agent.id !== MASTER_ID ? <MissionHeader agent={agent} focus={focus === 'mission'} /> : null}
        <WhoCard agent={agent} editing={editing === 'who'} onEditingChange={(v) => setEditing(v ? 'who' : null)} />
        <RunsOnCard agent={agent} editing={editing === 'runs'} onEditingChange={(v) => setEditing(v ? 'runs' : null)} />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agent-sections">
      <SectionTabs value={section} onGo={go} label={`${agent.name}'s sections`} items={tabs.map((t) => (t.id === 'settings' ? { ...t, end: true } : t))} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div key={section} className="max-w-5xl px-5 pb-10 pt-4">
          {body}
        </div>
      </div>
      {viewerPath ? <FileViewer path={viewerPath} onClose={() => setViewerPath(null)} /> : null}
    </div>
  )
}
