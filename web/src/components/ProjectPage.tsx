// ProjectPage.tsx — a project's (folder's) page = the Home scoped to the
// folder (docs/product.md, the surface map) plus its machinery,
// folded. Reached from a Sidebar group header's clickable name, the
// rail's "Projects" preset, an agent's header, or "· project (N without
// agent)" under a group with orphaned sessions.
// Scope: the project is the house of what the FOLDER owns.
// Its tabs speak the agent page's nouns, in its order — Now ·
// Memory · Files · Skills · Tools · Map. Now is the Home scoped to the
// folder (pulse, inbox, agents, orphans); the others are the folder's
// shared memory, its shared files and artifacts, the skills and the MCP
// servers and plugins every conversation started in it loads (each
// switched here and only here, saying which agents it reaches) and its
// map. `projectTab` names the tab — /project/<folder>/<tab>.
import { useMemo, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { BagIcon, PinToTopIcon, ProjectIcon } from '../lib/icons'
import { useStore } from '../store'
import { MASTER_ID } from '../lib/constants'
import { basename } from '../lib/routes'
import { isLive, sessionSignal } from '../lib/live'
import { countsInFolder, inFolder, managesFolder, memberOf, resolveProjectFolder, startsIn } from '../lib/home'
import { conversationsAndRuns, countsOf } from '../lib/counts'
import { relTime } from '../lib/rel-time'
import { groupKey } from '../lib/grouping'
import { Pulse } from './Pulse'
import { Fact, PageHeader, Seal } from './PageHeader'
import { SectionTabs } from './HeaderTabs'
import { BackButton } from './Chat'
import { MapPage } from './MapPage'
import { ArtifactsBlock, FilesParts } from './ArtifactsBlock'
import { HomePage } from './home/HomePage'
import { KnowsLibrary } from './knows/KnowsLibrary'
import { folderSubject, useKnowsSources, type FolderSubject } from './knows/KnowsAnatomy'
import type { ProjectTab } from '../store'
import type { AgentView, SessionView } from '../lib/types'

// master's sessions whose cwd falls inside this folder — the project has
// its own agents, but these sessions didn't classify into any of them
// (derived here client-side; the overview already carries cwd per session,
// no need for a new server query). The SAME "inside" rule as the Home
// scope (lib/home.ts inFolder): the folder or anything hanging off it.
function orphanSessions(master: AgentView | undefined, folder: string): SessionView[] {
  if (!master) return []
  return master.sessions.filter((s) => inFolder(folder, s.cwd))
}

function ProjectHeader({ folder, projectAgents, nowTick }: { folder: string; projectAgents: AgentView[]; nowTick: number }) {
  const agents = useStore((s) => s.agents)
  const master = agents.find((a) => a.id === MASTER_ID)
  const orphans = orphanSessions(master, folder)
  const allSessions = [...projectAgents.flatMap((a) => a.sessions), ...orphans]
  // uncapped totals (lib/counts.ts): the project's agents whole, plus
  // Anywhere's share inside the folder — never the capped lists' length
  const totals = [...projectAgents.map(countsOf), ...(master ? [countsInFolder(master, folder)] : [])].reduce(
    (t, c) => ({ conversations: t.conversations + c.conversations, runs: t.runs + c.runs }),
    { conversations: 0, runs: 0 },
  )
  const lastActivity = allSessions.reduce((max, s) => Math.max(max, s.mtime), 0)
  const live = allSessions.some((s) => isLive(s.mtime, nowTick) || sessionSignal(s, nowTick, false) === 'working')

  return (
    <PageHeader
      testId="project-header"
      joined
      // the type word as its place, so the project «silos» never reads as the
      // product — the same job «▢ Project · x» did on the title
      crumbs={[{ label: 'Project' }]}
      seal={
        <Seal>
          <ProjectIcon size={18} className="text-terracotta" />
        </Seal>
      }
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{basename(folder)}</span>
          {live ? <Pulse /> : null}
        </span>
      }
      facts={
        <>
          <Fact truncate>
            <span className="min-w-0 truncate font-mono text-[12px]" title={folder}>
              {folder}
            </span>
          </Fact>
          <Fact>{projectAgents.length} agents</Fact>
          <Fact>{conversationsAndRuns(totals)}</Fact>
          {lastActivity > 0 ? <Fact>{relTime(lastActivity, nowTick)}</Fact> : null}
        </>
      }
    />
  )
}

// "Conversations without an agent" — orphaned sessions with two ways
// forward: "Just this project" (opens via master, the only real owner that
// can resume them — master is who has them in its own session list) or
// "Continue with {agent}" for each of the project's agents (switches to
// THAT agent, ready for a new message in this project — it does not
// migrate the orphaned transcript: that would need reassigning the
// session's native owner, out of scope here).
function OrphansBlock({ folder, projectAgents, orphans }: { folder: string; projectAgents: AgentView[]; orphans: SessionView[] }) {
  const selectAgent = useStore((s) => s.selectAgent)
  const openSession = useStore((s) => s.openSession)
  const setModal = useStore((s) => s.setModal)

  if (orphans.length === 0) return null

  function justThisProject(s: SessionView): void {
    selectAgent(MASTER_ID)
    void openSession(s.folder, s.id)
  }

  function continueWith(agentId: string): void {
    selectAgent(agentId)
  }

  return (
    <section aria-label="Conversations without an agent">
      <div className="flex items-center gap-3">
        <h2 className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-3">Conversations without an agent</h2>
        <span aria-hidden="true" className="h-px flex-1 bg-line" />
        <span className="font-mono text-[11px] text-ink-2">{orphans.length}</span>
      </div>
      <ul className="mt-1 divide-y divide-line/60">
        {orphans.map((s) => (
          <li key={`${s.folder}/${s.id}`} className="py-2">
            <p className="truncate text-sm text-ink">{s.title}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => justThisProject(s)}
                className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-2 hover:border-ink-2 hover:text-ink"
              >
                Just this project
              </button>
              {projectAgents.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => continueWith(a.id)}
                  className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-2 hover:border-ink-2 hover:text-ink"
                >
                  Continue with {a.name}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => setModal('create', folder)}
        className="mt-2 w-fit rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink-2 hover:border-terracotta hover:text-terracotta"
      >
        + Create an agent for these
      </button>
    </section>
  )
}

// the project's own preferences — pin to the top of the sidebar, put in
// the bag — as two mono actions on the machinery line. Muted folders are
// listed in Settings › Maintenance (~/.silos/muted.json).
function PinBag({ folder }: { folder: string }) {
  const pinProject = useStore((s) => s.pinProject)
  const moveToStash = useStore((s) => s.moveToStash)
  const projectsPrefs = useStore((s) => s.projectsPrefs)
  const projectKey = groupKey(folder)
  const pinned = (projectsPrefs.pinned ?? []).includes(projectKey)
  const inPool = (projectsPrefs.inPool ?? []).includes(projectKey)

  function pinToTop(): void {
    const rest = (projectsPrefs.order ?? []).filter((c) => c !== projectKey)
    pinProject(projectKey, [projectKey, ...rest])
  }

  return (
    <>
      <button
        type="button"
        onClick={pinToTop}
        disabled={pinned}
        className="flex items-center gap-1 hover:text-terracotta disabled:opacity-60 disabled:hover:text-ink-2"
      >
        <PinToTopIcon size={11} aria-hidden="true" />
        {pinned ? 'Pinned to top' : 'Pin to top'}
      </button>
      <button
        type="button"
        onClick={() => moveToStash(projectKey)}
        disabled={inPool}
        className="flex items-center gap-1 hover:text-terracotta disabled:opacity-60 disabled:hover:text-ink-2"
      >
        <BagIcon size={11} aria-hidden="true" />
        {inPool ? 'In the bag' : 'Put in bag'}
      </button>
    </>
  )
}

// What the FOLDER owns, managed here and only here (each
// page shows its own scope): the memory every agent working in it reads,
// the files it shares, the skills and the MCP servers and plugins every
// conversation started in it loads. An agent's page shows these as
// inherited and links here. The agent page's nouns, in its order.
const PROJECT_TABS: { id: ProjectTab; label: string }[] = [
  { id: 'now', label: 'Now' },
  { id: 'memory', label: 'Memory' },
  { id: 'files', label: 'Files' },
  { id: 'skills', label: 'Skills' },
  { id: 'tools', label: 'Tools' },
  { id: 'map', label: 'Map' },
]

// the agents a change here reaches — said beside every switch. A folder's
// skills, MCP servers and memory reach the agents that START in it (their
// primary folder is it), never a member that only declares it or works in
// a subfolder — saying otherwise would be the lie the scope rule removes.
// The tab sentence of Tools and Skills (spec scope-ui-review §3.7), one
// template: the page's place first, the other places ▾ offers, the timing.
function SwitchSentence({ agents }: { agents: AgentView[] }) {
  return (
    <p className="text-[12px] text-ink-2" data-testid="switch-reach">
      A switch here is for this project{agents.length > 0 ? ` — ${agents.map((a) => a.name).join(' · ')}` : ' — no agent starts here yet'}.{' '}
      <ChevronDown size={11} aria-label="▾" className="inline-block align-[-1px]" /> on a row: this machine, or one agent. New conversations only.
    </p>
  )
}

function Reaches({ agents, what, more }: { agents: AgentView[]; what: string; more?: ReactNode }) {
  if (agents.length === 0) {
    return (
      <p className="text-[12px] text-ink-2">
        {what} reaches conversations started in this folder — no agent starts here yet. Only new conversations pick up a change.
      </p>
    )
  }
  return (
    <p className="text-[12px] text-ink-2">
      {what} reaches every agent that starts in this folder — {agents.map((a) => a.name).join(' · ')}. Only new conversations pick up a change.
      {more ? <> {more}</> : null}
    </p>
  )
}

// A project whose folder no agent works in ITSELF (only agents nested
// inside it, or none at all): the folder is not Silos' to switch by path
// (the server's managed-folder rule) — said plainly, with the doors that do
// land: the projects its agents start in, or creating an agent here. Never
// a borrowed agent's folder shown as this one's.
function NotTheHouse({ folder, projectAgents, what }: { folder: string; projectAgents: AgentView[]; what: string }) {
  const changePage = useStore((s) => s.changePage)
  const setModal = useStore((s) => s.setModal)
  const homes = [...new Set(projectAgents.map((a) => a.folder).filter((f): f is string => typeof f === 'string' && f !== folder))]
  return (
    <div className="flex max-w-xl flex-col gap-2 text-[13px] text-ink-2">
      <p className="text-ink">No agent works in this folder itself.</p>
      <p>
        {what} belong to the folder a conversation starts in.
        {homes.length > 0
          ? ' The agents here start in these folders — each is switched on its own page:'
          : ' Nothing starts here yet, so there is nothing of this folder to switch.'}
      </p>
      {homes.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {homes.map((f) => (
            <li key={f}>
              <button
                type="button"
                onClick={() => changePage({ kind: 'project', folder: f })}
                className="font-mono text-[12px] text-ink-2 hover:text-terracotta"
              >
                {f} ›
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        onClick={() => setModal('create', folder)}
        className="mt-1 w-fit rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink-2 hover:border-terracotta hover:text-terracotta"
      >
        + Create an agent in this folder
      </button>
    </div>
  )
}

function ProjectWorkspace({ folder, projectAgents, section }: { folder: string; projectAgents: AgentView[]; section: Exclude<ProjectTab, 'now'> }) {
  const knowsVersion = useStore((s) => s.knowsVersion)
  const agents = useStore((s) => s.agents)
  const filesPart = useStore((s) => s.filesPart)
  const item = useStore((s) => s.projectItem)
  const filter = useStore((s) => s.projectFilter)
  // the folder's sources are asked about the FOLDER itself (its own doors,
  // /api/folders/:folder/… and /api/memory?folder=) —
  // never read through a member agent, whose primary folder may be
  // elsewhere (third review round: a folders[]-only member's skills showed
  // and switched here)
  const managed = managesFolder(agents, folder)
  const subject = useMemo(() => folderSubject(folder), [folder])
  const starters = projectAgents.filter((a) => startsIn(a, folder))
  let body: ReactNode = null
  if (section === 'memory') {
    body = managed ? (
      <div className="flex flex-col gap-3">
        <Reaches agents={starters} what="This memory" />
        <ProjectLibrary subject={subject} version={knowsVersion.memory} kind="memory" />
      </div>
    ) : (
      <NotTheHouse folder={folder} projectAgents={projectAgents} what="Memory notes and CLAUDE.md" />
    )
  } else if (section === 'skills') {
    body = managed ? (
      <div className="flex flex-col gap-3">
        <SwitchSentence agents={starters} />
        <ProjectLibrary subject={subject} version={knowsVersion.skills} kind="skills" item={item} />
      </div>
    ) : (
      <NotTheHouse folder={folder} projectAgents={projectAgents} what="Skills" />
    )
  } else if (section === 'tools') {
    body = managed ? (
      <div className="flex flex-col gap-3">
        <SwitchSentence agents={starters} />
        <ProjectLibrary subject={subject} version={knowsVersion.skills} kind="tools" item={item} filter={filter === 'sign-in' ? 'sign-in' : null} />
      </div>
    ) : (
      <NotTheHouse folder={folder} projectAgents={projectAgents} what="MCP servers and plugins" />
    )
  } else if (section === 'files') {
    body = (
      <div className="flex flex-col gap-3">
        {/* the agent page's two parts, each an address; everything else in
            the folder is the Files page's explorer, rooted here */}
        <FilesParts folder={folder} />
        {filesPart === 'artifacts' ? (
          <ArtifactsBlock folder={folder} />
        ) : managed ? (
          <ProjectLibrary subject={subject} version={knowsVersion.context} kind="context" />
        ) : (
          <NotTheHouse folder={folder} projectAgents={projectAgents} what="Shared files" />
        )}
      </div>
    )
  } else {
    body = (
      <div className="h-[36rem] overflow-auto rounded-lg border border-line">
        <MapPage embedded projectFolder={folder} />
      </div>
    )
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="max-w-5xl px-5 pb-12 pt-4">{body}</div>
    </div>
  )
}

function ProjectLibrary({
  subject,
  version,
  kind,
  item = null,
  filter = null,
}: {
  subject: FolderSubject
  version: number
  kind: 'memory' | 'skills' | 'tools' | 'context'
  item?: string | null
  filter?: 'sign-in' | null
}) {
  const src = useKnowsSources(subject, version)
  const notes = (src.memory?.autoMemory ?? []).filter((n) => n.type !== 'index')
  const known = notes.filter((n) => n.author).length
  return (
    <>
      {/* who learned each note is known only for conversations Silos saw
        start (its birth records) and that still exist — said, so
        an author facet is never read as the whole picture */}
      {kind === 'memory' && notes.length > 0 ? (
        <p className="font-mono text-[11px] text-ink-3">
          The folder’s own notes — since memory per agent, only sessions started outside Silos read or write them; each agent’s conversations keep their own
          memory, on the agent’s page.
        </p>
      ) : null}
      {kind === 'memory' && notes.length > 0 ? (
        <p className="font-mono text-[11px] text-ink-3">
          Silos knows who learned {known} of {notes.length} notes — the rest came from conversations it didn’t see start, or that are gone.
        </p>
      ) : null}
      <KnowsLibrary
        agent={subject}
        src={src}
        focus={{ kind, ...(item ? { item } : {}), ...(filter ? { filter } : {}) }}
        kinds={[kind]}
        bare
        wide
        memoryScope="project"
        filesScope="project"
        scoped="project"
      />
    </>
  )
}

// the cover's tail: the folder's pins and "+ agent" (they lived on the old
// machinery line)
function ProjectActions({ folder }: { folder: string }) {
  const setModal = useStore((s) => s.setModal)
  return (
    <div className="flex items-center justify-end gap-4 font-mono text-[11px] text-ink-2">
      <PinBag folder={folder} />
      <button type="button" onClick={() => setModal('create', folder)} className="hover:text-terracotta">
        + agent
      </button>
    </div>
  )
}

// A /project link to a folder Silos knows nothing about (no agent, no
// conversation there — a mistyped path, or a munged -home-u-x that
// maps to no known folder) says so in the Home's own voice — serif line,
// mono meta — instead of inventing a quiet, empty project.
function UnknownProject({ folder }: { folder: string }) {
  const changePage = useStore((s) => s.changePage)
  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="flex max-w-[52rem] flex-col gap-2 px-5 pb-12 pt-5 sm:px-8">
        <div className="font-mono text-[11px] text-ink-3">
          <BackButton />
        </div>
        <h1 className="break-all font-display text-[21px] leading-snug text-ink">{folder}</h1>
        <p className="font-mono text-[11px] text-ink-3">Silos knows no project here — no agent, no conversation in this folder.</p>
        <button type="button" onClick={() => changePage(null)} className="mt-2 w-fit font-mono text-[11px] text-ink-2 hover:text-terracotta">
          Back to Home ›
        </button>
      </div>
    </div>
  )
}

export function ProjectPage() {
  const page = useStore((s) => s.page)
  const agents = useStore((s) => s.agents)
  const nowTick = useStore((s) => s.nowTick)
  const projectTab = useStore((s) => s.projectTab)
  const changeProjectTab = useStore((s) => s.changeProjectTab)

  if (page?.kind !== 'project') return null
  // the munged session-folder form (-home-u-x) is an alias of the one
  // known folder it names — the router canonicalizes the URL on entry;
  // this covers an in-app link that carries the alias.
  // the overview always carries Anywhere (master), so an empty list means
  // it hasn't loaded yet — never call a folder unknown before that.
  const resolved = agents.length > 0 ? resolveProjectFolder(agents, page.folder) : page.folder
  if (resolved === null) return <UnknownProject folder={page.folder} />
  const folder = resolved
  // the project's agents: the folder or anything hanging off it — the same
  // rule the scoped Home applies (a monorepo's subfolders belong).
  const projectAgents = agents.filter((a) => a.id !== MASTER_ID && memberOf(a, folder))
  const master = agents.find((a) => a.id === MASTER_ID)
  const orphans = orphanSessions(master, folder)

  const section = projectTab
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <ProjectHeader folder={folder} projectAgents={projectAgents} nowTick={nowTick} />
      <SectionTabs value={section} onGo={changeProjectTab} items={PROJECT_TABS} label="Project sections" />
      {section === 'now' ? (
        <HomePage
          scope={{ folder }}
          after={
            <>
              <OrphansBlock folder={folder} projectAgents={projectAgents} orphans={orphans} />
              <ProjectActions folder={folder} />
            </>
          }
        />
      ) : (
        <ProjectWorkspace key={section} folder={folder} projectAgents={projectAgents} section={section} />
      )}
    </div>
  )
}
