// store.ts — the whole app's state (zustand). An interface consumed literally
// by many components — don't change shapes here without updating them too.
//
// Built from domain slices (zustand's slices pattern) under ./store/:
// sessions · chat · live · navigation · prefs · terminal · automations ·
// catalog. Each slice implements a Pick of State (./store/state.ts); the
// chat turn engine (./store/engine.ts) is created once per store and handed
// to the slices that need its machinery. This file stays the only entry
// point: import useStore, the types and the helpers from here.
import { create } from 'zustand'
import type { State } from './store/state'
import { guardedSet, type SetFn } from './store/helpers'
import { createChatEngine } from './store/engine'
import { createSessionsSlice } from './store/sessions'
import { createChatSlice } from './store/chat'
import { createLiveSlice } from './store/live'
import { createNavigationSlice } from './store/navigation'
import { createPrefsSlice } from './store/prefs'
import { createTerminalSlice } from './store/terminal'
import { createAutomationsSlice } from './store/automations'
import { createCatalogSlice } from './store/catalog'

export type { State } from './store/state'
export type {
  TerminalTab,
  ActiveStep,
  ChatTurnState,
  TurnReceipt,
  NavFilter,
  NavState,
  SettingsTab,
  Page,
  Tab,
  ProjectTab,
  FilesPart,
  QueueItem,
} from './store/types'
export { sessionViewOf, draftKeyOf, turnOnScreen } from './store/selectors'
export { TERMINAL_HEIGHT_DEFAULT, TERMINAL_HEIGHT_MIN, TERMINAL_FONT_DEFAULT, TERMINAL_FONT_MIN, TERMINAL_FONT_MAX } from './store/helpers'

export const useStore = create<State>()((rawSet, get, store) => {
  const set = guardedSet(rawSet as SetFn, get) as typeof rawSet
  const engine = createChatEngine(set, get)
  return {
    ...createSessionsSlice(engine)(set, get, store),
    ...createChatSlice(engine)(set, get, store),
    ...createLiveSlice(engine)(set, get, store),
    ...createNavigationSlice(set, get, store),
    ...createPrefsSlice(set, get, store),
    ...createTerminalSlice(set, get, store),
    ...createAutomationsSlice(set, get, store),
    ...createCatalogSlice(set, get, store),
  }
})

// an evidence hook: the E2E screenshot harness needs to mount states it
// can't otherwise trigger without the real SDK (a live turn, a receipt).
// Gated to dev/localhost — for the usual local setup this changes nothing,
// but if a remote deployment is ever used, it must NOT hand a same-origin
// remote a way to FABRICATE live states (turns, receipts) — exactly the
// class of signal the proof-of-life principle protects.
declare global {
  interface Window {
    __silosStore?: typeof useStore
  }
}
if (typeof window !== 'undefined' && (import.meta.env.DEV || window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost')) {
  window.__silosStore = useStore
}
