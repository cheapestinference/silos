// store/chat.ts — the turn and the composer: the active turn, the queue,
// receipts, errors, drafts, memory mode and the conversation's cockpit
// prefs (convPrefs / pending / one-shot overrides).
import type { StateCreator } from 'zustand'
import { api } from '../lib/api'
import { NO_TRIM } from '../lib/active-trim'
import { MASTER_ID } from '../lib/constants'
import type { ConvPrefs } from '../lib/types'
import { applyPatch } from '../lib/cockpit'
import type { State } from './state'
import { sessionBelongsToAgent } from './helpers'
import type { ChatEngine } from './engine'

export type ChatSlice = Pick<
  State,
  | 'active'
  | 'execOut'
  | 'error'
  | 'errorAction'
  | 'reportOnly'
  | 'failedDraft'
  | 'composerSeed'
  | 'queue'
  | 'userTextPersisted'
  | 'liveTrim'
  | 'turnCloses'
  | 'receipts'
  | 'memoryMode'
  | 'composerFocusRequest'
  | 'slashCommandsBySession'
  | 'memorySaved'
  | 'drafts'
  | 'convPrefs'
  | 'pendingConvPrefs'
  | 'turnOverrides'
  | 'send'
  | 'setConversationPref'
  | 'applyConversationPref'
  | 'setTurnOverride'
  | 'cancel'
  | 'clearError'
  | 'removeFromQueue'
  | 'enterMemoryMode'
  | 'exitMemoryMode'
  | 'requestComposerFocus'
  | 'setDraft'
>

export const createChatSlice =
  (engine: ChatEngine): StateCreator<State, [], [], ChatSlice> =>
  (set, get) => {
    const { sendTo, interruptedTurns } = engine
    return {
      active: null,
      execOut: null,
      error: null,
      errorAction: null,
      reportOnly: null,
      failedDraft: null,
      composerSeed: null,
      queue: [],
      userTextPersisted: false,
      liveTrim: NO_TRIM,
      turnCloses: {},
      receipts: {},
      memoryMode: null,
      composerFocusRequest: 0,
      slashCommandsBySession: {},
      memorySaved: null,
      drafts: {},
      convPrefs: {},
      pendingConvPrefs: {},
      turnOverrides: {},

      async send(text, memory) {
        const { selectedAgentId } = get()
        if (!selectedAgentId) return

        if (text.startsWith('!')) {
          const execOut = await api.exec(selectedAgentId, text.slice(1))
          set({ execOut })
          return
        }

        const { selected, agents, chosenProject } = get()
        const session = selected && sessionBelongsToAgent(selected, selectedAgentId, agents) ? selected : null

        // cwd only travels in the body when the destination is a NEW master
        // chat (no session) with a project already chosen — a normal agent,
        // or resuming a master session, never send it.
        const cwd = selectedAgentId === MASTER_ID && !session && chosenProject ? chosenProject : undefined

        // this turn's overrides go out NOW — the one-shot ("next turn") is
        // consumed here (whether sent directly or queued: either way, it's
        // traveled) and, for a NEW chat, the pending prefs go as the first
        // turn's overrides (the server doesn't have a conversation to look at
        // yet; chat-init will assign them to the real session — see applyChatEvent).
        const { turnOverrides, pendingConvPrefs } = get()
        const turnOverridesToSend: ConvPrefs = session ? { ...turnOverrides } : { ...pendingConvPrefs, ...turnOverrides }
        const overrides = Object.keys(turnOverridesToSend).length > 0 ? turnOverridesToSend : undefined
        if (Object.keys(turnOverrides).length > 0) set({ turnOverrides: {} })

        // naming at birth: the typed title travels on the FIRST send of a new
        // chat (no session) and is consumed here — whether it goes out
        // directly or through the queue, it's traveled (same contract as the
        // one-shot overrides above).
        const newChatTitle = !session ? get().newChatTitle?.trim() : undefined
        const title = newChatTitle ? newChatTitle : undefined
        if (get().newChatTitle !== null) set({ newChatTitle: null })

        // Memory mode: the file's CURRENT content is read HERE and the hidden
        // preamble is built HERE — AFTER the destination (agentId + session,
        // above) is already fixed. Reading it in the Composer before calling
        // send() opened an async gap in which switching conversation redirected
        // the edit to whatever was open when the read resolved; capturing the
        // destination first (same invariant as the queue drain) closes it.
        let outText = text
        if (memory) {
          let currentContent = ''
          try {
            currentContent = await api.memory.read(memory.path)
          } catch {
            // the file doesn't exist yet, or the read failed — best-effort empty.
          }
          outText = `[silos-memory path=${memory.path}]\n${currentContent}\n\nApply the user's instruction to this file; respond briefly with what changed.\n[/silos-memory]\n\n${text}`
        }

        // a turn is already in progress: don't interrupt it with an API call
        // — stack it with THIS moment's destination already fixed (agentId +
        // session) and drain it in order once the current turn finishes
        // (chat-done). Note: this queues against whichever turn is IN
        // PROGRESS (v1 doesn't support "one active turn per agent" — there's
        // only one global `active`).
        if (get().active?.status === 'streaming') {
          // queuing a message that starts a new chat (no session) also jumps
          // to 'chat' — the user watches the queue drain, same as if the send
          // had been direct (not queued).
          set((s) => ({
            queue: [
              ...s.queue,
              {
                text: outText,
                agentId: selectedAgentId,
                session,
                ...(cwd !== undefined ? { cwd } : {}),
                ...(memory ? { memoryPath: memory.path } : {}),
                ...(overrides !== undefined ? { overrides } : {}),
                // a snapshot of the destination's prefs — see QueueItem
                ...(session ? { convPrefs: { ...get().convPrefs } } : {}),
                ...(title !== undefined ? { title } : {}),
              },
            ],
            ...(session ? {} : { mobileView: 'chat' }),
          }))
          return
        }

        // starting a new chat (no session open yet) is, on mobile, the same
        // level-jump as openSession — it goes straight to the chat column. If
        // a session was already open (`session` non-null), it was already in
        // 'chat' since it was opened.
        if (!session) set({ mobileView: 'chat' })

        await sendTo(
          {
            agentId: selectedAgentId,
            session,
            cwd,
            ...(overrides !== undefined ? { overrides } : {}),
            ...(session ? { convPrefs: { ...get().convPrefs } } : {}),
            ...(title !== undefined ? { title } : {}),
          },
          outText,
          memory?.path,
        )
      },

      setConversationPref(patch) {
        const { selected } = get()
        if (selected) {
          // optimistic + fire-and-forget persistence (the same criterion as
          // persistProjectsPrefs): the chip shows the new truth right away; a
          // save failure only warns to the console.
          set((s) => ({ convPrefs: applyPatch(s.convPrefs, patch) }))
          api.conversationPrefs.patch(selected.folder, selected.id, patch).catch((e: unknown) => {
            console.warn('failed to save the conversation preference:', e)
          })
        } else {
          // a new chat with no session yet: stays as pendingPrefs and
          // chat-init assigns them to the real conversation (see applyChatEvent).
          set((s) => ({ pendingConvPrefs: applyPatch(s.pendingConvPrefs, patch) }))
        }
      },

      async applyConversationPref(patch) {
        const { selected } = get()
        if (!selected) {
          set((s) => ({ pendingConvPrefs: applyPatch(s.pendingConvPrefs, patch) }))
          return 'pending'
        }
        set((s) => ({ convPrefs: applyPatch(s.convPrefs, patch) }))
        try {
          const r = await api.conversationPrefs.patchApplied(selected.folder, selected.id, patch)
          return r.applied
        } catch (e) {
          console.warn('failed to save the conversation preference:', e)
          return 'next-turn'
        }
      },

      setTurnOverride(patch) {
        set((s) => ({ turnOverrides: applyPatch(s.turnOverrides, patch) }))
      },

      async cancel() {
        const { active } = get()
        if (!active) return
        interruptedTurns.add(active.turnId)
        await api.cancel(active.turnId)
      },

      clearError() {
        set({ error: null, errorAction: null, reportOnly: null })
      },

      removeFromQueue(i) {
        set((s) => ({ queue: s.queue.filter((_, idx) => idx !== i) }))
      },

      enterMemoryMode(path, name) {
        set({ memoryMode: { path, name } })
      },

      exitMemoryMode() {
        set({ memoryMode: null })
      },

      requestComposerFocus() {
        set((s) => ({ composerFocusRequest: s.composerFocusRequest + 1 }))
      },

      setDraft(key, text) {
        const cur = get().drafts
        if ((cur[key] ?? '') === text) return
        const next = { ...cur }
        if (text === '') delete next[key]
        else next[key] = text
        set({ drafts: next })
      },
    }
  }
