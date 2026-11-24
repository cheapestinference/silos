// Composer.tsx — the conversation's input box: normal chat, shell mode with
// a '!' prefix (paints the border and uses a monospace font), and autosize
// between 1 and 8 rows based on scrollHeight. During a streaming turn the
// textarea stays enabled (a message queue): typing + Enter doesn't interrupt
// the turn, it stacks it (store.send decides queue vs send); the send button
// switches to an "add to queue" icon meanwhile (the stop button lives in
// StatusLine, next to the active turn, not here). When streaming ends, focus
// is restored if nothing else had it. It also supports autocomplete for
// '@files' and '/commands+skills' (useAutocomplete): the '/' menu lists the
// REAL slash commands from init (mapping the natural ones to native actions:
// /clear→new conversation, /model→model menu) and skills, in separate
// sections. Dropdown above the textarea, ↑/↓ navigation, Tab or Enter to
// accept, Esc to close, and ghost text with the chosen suggestion's suffix.
// Above the textarea mounts the queued items' chip row, and — in memory mode
// — the "✦ Editing memory: <name>" chip with its ✕.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent, MouseEvent, SyntheticEvent } from 'react'
import { ArrowUp, ChevronDown, ListPlus, X } from 'lucide-react'
import { useStore, draftKeyOf } from '../store'
import { commandAction, applySuggestion, detectTrigger, useAutocomplete, type CommandAction, type Suggestion, type Trigger } from '../hooks/useAutocomplete'
import { CockpitChips } from './CockpitChips'
import { MASTER_ID } from '../lib/constants'
import { AutomationSheet } from './AutomationSheet'

const MAX_ROWS = 8

export interface ComposerHandle {
  focus(): void
}

export const Composer = forwardRef<ComposerHandle>(function Composer(_props, ref) {
  const send = useStore((s) => s.send)
  const active = useStore((s) => s.active)
  const selectedAgentId = useStore((s) => s.selectedAgentId)
  const selected = useStore((s) => s.selected)
  const chosenProject = useStore((s) => s.chosenProject)
  const agents = useStore((s) => s.agents)
  const failedDraft = useStore((s) => s.failedDraft)
  const composerSeed = useStore((s) => s.composerSeed)
  const memoryMode = useStore((s) => s.memoryMode)
  const exitMemoryMode = useStore((s) => s.exitMemoryMode)
  const composerFocusRequest = useStore((s) => s.composerFocusRequest)
  // the unsent text survives leaving the conversation: kept per
  // conversation in store.drafts (the new chat
  // per agent), restored here on mount and whenever the conversation
  // changes under a mounted Composer; cleared on send.
  const draftKey = draftKeyOf(selected, selectedAgentId)
  const [text, setText] = useState(() => useStore.getState().drafts[draftKey] ?? '')
  const [caret, setCaret] = useState(0)
  const [focused, setFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pendingCaretRef = useRef<number | null>(null)
  const draftKeyRef = useRef(draftKey)
  useEffect(() => {
    if (draftKeyRef.current === draftKey) return
    draftKeyRef.current = draftKey
    const restored = useStore.getState().drafts[draftKey] ?? ''
    pendingCaretRef.current = restored.length
    setText(restored)
    setCaret(restored.length)
  }, [draftKey])
  useEffect(() => {
    useStore.getState().setDraft(draftKeyRef.current, text)
  }, [text])

  // caret ▾ on the send button (Slack: Send now / Once at… / Every…) — opens
  // the menu, and choosing once/every mounts the inline sheet (AutomationSheet)
  // right above the composer. `scheduleNotice` is the ephemeral toast-line
  // after a successful Schedule ("⏰ Scheduled — <name>"), the same timer
  // pattern as CONFIRM_ARCHIVE_AGENT_MS in Sidebar.tsx.
  const [menuOpen, setMenuOpen] = useState(false)
  const [sheetKind, setSheetKind] = useState<'once' | 'every' | null>(null)
  const [scheduleNotice, setScheduleNotice] = useState<string | null>(null)
  const scheduleNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    return () => {
      if (scheduleNoticeTimer.current) clearTimeout(scheduleNoticeTimer.current)
    }
  }, [])

  // closes the caret menu on an outside click — the same lightweight
  // criterion as the rest of the app's floating menus (no popover library).
  useEffect(() => {
    if (!menuOpen) return
    function onPointerDown(e: PointerEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [menuOpen])

  // slash menu: the real commands of the open conversation (captured from
  // that session's chat-init) — with no session yet (a new chat, no init)
  // the list is empty and the '/' menu falls back to skills only (a safe degradation).
  const slashCommandsBySession = useStore((s) => s.slashCommandsBySession)
  const commands = selected ? (slashCommandsBySession[`${selected.folder}/${selected.id}`] ?? []) : []

  const trigger = detectTrigger(text, caret)
  const autocomplete = useAutocomplete(text, caret, selectedAgentId, commands)

  useImperativeHandle(ref, () => ({
    focus() {
      textareaRef.current?.focus()
    },
  }))

  const streaming = active?.status === 'streaming'
  const isShell = text.startsWith('!')
  // "Anywhere" in the UI for the master agent (its id stays 'master').
  const agentName = selectedAgentId === MASTER_ID ? 'Anywhere' : (agents.find((a) => a.id === selectedAgentId)?.name ?? 'your agent')
  const showGhost = focused && caret === text.length && autocomplete.ghost !== null
  // master with no open session needs a chosen project (see ProjectSelector)
  // before it can type — master's new chat requires `cwd` in the body,
  // which only exists once one is chosen.
  const needsProject = selectedAgentId === MASTER_ID && !selected && !chosenProject

  // when a turn ends (streaming true → false) we return focus to the
  // textarea — but only if it's still "free" (document.body): if the user
  // opened the session-rename input (or any other control) meanwhile, we
  // don't steal it.
  const prevStreamingRef = useRef(streaming)
  useEffect(() => {
    if (prevStreamingRef.current && !streaming && document.activeElement === document.body) {
      textareaRef.current?.focus()
    }
    prevStreamingRef.current = streaming
  }, [streaming])

  // the panel's "Edit with chat" lives outside Chat.tsx's tree — it can't
  // call composerRef.current.focus() directly, so it requests focus by
  // incrementing composerFocusRequest (see store.requestComposerFocus).
  // The initial value is ignored (0 → no effect on mount).
  const firstFocusRef = useRef(true)
  useEffect(() => {
    if (firstFocusRef.current) {
      firstFocusRef.current = false
      return
    }
    textareaRef.current?.focus()
  }, [composerFocusRequest])

  // a send failed (send() left it in store.failedDraft so the message
  // isn't lost): we return it to the textarea with the caret at the end —
  // but only if the textarea is still empty. The old request could take a
  // while to fail while the user was already typing a new message (the
  // textarea isn't disabled until the POST resolves); in that case we don't
  // overwrite what they're writing — the ErrorStrip still warns of the
  // failure either way. Reuses the pending-caret mechanism below.
  //
  // the draft carries the agent it was addressed to — a failed queue drain
  // almost always points to a DIFFERENT agent than the one being viewed
  // (the target was fixed when queued, not at the moment of failure). If it
  // doesn't match selectedAgentId it's neither consumed nor restored: it's
  // left intact in the store for when the user gets to that agent — hence
  // selectedAgentId is in the deps, not just failedDraft (Composer doesn't
  // remount when the agent changes).
  useEffect(() => {
    if (failedDraft === null) return
    if (failedDraft.agentId !== selectedAgentId) return
    if (text === '') {
      pendingCaretRef.current = failedDraft.text.length
      setText(failedDraft.text)
      setCaret(failedDraft.text.length)
    }
    useStore.setState({ failedDraft: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedDraft, selectedAgentId])

  // edit-by-chat seed: a freshly opened chat pre-fills the composer with a
  // reference to the file being edited (askAgentAboutFile). Same guards as
  // failedDraft — only the matching agent, only into an empty textarea — so
  // it never misdelivers or clobbers what the user is typing. One-shot.
  useEffect(() => {
    if (composerSeed === null) return
    if (composerSeed.agentId !== selectedAgentId) return
    if (text === '') {
      pendingCaretRef.current = composerSeed.text.length
      setText(composerSeed.text)
      setCaret(composerSeed.text.length)
    }
    useStore.setState({ composerSeed: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerSeed, selectedAgentId])

  // applies a pending caret (after accepting a suggestion, or after
  // restoring a failed draft) once the DOM reflects the new `text`.
  useEffect(() => {
    const pending = pendingCaretRef.current
    if (pending === null) return
    pendingCaretRef.current = null
    const el = textareaRef.current
    if (!el) return
    el.selectionStart = pending
    el.selectionEnd = pending
    autosize(el)
  }, [text])

  function autosize(el: HTMLTextAreaElement): void {
    el.style.height = 'auto'
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20
    el.style.height = `${Math.min(el.scrollHeight, lineHeight * MAX_ROWS)}px`
  }

  function onChange(e: ChangeEvent<HTMLTextAreaElement>): void {
    setText(e.target.value)
    setCaret(e.target.selectionStart ?? e.target.value.length)
    autosize(e.target)
  }

  function onSelect(e: SyntheticEvent<HTMLTextAreaElement>): void {
    setCaret(e.currentTarget.selectionStart ?? 0)
  }

  // in memory mode, Enter doesn't send `text` as-is — the store's send() wraps
  // it in a hidden preamble with the path and the file's CURRENT content (read
  // fresh at send time, after the destination is fixed). The preamble is
  // stripped from the UI the same as [silos-context] — see stripAgentContext.

  function sendIfHasText(): void {
    if (needsProject) return
    const trimmed = text.trim()
    if (!trimmed) return
    // slash menu (belt-and-suspenders): if the final text is EXACTLY a
    // command the session mapped and advertised, the native action runs
    // instead of sending it raw — even if the autocomplete trigger had
    // broken before Enter (a prior Esc, a trailing space…). A literal
    // '/clear' or '/model' never travels as a message to the SDK session.
    const action = commandAction(text, commands)
    if (action) {
      setText('')
      setCaret(0)
      const el = textareaRef.current
      if (el) el.style.height = 'auto'
      dispatchAction(action)
      return
    }
    // sent: the draft is gone (cleared under the key it was written for,
    // before the send can move the selection to a new conversation)
    useStore.getState().setDraft(draftKeyRef.current, '')
    if (memoryMode) {
      const capturedMemory = memoryMode
      exitMemoryMode()
      // pass the RAW text + path — send() reads the file content and builds the
      // preamble itself, AFTER it has fixed the destination, so switching
      // conversation during that read can't misdeliver the edit.
      void send(text, { path: capturedMemory.path })
    } else {
      void send(text)
    }
    setText('')
    setCaret(0)
    const el = textareaRef.current
    if (el) el.style.height = 'auto'
    el?.focus()
  }

  function acceptSuggestion(res: { text: string; caret: number }): void {
    pendingCaretRef.current = res.caret
    setText(res.text)
    setCaret(res.caret)
  }

  // removes the trigger's text from the textarea (e.g. '/model') after
  // mapping a command to a native action — the command was "consumed", it
  // shouldn't remain written. Leaves the caret where the trigger started.
  function clearTrigger(tr: Trigger): void {
    const updated = text.slice(0, tr.start) + text.slice(caret)
    pendingCaretRef.current = tr.start
    setText(updated)
    setCaret(tr.start)
  }

  // slash menu: the "natural" commands map to what Silos already does
  // natively instead of passing the raw command through. Dispatching the
  // action is kept apart from clearing the text — that way both the
  // autocomplete path (clears only the trigger) and the send guard (clears
  // the whole textarea) can share it.
  function dispatchAction(action: CommandAction): void {
    if (action === 'new-conversation') {
      // '/clear' → the same new conversation as "+ New conversation"
      useStore.getState().startNewConversation()
    } else if (action === 'open-model') {
      // '/model' → «Run on», the one editor of the model (ProviderPanel)
      useStore.getState().openProviderPanel(null)
    }
  }

  function runAction(action: CommandAction, tr: Trigger): void {
    clearTrigger(tr)
    dispatchAction(action)
  }

  function chooseItem(item: Suggestion): void {
    if (!trigger) return
    if (item.action) {
      runAction(item.action, trigger)
      return
    }
    acceptSuggestion(applySuggestion(text, caret, trigger, item.value))
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.nativeEvent.isComposing) return // don't interrupt an IME mid-composition, not even with the dropdown open

    if (autocomplete.open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        autocomplete.moveSelection(1)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        autocomplete.moveSelection(-1)
        return
      }
      // Shift+Enter doesn't accept: it's let through as a normal line break
      // (the trigger recalculates against the new text, and the dropdown
      // only closes if the new line breaks it).
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        const res = autocomplete.accept()
        if (res?.kind === 'text') acceptSuggestion(res.applied)
        else if (res?.kind === 'action') runAction(res.action, res.trigger)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        autocomplete.close()
        return
      }
    }

    // ↑ in the EMPTY composer pulls the LAST message queued FOR THE VISIBLE
    // AGENT out of the queue and puts it in the textarea for editing —
    // repeated, it keeps pulling further back. With text already written
    // (guard above: text === '') or with the dropdown open (already
    // intercepted above) ↑ doesn't steal the caret: normal behavior. A
    // later Esc with the message already dequeued in the textarea does NOT
    // re-queue it — it stays as a normal draft (kept simple). Resending it
    // with Enter re-captures the target at THAT moment (send() reads the
    // current selectedAgentId/selected), not the one from when it was queued.
    if (e.key === 'ArrowUp' && text === '') {
      const queue = useStore.getState().queue
      let idx = -1
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i]!.agentId === selectedAgentId) {
          idx = i
          break
        }
      }
      if (idx !== -1) {
        e.preventDefault()
        const item = queue[idx]!
        useStore.getState().removeFromQueue(idx)
        pendingCaretRef.current = item.text.length
        setText(item.text)
        setCaret(item.text.length)
        return
      }
    }

    // Cmd/Ctrl+Enter: an explicit alternative to Enter for send (the
    // shortcuts overlay lists it next to Enter) — same target as plain Enter.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      sendIfHasText()
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendIfHasText()
    }
  }

  return (
    <>
      {/* the queue no longer lives above the input — it's painted shaded
          inside the conversation (PendingQueue in Transcript), like
          claude.ai. Its chip row was removed from the composer. */}
      {memoryMode ? (
        <div className="mx-auto mb-1 flex w-full max-w-[48rem] items-center px-1">
          <span className="flex items-center gap-1.5 rounded-full border border-terracotta/40 bg-terracotta-soft px-2 py-0.5 text-xs text-ink">
            <span aria-hidden="true" className="text-terracotta">
              ✦
            </span>
            <span className="max-w-[20rem] truncate">Editing memory: {memoryMode.name}</span>
            <button
              type="button"
              aria-label="exit memory mode"
              onClick={exitMemoryMode}
              className="text-ink-2 transition-colors duration-150 hover:text-terracotta"
            >
              <X size={12} />
            </button>
          </span>
        </div>
      ) : null}
      {/* the inline sheet (When it runs · How it runs) — mounted ABOVE the
          composer (never a modal), with the already-written text as its
          starting prompt; «More options ›» hands it to the editor */}
      {sheetKind && selectedAgentId ? (
        <AutomationSheet
          ctx={{
            agentId: selectedAgentId,
            defaultPrompt: text,
            defaultKind: sheetKind,
            defaultThread: selected
              ? { folder: selected.folder, sessionId: selected.id }
              : selectedAgentId === MASTER_ID && chosenProject
                ? { folder: chosenProject }
                : undefined,
          }}
          onClose={() => setSheetKind(null)}
          onSaved={(a) => {
            setSheetKind(null)
            setText('')
            setCaret(0)
            void useStore.getState().loadAutomations()
            setScheduleNotice(`⏰ Automation created — ${a.name}`)
            if (scheduleNoticeTimer.current) clearTimeout(scheduleNoticeTimer.current)
            scheduleNoticeTimer.current = setTimeout(() => setScheduleNotice(null), 4000)
          }}
        />
      ) : null}
      {scheduleNotice ? <div className="mx-auto mb-1 w-full max-w-[48rem] px-1 text-xs text-ink-2">{scheduleNotice}</div> : null}
      {/* the composer is a FLAT surface — a 1px border over the background,
          no shadow (shadow-lg made it look "like a webpage"); focus is
          conveyed by the border, like the rest of the app's visual language.
          Generous padding and 15px text (the same body size as the
          transcript): a prompt, not a form input. */}
      <div
        data-mode={isShell ? 'shell' : undefined}
        className={`relative mx-auto mb-4 flex w-full max-w-[48rem] shrink-0 flex-col rounded-2xl border bg-canvas px-4 py-2.5 transition-colors duration-150 ${
          isShell ? 'border-terracotta' : 'border-line focus-within:border-terracotta/40'
        }`}
      >
        <div className="flex w-full items-end gap-2">
          <div className="relative min-w-0 flex-1">
            {showGhost && (
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-x-0 top-0 overflow-hidden whitespace-pre-wrap break-words py-1 text-[15px] leading-[1.4em] ${
                  isShell ? 'font-mono' : ''
                }`}
              >
                <span className="invisible">{text}</span>
                <span className="text-ink-2">{autocomplete.ghost}</span>
              </div>
            )}
            <textarea
              ref={textareaRef}
              rows={1}
              value={text}
              onChange={onChange}
              onSelect={onSelect}
              onKeyDown={onKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => {
                setFocused(false)
                autocomplete.close()
              }}
              disabled={needsProject}
              placeholder={needsProject ? 'Pick a project above to start chatting' : `Message ${agentName}…`}
              aria-label="message"
              aria-describedby={needsProject ? undefined : 'composer-affordances'}
              className={`relative min-h-[1.4em] w-full resize-none bg-transparent py-1 text-[15px] leading-[1.4em] outline-none placeholder:text-ink-2 focus-visible:outline-none disabled:opacity-60 ${
                isShell ? 'font-mono' : ''
              }`}
            />
            {/* the affordances moved out of the placeholder (they stretched it
              until it looked like a banner) into a mono guide row under the
              input, visible only when the composer is empty and focused.
              The row ALWAYS reserves its height (only opacity toggles) — no
              layout jumps while focusing/typing (the transcript is anchored
              above it); and for screen readers the text lives in a sr-only
              element linked by aria-describedby (the visual div stays
              aria-hidden: it's the decorative copy). */}
            {!needsProject ? (
              <>
                <span id="composer-affordances" className="sr-only">
                  ! for shell · / commands · @ files
                </span>
                <div
                  aria-hidden="true"
                  className={`pointer-events-none h-4 pb-0.5 font-mono text-[10px] tracking-wide text-ink-2/80 transition-opacity duration-150 ${
                    focused && text === '' ? 'opacity-100' : 'opacity-0'
                  }`}
                >
                  ! for shell · / commands · @ files
                </div>
              </>
            ) : null}
            {autocomplete.open && (
              <div
                role="listbox"
                className="absolute bottom-full left-0 z-10 mb-1 max-h-72 w-80 overflow-auto rounded-lg border border-line bg-canvas shadow-sm"
              >
                {autocomplete.items.map((item, i) => {
                  // a section header — only in the '/' menu (Commands/Skills),
                  // and only when it changes relative to the previous item.
                  // Files ('@') get no header (a single section).
                  const prevItem = autocomplete.items[i - 1]
                  const newSection = item.section !== 'files' && item.section !== prevItem?.section
                  return (
                    <div key={`${item.section}:${item.value}`}>
                      {newSection ? (
                        <div className="px-3 pb-0.5 pt-2 font-mono text-[10px] uppercase tracking-wide text-ink-2/70">
                          {item.section === 'commands' ? 'Commands' : 'Skills'}
                        </div>
                      ) : null}
                      <div
                        role="option"
                        aria-selected={i === autocomplete.selected}
                        onMouseDown={(e: MouseEvent) => {
                          e.preventDefault() // don't lose the textarea's focus
                          chooseItem(item)
                        }}
                        className={`flex cursor-pointer flex-col gap-0.5 px-3 py-1.5 ${i === autocomplete.selected ? 'bg-panel' : ''}`}
                      >
                        <span className={`truncate text-sm ${item.section === 'files' ? 'font-mono' : ''}`}>{item.label}</span>
                        {item.description ? <span className="truncate text-xs text-ink-2">{item.description}</span> : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          {/* the terminal button left the composer — starting the console
            lives in the persistent bottom bar (TerminalPanel). */}
          <div ref={menuRef} className="relative flex shrink-0 items-center">
            {/* caret ▾ (Slack pattern) — Send now / Once at… / Every…. HIDDEN
              until there's text (a permanently disabled sliver made the
              empty composer look ugly); with text it's a real split-button
              segment — same height as the send button, ~28px, a 1px
              divider, the same radius family. Still not offered while
              streaming (queuing automations isn't a use case — it would
              stack against the turn in progress). */}
            {text.trim() && !needsProject && !streaming ? (
              <button
                type="button"
                aria-label="schedule options"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
                className="flex h-9 w-7 shrink-0 items-center justify-center rounded-l-full bg-terracotta text-on-terracotta hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
              >
                <ChevronDown size={14} />
              </button>
            ) : (
              // the caret's slot — reserves its 28px so the button group
              // doesn't widen (and the textarea doesn't shrink) on the first
              // keystroke. Invisible, no semantics.
              <span data-testid="caret-slot" aria-hidden="true" className="h-9 w-7 shrink-0" />
            )}
            {menuOpen ? (
              <div role="menu" className="absolute bottom-full right-0 z-10 mb-1 w-40 rounded-lg border border-line bg-canvas p-1 shadow-lg">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    sendIfHasText()
                  }}
                  className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-panel"
                >
                  Send now
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    setSheetKind('once')
                  }}
                  className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-panel"
                >
                  Once at…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    setSheetKind('every')
                  }}
                  className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-panel"
                >
                  Every…
                </button>
              </div>
            ) : null}
            {/* with the caret visible, send is the split-button's right
              segment (a 1px divider, radius only on the right); with no
              caret it goes back to the usual round button. */}
            <button
              type="button"
              aria-label={streaming ? 'add to queue' : 'send'}
              disabled={!text.trim() || needsProject}
              onClick={sendIfHasText}
              className={`flex h-9 w-9 shrink-0 items-center justify-center bg-terracotta text-on-terracotta hover:opacity-90 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40 ${
                text.trim() && !needsProject && !streaming ? 'rounded-r-full border-l border-on-terracotta/25' : 'rounded-full'
              }`}
            >
              {streaming ? <ListPlus size={16} /> : <ArrowUp size={16} />}
            </button>
          </div>
        </div>
        {/* the cockpit chip row, bottom-left, inside the composer's
            container — the same placement as claude.ai's model picker. On
            mobile the row scrolls horizontally, never wraps (CockpitChips
            is already overflow-x-auto + shrink-0 per chip). */}
        {!needsProject ? (
          <div className="mt-1 flex w-full items-center">
            <CockpitChips />
          </div>
        ) : null}
      </div>
    </>
  )
})
