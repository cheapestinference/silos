// store/prefs.ts — the owner's persisted layout preferences: projects
// (pins, stash, collapse), the context column, setup, uses, and the sidebar's agent/conversation ordering.
import type { StateCreator } from 'zustand'
import { api } from '../lib/api'
import { fixAt, moveBefore, releaseSlot } from '../lib/grouping'
import type { ProjectsPrefs } from '../lib/types'
import type { State } from './state'
import { TERMINAL_HEIGHT_MIN, clampFont } from './helpers'

export type PrefsSlice = Pick<
  State,
  | 'projectsPrefs'
  | 'contextOpen'
  | 'contextScope'
  | 'setupOpen'
  | 'usesPrefs'
  | 'collapsedAgents'
  | 'olderOpenAgents'
  | 'agentOrder'
  | 'conversationSlots'
  | 'detachedChains'
  | 'loadPrefs'
  | 'toggleProjectCollapse'
  | 'pinProject'
  | 'moveToStash'
  | 'removeFromStash'
  | 'pinItem'
  | 'toggleContext'
  | 'toggleSetup'
  | 'setUsesPrefs'
  | 'toggleOlderOpen'
  | 'toggleAgentCollapse'
  | 'setContextScope'
  | 'reorderAgents'
  | 'fixConversationAt'
  | 'releaseConversation'
  | 'setChainDetached'
>

export const createPrefsSlice: StateCreator<State, [], [], PrefsSlice> = (set, get) => {
  // applies a projectsPrefs patch optimistically (a shallow merge, the same
  // criterion as the server) and persists it in the background — a network
  // failure here must NEVER bring down the UI (the owner can keep dragging/
  // collapsing even if the save fails), only warn to the console. No
  // revert: the optimistic value is the best truth there is until the next loadPrefs()/boot.
  function persistProjectsPrefs(patch: ProjectsPrefs): void {
    set((s) => ({ projectsPrefs: { ...s.projectsPrefs, ...patch } }))
    api.patchPrefsProjects(patch).catch((e: unknown) => {
      console.warn('failed to save the projects preference:', e)
    })
  }

  return {
    projectsPrefs: {},
    contextOpen: true,
    contextScope: 'conversation',
    setupOpen: false,
    usesPrefs: {},
    collapsedAgents: [],
    olderOpenAgents: [],
    agentOrder: [],
    conversationSlots: {},
    detachedChains: [],

    // boot-only (called from App alongside loadOverview) — a failure here
    // leaves projectsPrefs at its default ({}), which sortGroups treats as
    // "no preferences" (order purely by activity, nothing pinned or
    // collapsed): a safe degradation, never blocks the rest of startup.
    async loadPrefs() {
      try {
        const { projects, contextOpen, contextScope, terminal, collapsedAgents, agentOrder, conversationSlots, detachedChains, setup, uses } = await api.prefs()
        set({
          projectsPrefs: projects ?? {},
          ...(contextOpen !== undefined ? { contextOpen: contextOpen } : {}),
          ...(contextScope !== undefined ? { contextScope: contextScope } : {}),
          ...(terminal?.height !== undefined ? { terminalHeight: Math.max(TERMINAL_HEIGHT_MIN, terminal.height) } : {}),
          ...(terminal?.fontSize !== undefined ? { terminalFontSize: clampFont(terminal.fontSize) } : {}),
          ...(collapsedAgents !== undefined ? { collapsedAgents: collapsedAgents } : {}),
          ...(agentOrder !== undefined ? { agentOrder: agentOrder } : {}),
          ...(conversationSlots !== undefined ? { conversationSlots: conversationSlots } : {}),
          ...(detachedChains !== undefined ? { detachedChains: detachedChains } : {}),
          ...(setup !== undefined ? { setupOpen: setup } : {}),
          ...(uses ? { usesPrefs: uses } : {}),
        })
      } catch (e) {
        console.warn('failed to load the projects preferences:', e)
      }
    },

    toggleProjectCollapse(key) {
      const current = get().projectsPrefs.collapsed ?? []
      const collapsed = current.includes(key) ? current.filter((c) => c !== key) : [...current, key]
      persistProjectsPrefs({ collapsed })
    },

    pinProject(key, newOrder) {
      const pinned = new Set(get().projectsPrefs.pinned ?? [])
      pinned.add(key)
      // remove it from the stash if it was there: pinning = "I want it out, on top"
      const inPool = (get().projectsPrefs.inPool ?? []).filter((c) => c !== key)
      persistProjectsPrefs({ order: newOrder, pinned: [...pinned], inPool })
    },

    // the projects stash: put a project in by hand — it leaves pinned (it
    // no longer asks for prominence) and enters inPool.
    moveToStash(key) {
      const inPool = new Set(get().projectsPrefs.inPool ?? [])
      inPool.add(key)
      const pinned = (get().projectsPrefs.pinned ?? []).filter((c) => c !== key)
      persistProjectsPrefs({ inPool: [...inPool], pinned })
    },

    // takes a project out of the stash (clicking the card brings it back —
    // dragging wasn't discoverable). With the MANUAL stash, removing it
    // from inPool is enough: with no automatic demotion, it just goes back
    // to the list and stays.
    removeFromStash(key) {
      const inPool = (get().projectsPrefs.inPool ?? []).filter((c) => c !== key)
      persistProjectsPrefs({ inPool })
    },

    // pin/unpin an item from ANY source. Toggles `pins` ({ source, ref }).
    // Pinned items live in the cross-cutting Pinned section. For Claude
    // Code, ref = "folder/id".
    pinItem(source, ref) {
      const current = get().projectsPrefs.pins ?? []
      const exists = current.some((p) => p.source === source && p.ref === ref)
      const pins = exists ? current.filter((p) => !(p.source === source && p.ref === ref)) : [...current, { source, ref }]
      persistProjectsPrefs({ pins })
    },

    toggleContext() {
      const next = !get().contextOpen
      set({ contextOpen: next })
      // fire-and-forget, the same criterion as persistProjectsPrefs: a save
      // failure must not bring down the UI, only warn to the console.
      api.patchPrefsContext(next).catch((e: unknown) => {
        console.warn('failed to save contextOpen:', e)
      })
    },

    toggleSetup() {
      const next = !get().setupOpen
      set({ setupOpen: next })
      // fire-and-forget, the same criterion as toggleContext.
      api.patchPrefsSetup(next).catch((e: unknown) => {
        console.warn('failed to save setupOpen:', e)
      })
    },

    setUsesPrefs(p) {
      set({ usesPrefs: p })
      // fire-and-forget, the same criterion as toggleSetup (the
      // pref is a total replacement server-side: p IS the value).
      api.patchPrefsUses(p).catch((e: unknown) => {
        console.warn('failed to save usesPrefs:', e)
      })
    },

    toggleOlderOpen(agentId) {
      const current = get().olderOpenAgents
      set({ olderOpenAgents: current.includes(agentId) ? current.filter((a) => a !== agentId) : [...current, agentId] })
    },

    toggleAgentCollapse(agentId) {
      const current = get().collapsedAgents
      const next = current.includes(agentId) ? current.filter((a) => a !== agentId) : [...current, agentId]
      set({ collapsedAgents: next })
      // fire-and-forget, the same criterion as persistProjectsPrefs/toggleContext.
      api.patchPrefsCollapsedAgents(next).catch((e: unknown) => {
        console.warn('failed to save the agent collapse state:', e)
      })
    },

    setContextScope(scope) {
      if (get().contextScope === scope) return
      set({ contextScope: scope })
      api.patchPrefsContextScope(scope).catch((e: unknown) => {
        console.warn('failed to save the context scope:', e)
      })
    },

    reorderAgents(visible, dragged, target) {
      const next = moveBefore(visible, dragged, target)
      set({ agentOrder: next })
      api.patchPrefsAgentOrder(next).catch((e: unknown) => {
        console.warn('failed to save the agent order:', e)
      })
    },

    fixConversationAt(agentId, dragged, at) {
      const sessions = get().agents.find((a) => a.id === agentId)?.sessions ?? []
      const next = fixAt(get().conversationSlots[agentId] ?? [], dragged, at, sessions)
      set({ conversationSlots: { ...get().conversationSlots, [agentId]: next } })
      api.patchPrefsConversationSlots({ [agentId]: next }).catch((e: unknown) => {
        console.warn('failed to save the fixed conversations:', e)
      })
    },

    releaseConversation(agentId, chain) {
      const sessions = get().agents.find((a) => a.id === agentId)?.sessions ?? []
      const next = releaseSlot(get().conversationSlots[agentId] ?? [], chain, sessions)
      set({ conversationSlots: { ...get().conversationSlots, [agentId]: next } })
      api.patchPrefsConversationSlots({ [agentId]: next }).catch((e: unknown) => {
        console.warn('failed to save the fixed conversations:', e)
      })
    },

    setChainDetached(key, detached) {
      const current = get().detachedChains
      const next = detached ? (current.includes(key) ? current : [...current, key]) : current.filter((k) => k !== key)
      if (next === current) return
      set({ detachedChains: next })
      api.patchPrefsDetachedChains(next).catch((e: unknown) => {
        console.warn('failed to save the detached chains:', e)
      })
    },
  }
}
