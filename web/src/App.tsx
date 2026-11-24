import { FileViewerHost } from './components/FileViewerHost'
import { useEffect } from 'react'
import { useStore } from './store'
import { WsClient } from './lib/ws'
import { connectRouter, restoreFromUrl } from './lib/router'
import { Sidebar } from './components/Sidebar'
import { AgentPage } from './components/AgentPage'
import { ProjectPage } from './components/ProjectPage'
import { SettingsPage } from './components/SettingsPage'
import { AutomationsPage } from './components/AutomationsPage'
import { AutomationsListPage } from './components/AutomationsListPage'
import { UsagePage } from './components/UsagePage'
import { BackgroundPage } from './components/BackgroundPage'
import { TasksView } from './components/tasks/TasksView'
import { TaskPage } from './components/tasks/TaskPage'
import { MapPage } from './components/MapPage'
import { FilesPage } from './components/FilesPage'
import { SystemPage } from './components/system/SystemPage'
import { VaultPage } from './components/VaultPage'
import { SiloPage } from './components/silo/SiloPage'
import { Welcome } from './components/Welcome'
import { instanceEmpty } from './lib/first-run'
import { HomePage } from './components/home/HomePage'
import { AgentModal } from './components/AgentModal'
import { NewProjectModal } from './components/NewProjectModal'
import { CreateSkillDialog } from './components/CreateSkillDialog'
import { ShortcutsOverlay } from './components/ShortcutsOverlay'
import { CommandPalette } from './components/CommandPalette'
import { SessionModal } from './components/SessionModal'
import { ErrorStrip } from './components/ErrorStrip'
import { ReconnectBand } from './components/ReconnectBand'
import { UpdateBand } from './components/UpdateBand'

// the main column's router — the active page decides what mounts there.
// AgentPage still resolves 'agent' AND null on its own (a cold start / the
// master's chat with no session) — see the `if (!agent)` inside
// AgentPage.tsx, not duplicated here.
function MainPane() {
  const page = useStore((s) => s.page)
  const agents = useStore((s) => s.agents)
  // first run: no real agents (only the master catch-all) and no sessions
  // anywhere → the cold-start pane becomes the welcome, until the first
  // agent exists. Never shows once the instance has any life in it.
  const welcomeSkipped = useStore((s) => s.welcomeSkipped)
  if (page === null && instanceEmpty(agents) && !welcomeSkipped) return <Welcome />
  // '/' is Home (docs/product.md: the pulse + the inbox). The master's
  // cold-start chat lives at /agent/master/new, not here.
  if (page === null && agents.length > 0) return <HomePage />
  if (page?.kind === 'project') return <ProjectPage />
  if (page?.kind === 'settings') return <SettingsPage />
  if (page?.kind === 'automation') return <AutomationsPage />
  if (page?.kind === 'automations') return <AutomationsListPage />
  if (page?.kind === 'background') return <BackgroundPage />
  if (page?.kind === 'usage') return <UsagePage />
  if (page?.kind === 'tasks') return <TasksView />
  if (page?.kind === 'task') return <TaskPage key={`${page.plan}/${page.task}`} planKey={page.plan} taskId={page.task} from={page.from} />
  if (page?.kind === 'map') return <MapPage />
  if (page?.kind === 'system') return <SystemPage />
  if (page?.kind === 'files') return <FilesPage />
  if (page?.kind === 'vault') return <VaultPage sign={page.sign} entry={page.entry} />
  if (page?.kind === 'silo') return <SiloPage />
  return <AgentPage />
}

export function App() {
  const error = useStore((s) => s.error)
  const mobileView = useStore((s) => s.mobileView)
  const unreadCount = useStore((s) => s.unreadAgentIds.size)

  // the tab badge: a '● ' prefix while there are finished turns the user
  // hasn't seen yet (see unreadAgentIds in store.ts). No Notification API
  // (zero permission prompts): only the tab title changes.
  useEffect(() => {
    document.title = (unreadCount > 0 ? '● ' : '') + 'Silos'
  }, [unreadCount])

  useEffect(() => {
    // connects the store⇄URL bridge right away (the subscription pushes
    // nothing until the user navigates) and, once the overview finishes
    // loading, restores the deep-link's state — it needs the agents/sessions
    // already in the store to resolve an id/session.
    const disconnectRouter = connectRouter()
    // the deep-link is restored once BOTH the overview and the automations
    // have loaded: overview brings agents/sessions (to resolve /agent/<id>/…)
    // and loadAutomations the list (to validate /automation/<id>). Both
    // catch their own failures except loadOverview, whose error must reach
    // the store; Promise.all doesn't reject over the others.
    void Promise.all([useStore.getState().loadOverview(), useStore.getState().loadAutomations()])
      .then(() => restoreFromUrl())
      .catch((e: unknown) => useStore.setState({ error: e instanceof Error ? e.message : String(e) }))
    // the projects menu's preferences — in parallel, never blocks boot
    // (loadPrefs already catches its own failures, see store.ts).
    void useStore.getState().loadPrefs()
    // the cockpit's honest model catalog — in parallel, same criterion.
    void useStore.getState().loadCatalog()
    // the engines the server registered — same criterion (the seed paints first).
    void useStore.getState().loadHarnesses()
    // auto-resume: pending resumes + providers (for the limit banner) — in
    // parallel, each catching its own failures.
    void useStore.getState().loadPendingResumes()
    void useStore.getState().loadProviders()
    // providers describe a login that changes OUTSIDE the app (`claude auth
    // login` re-points the machine's account): a tab that lives for days kept
    // naming the OLD subscription in every runs-on line. Re-read whenever the
    // owner comes back to the tab — one tiny GET, idempotent.
    const refreshProvidersOnReturn = (): void => {
      if (document.visibilityState === 'visible') void useStore.getState().loadProviders()
    }
    document.addEventListener('visibilitychange', refreshProvidersOnReturn)
    // the Silo Standard's registry — ⌘K and the rail read the descriptors;
    // best-effort and empty while nothing is installed (surface invisible).
    void useStore.getState().loadSilos()
    const ws = new WsClient((ev) => useStore.getState().applyWs(ev), {
      // resync: only when TRANSITIONING from reconnecting to connected
      // (not on the first successful connect()) — resync reloads the
      // overview + the open session and arms the active turn's watchdog,
      // which assumes there was a real drop.
      onStatus: (status) => {
        const previous = useStore.getState().connection
        useStore.setState({ connection: status })
        if (previous === 'reconnecting' && status === 'connected') void useStore.getState().resync()
      },
    })
    ws.connect()
    // the live clock: nowTick refreshes every 30s here (besides on every
    // 'session' event, see store.ts) so a "live" badge turns off on its own
    // once it crosses LIVE_MS even if that particular session never sends
    // another event (the "zombie live" bug).
    const liveClock = setInterval(() => useStore.setState({ nowTick: Date.now() }), 30_000)
    // a tap on a Silos notification (public/sw.js) while Silos is open: the
    // worker controls no page, so it says «open Home» and this page goes there
    const sw = 'serviceWorker' in navigator ? navigator.serviceWorker : null
    const onWorkerMessage = (e: MessageEvent): void => {
      if ((e.data as { silos?: unknown } | null)?.silos === 'open-home') useStore.getState().changePage(null)
    }
    sw?.addEventListener('message', onWorkerMessage)
    sw?.startMessages()
    return () => {
      ws.close()
      clearInterval(liveClock)
      sw?.removeEventListener('message', onWorkerMessage)
      disconnectRouter()
      document.removeEventListener('visibilitychange', refreshProvidersOnReturn)
    }
  }, [])

  return (
    <div className="app-shell flex h-screen w-screen overflow-hidden bg-canvas text-ink">
      {/* the reconnection band, part of the system notices family — amber,
          mono, a subtle pulse, with "Reconnected" fading out on return (see
          ReconnectBand.tsx). */}
      <ReconnectBand />
      {/* its calm sibling: "this tab runs an older build — reload?" (see
          UpdateBand.tsx). Below the reconnect band in z so a drop wins. */}
      <UpdateBand />
      <Sidebar />
      {/* below md, only one column is visible at a time, governed by
          mobileView ('list' | 'chat' — the unified sidebar absorbed the
          threads column); md:/lg: force flex regardless of the flag — it's
          inert from md up (CSS-gated by breakpoint). With no bottom bar on
          the rail, <main> no longer needs the pb-14 gap.
          min-w-0: without it, a flex-1 <main> inside the root row keeps its
          default min-width:auto and grows to fit its widest inner content
          (e.g. a long conversation title in ConversationHeader, AgentPage.tsx)
          instead of letting THAT content truncate — the app-shell's
          overflow-hidden only clips visually, it doesn't prevent the real
          overflow (a real bug, visible on mobile with long titles). */}
      <main className={`${mobileView === 'chat' ? 'flex' : 'hidden'} md:flex min-w-0 flex-1 flex-col`}>
        <MainPane />
      </main>
      <AgentModal />
      <NewProjectModal />
      <CreateSkillDialog />
      <ShortcutsOverlay />
      <CommandPalette />
      <SessionModal />
      <FileViewerHost />
      {error !== null ? <ErrorStrip /> : null}
    </div>
  )
}
