// store/automations.ts — automations, their runs and approvals, and the
// rate-limit auto-resumes.
import type { StateCreator } from 'zustand'
import { api } from '../lib/api'
import type { Automation, PendingResume } from '../lib/types'
import type { State } from './state'

// A write's answer (PATCH, pause, resume) is the automation alone — its
// spend (`usage30d`) rides only on the list's read. The row keeps the figure
// it had until the next list read, never loses it to a pause.
function replaced(list: readonly Automation[], id: string, a: Automation): Automation[] {
  return list.map((x) => (x.id === id ? (a.usage30d === undefined && x.usage30d !== undefined ? { ...a, usage30d: x.usage30d } : a) : x))
}

export type AutomationsSlice = Pick<
  State,
  | 'automations'
  | 'automationsLoaded'
  | 'automationsPending'
  | 'automationRuns'
  | 'pendingResumes'
  | 'loadAutomations'
  | 'loadPendingResumes'
  | 'cancelPendingResume'
  | 'loadAutomationRuns'
  | 'createAutomation'
  | 'updateAutomation'
  | 'deleteAutomation'
  | 'runNowAutomation'
  | 'pauseAutomation'
  | 'resumeAutomation'
  | 'approveRun'
  | 'skipRun'
  | 'openAutomation'
  | 'showAutomation'
>

export const createAutomationsSlice: StateCreator<State, [], [], AutomationsSlice> = (set, get) => {
  return {
    automations: [],
    automationsLoaded: false,
    automationsPending: [],
    automationRuns: [],
    pendingResumes: {},

    // boot-only (alongside loadOverview) and after creating/editing/
    // deleting an automation — a failure here must not bring down the UI
    // (the same criterion as loadPrefs), just leave the lists as they were.
    async loadAutomations() {
      try {
        const [automations, automationsPending] = await Promise.all([api.automations.list(), api.automations.pending()])
        // defensive: in tests that auto-mock the whole api module without
        // explicitly stubbing automations.list()/pending() (App mounts in
        // almost every boot test), the mock returns `undefined` instead of
        // an array — the same criterion as AccountFooter (Sidebar.tsx) with
        // Promise.resolve(...). Never leaves `automations`/`automationsPending`
        // in a non-array state.
        set({ automations: automations ?? [], automationsPending: automationsPending ?? [], automationsLoaded: true })
      } catch (e) {
        console.warn('failed to load automations:', e)
      }
    },

    // Auto-resume: boot-only (App). Defensive just like loadAutomations — a
    // mock that returns undefined never leaves the state malformed. Key
    // "folder/sessionId".
    async loadPendingResumes() {
      try {
        const list = await api.pendingResumes.list()
        const map: Record<string, PendingResume> = {}
        for (const p of list ?? []) map[`${p.folder}/${p.sessionId}`] = p
        set({ pendingResumes: map })
      } catch (e) {
        console.warn('failed to load pending resumes:', e)
      }
    },

    async cancelPendingResume(folder, id) {
      const key = `${folder}/${id}`
      // optimistic: it's out already (the WS pending-resume-removed event
      // confirms it). If the call fails, it rehydrates on the next reload —
      // never leave the banner promising a resume that was just cancelled.
      set((s) => {
        const rest = { ...s.pendingResumes }
        delete rest[key]
        return { pendingResumes: rest }
      })
      try {
        await api.pendingResumes.cancel(folder, id)
      } catch (e) {
        console.warn('failed to cancel the pending resume:', e)
      }
    },

    async loadAutomationRuns(id) {
      try {
        const runs = await api.automations.runs(id)
        set({ automationRuns: runs })
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) })
      }
    },

    async createAutomation(input) {
      const a = await api.automations.create(input)
      set((s) => ({ automations: [...s.automations, a] }))
      return a
    },

    async updateAutomation(id, patch) {
      const a = await api.automations.update(id, patch)
      set((s) => ({ automations: replaced(s.automations, id, a) }))
      return a
    },

    async deleteAutomation(id) {
      await api.automations.delete(id)
      set((s) => ({
        automations: s.automations.filter((a) => a.id !== id),
        automationsPending: s.automationsPending.filter((r) => r.automationId !== id),
        // Deleting from the automation's own detail page (its Delete button)
        // leaves nothing to show — navigate back to the automations view.
        ...(s.page?.kind === 'automation' && s.page.id === id ? { page: { kind: 'automations' } } : {}),
      }))
    },

    async runNowAutomation(id) {
      // the server now answers an honest 409 when a run is already alive —
      // a swallowed rejection here turned that honesty back into a lost
      // click (every caller fires this with `void`)
      try {
        await api.automations.runNow(id)
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) })
        return
      }
      void get().loadAutomationRuns(id)
    },

    async pauseAutomation(id) {
      const a = await api.automations.pause(id)
      set((s) => ({ automations: replaced(s.automations, id, a) }))
    },

    async resumeAutomation(id) {
      const a = await api.automations.resume(id)
      set((s) => ({ automations: replaced(s.automations, id, a) }))
    },

    async approveRun(runId) {
      await api.automations.approve(runId)
      set((s) => ({ automationsPending: s.automationsPending.filter((r) => r.id !== runId) }))
      void get().loadAutomations()
    },

    async skipRun(runId) {
      await api.automations.skip(runId)
      set((s) => ({ automationsPending: s.automationsPending.filter((r) => r.id !== runId) }))
      void get().loadAutomations()
    },

    openAutomation(id) {
      set({ page: { kind: 'automation', id }, mobileView: 'chat' })
      void get().loadAutomationRuns(id)
    },

    showAutomation(id) {
      // an automation has ONE home — its own page: a click
      // anywhere (the column, the agent page's
      // list) lands there, never on a facet over the transcript.
      if (!get().automations.some((x) => x.id === id)) return
      get().openAutomation(id)
    },
  }
}
