// store/navigation.ts — where the owner is: the page, its tabs, the nav
// preset/filter, mobile column, modals, the agent-page return chip, the
// Knows drawer / provider panel, and the conversation's chat|console mode.
import type { StateCreator } from 'zustand'
import type { State } from './state'
import { sessionViewOf } from './selectors'

export type NavigationSlice = Pick<
  State,
  | 'modal'
  | 'modalFolder'
  | 'modalName'
  | 'mobileView'
  | 'nav'
  | 'page'
  | 'tab'
  | 'projectTab'
  | 'filesPart'
  | 'projectItem'
  | 'projectFilter'
  | 'dossierItem'
  | 'dossierFilter'
  | 'lastAgentId'
  | 'lastProjectFolder'
  | 'agentFrom'
  | 'homeSheet'
  | 'viewingFile'
  | 'taskDraft'
  | 'knowsDrawer'
  | 'providerPanel'
  | 'chatMode'
  | 'setModal'
  | 'backToMobileList'
  | 'selectFilter'
  | 'changePage'
  | 'setHomeSheet'
  | 'setViewingFile'
  | 'setChatMode'
  | 'changeTab'
  | 'changeProjectTab'
  | 'setFilesPart'
  | 'setProjectItem'
  | 'openDossier'
  | 'setAgentFrom'
  | 'openKnows'
  | 'openProviderPanel'
  | 'closeProviderPanel'
  | 'closeKnows'
  | 'welcomeSkipped'
  | 'skipWelcome'
  | 'newMenuOpen'
  | 'setNewMenuOpen'
>

export const createNavigationSlice: StateCreator<State, [], [], NavigationSlice> = (set, get) => {
  return {
    modal: null,
    modalFolder: null,
    modalName: null,
    // the phone opens on Home, not the list (see the field's comment)
    mobileView: 'chat',
    nav: { filter: {}, groupBy: 'project', preset: 'default' },
    page: null,
    chatMode: ((): 'chat' | 'console' => {
      try {
        const v = localStorage.getItem('silos.chatMode')
        return v === 'chat' || v === 'console' ? v : 'console'
      } catch {
        return 'console'
      }
    })(),
    tab: 'threads',
    projectTab: 'now',
    filesPart: 'files',
    projectItem: null,
    dossierItem: null,
    dossierFilter: null,
    projectFilter: null,
    lastAgentId: null,
    lastProjectFolder: null,
    agentFrom: null,
    homeSheet: null,
    viewingFile: null,
    taskDraft: null,
    knowsDrawer: null,
    providerPanel: null,

    welcomeSkipped: ((): boolean => {
      try {
        return localStorage.getItem('silos.welcomeSkipped') === '1'
      } catch {
        return false
      }
    })(),
    skipWelcome() {
      try {
        localStorage.setItem('silos.welcomeSkipped', '1')
      } catch {
        /* private mode: this visit only */
      }
      set({ welcomeSkipped: true, page: null })
    },
    newMenuOpen: false,
    setNewMenuOpen(open) {
      set({ newMenuOpen: open })
    },

    setModal(m, folder, name) {
      set({ modal: m, modalFolder: folder ?? null, modalName: name ?? null })
    },

    backToMobileList() {
      set({ mobileView: 'list' })
    },

    selectFilter(axis, values) {
      set((s) => ({ nav: { ...s.nav, filter: { ...s.nav.filter, [axis]: values } } }))
    },

    changePage(p) {
      // remembered so the rail's "Projects" preset returns here.
      // projectTab goes back to Now on every navigation to a project —
      // the same criterion as selectAgent resetting `tab` to chat.
      // mobileView: 'chat' — on <md only one column is visible (App.tsx
      // gates <main> by mobileView==='chat'); navigating to a project/
      // settings must show the page, same as opening an agent. Never called
      // with kind:'agent' (that goes through selectAgent, which already
      // decides it with its own criterion — sessions or not).
      set({
        page: p,
        agentFrom: null,
        homeSheet: null,
        viewingFile: null,
        // every page — Home (p===null) included — shows <main> on <md: the
        // phone lands on Home, and
        // browser back to '/' returns to Home, never the bare list. The list
        // is reached on purpose, through Home's ‹ (backToMobileList).
        mobileView: 'chat',
        filesPart: 'files',
        projectItem: null,
        projectFilter: null,
        ...(p?.kind === 'project' ? { lastProjectFolder: p.folder, projectTab: 'now' } : {}),
      })
    },

    setHomeSheet(sheet) {
      set({ homeSheet: sheet })
    },

    setViewingFile(path) {
      set({ viewingFile: path })
    },

    setChatMode(m) {
      // persist the choice so it sticks across reloads (and lets e2e seed it)
      try {
        localStorage.setItem('silos.chatMode', m)
      } catch {
        /* private mode / SSR */
      }
      set({ chatMode: m })
    },

    changeTab(t) {
      set({ tab: t, filesPart: 'files', dossierItem: null, dossierFilter: null })
    },

    changeProjectTab(t) {
      set({ projectTab: t, filesPart: 'files', projectItem: null, projectFilter: null })
    },

    setProjectItem(item, filter = null) {
      set({ projectItem: item, projectFilter: filter })
    },

    setFilesPart(p) {
      set({ filesPart: p })
    },

    // Navigation C: an agent thing never opens OVER
    // a conversation any more — it navigates to the agent page on that
    // facet's section, carrying the conversation as `agentFrom` (the
    // return chip, `?from=` in the URL). With no conversation open (the
    // agent page itself) it only moves the page's tab, keeping the chip.
    // The composer's draft survives (drafts, keyed per conversation).
    openDossier(f, open) {
      const s = get()
      const at = { dossierItem: open?.item ?? null, dossierFilter: open?.filter ?? null }
      // the agent whose page this is: the page's, else the selected one,
      // else the open conversation's owner
      const agentId =
        (s.page?.kind === 'agent' ? s.page.id : null) ?? s.selectedAgentId ?? s.detail?.meta.agentId ?? sessionViewOf(s.agents, s.selected)?.agentId ?? null
      if (!agentId) return
      if (s.page?.kind === 'agent' && !s.selected && !s.newChatOpen) {
        set({ tab: f, filesPart: 'files', ...at })
        return
      }
      const from = s.selected ? { folder: s.selected.folder, id: s.selected.id } : null
      get().selectAgent(agentId)
      set({ tab: f, filesPart: 'files', agentFrom: from, ...at })
    },

    setAgentFrom(from) {
      set({ agentFrom: from })
    },

    openKnows(kind, opts) {
      set({ knowsDrawer: { kind, ...opts } })
    },

    openProviderPanel(reason = null) {
      set({ providerPanel: { reason }, knowsDrawer: null })
    },

    closeProviderPanel() {
      set({ providerPanel: null })
    },

    closeKnows() {
      set({ knowsDrawer: null, providerPanel: null })
    },
  }
}
