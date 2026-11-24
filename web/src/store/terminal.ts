// store/terminal.ts — the terminal panel (tabs, height, font) and the
// real console's signals (restart request, which console is shown).
import type { StateCreator } from 'zustand'
import { api } from '../lib/api'
import type { State } from './state'
import { TERMINAL_HEIGHT_DEFAULT, TERMINAL_HEIGHT_MIN, TERMINAL_FONT_DEFAULT, clampFont } from './helpers'

export type TerminalSlice = Pick<
  State,
  | 'terminals'
  | 'activeTerminalId'
  | 'terminalOpen'
  | 'terminalHeight'
  | 'terminalFontSize'
  | 'consoleRestartRequest'
  | 'consoleShown'
  | 'newTerminal'
  | 'openTerminalPanel'
  | 'closeTerminal'
  | 'selectTerminalTab'
  | 'toggleTerminalPanel'
  | 'resizeTerminal'
  | 'setTerminalFontSize'
  | 'requestConsoleRestart'
  | 'setConsoleShown'
>

export const createTerminalSlice: StateCreator<State, [], [], TerminalSlice> = (set, get) => {
  // which folder the selected agent's new terminal opens on right now —
  // the same criterion as a new master chat's `cwd`: a normal agent sends
  // its own agentId (the server resolves its folder); master needs a
  // CONCRETE cwd, taken from the open session or the project chosen in the
  // selector. null = no destination yet (nothing to create — the
  // composer/panel must disable the button in that case).
  function terminalDestination(): { agentId?: string; cwd?: string } | null {
    const { selectedAgentId, agents, detail, chosenProject } = get()
    if (!selectedAgentId) return null
    const agent = agents.find((a) => a.id === selectedAgentId)
    if (agent && agent.folder !== null) return { agentId: selectedAgentId }
    const cwd = detail?.meta.cwd ?? chosenProject ?? null
    return cwd ? { cwd } : null
  }

  return {
    consoleRestartRequest: 0,
    consoleShown: null,
    terminals: [],
    activeTerminalId: null,
    terminalOpen: false,
    terminalHeight: TERMINAL_HEIGHT_DEFAULT,
    terminalFontSize: TERMINAL_FONT_DEFAULT,

    async newTerminal() {
      const dest = terminalDestination()
      if (!dest) return
      const agentAtCreate = get().selectedAgentId
      try {
        const { id, agentId } = await api.terminals.create(dest)
        const agent = get().agents.find((a) => a.id === agentAtCreate)
        const title = agent ? agent.name : 'Terminal'
        set((s) => ({
          terminals: [...s.terminals, { id, agentId, title }],
          activeTerminalId: id,
          terminalOpen: true,
        }))
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) })
      }
    },

    async openTerminalPanel() {
      if (get().terminals.length === 0) {
        await get().newTerminal()
        return
      }
      set((s) => ({ terminalOpen: true, activeTerminalId: s.activeTerminalId ?? s.terminals[0]?.id ?? null }))
    },

    closeTerminal(id) {
      api.terminals.kill(id).catch((e: unknown) => {
        console.warn('failed to kill the terminal on the server:', e)
      })
      set((s) => {
        const terminals = s.terminals.filter((t) => t.id !== id)
        const wasActive = s.activeTerminalId === id
        return {
          terminals,
          activeTerminalId: wasActive ? (terminals[terminals.length - 1]?.id ?? null) : s.activeTerminalId,
          ...(wasActive && terminals.length === 0 ? { terminalOpen: false } : {}),
        }
      })
    },

    selectTerminalTab(id) {
      set({ activeTerminalId: id })
    },

    toggleTerminalPanel() {
      set((s) => ({ terminalOpen: !s.terminalOpen }))
    },

    resizeTerminal(px, persist) {
      const height = Math.max(TERMINAL_HEIGHT_MIN, Math.round(px))
      set({ terminalHeight: height })
      if (persist) {
        api.patchPrefsTerminal(height).catch((e: unknown) => {
          console.warn('failed to save the terminal height:', e)
        })
      }
    },

    setTerminalFontSize(px) {
      const size = clampFont(px)
      if (size === get().terminalFontSize) return
      set({ terminalFontSize: size })
      api.patchPrefsTerminalFont(size).catch((e: unknown) => {
        console.warn('failed to save the console font size:', e)
      })
    },

    requestConsoleRestart() {
      set((s) => ({ consoleRestartRequest: s.consoleRestartRequest + 1 }))
    },

    setConsoleShown(key) {
      if (get().consoleShown !== key) set({ consoleShown: key })
    },
  }
}
