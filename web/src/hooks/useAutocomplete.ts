// useAutocomplete.ts — detects the '@' (files) and '/' (slash commands +
// skills) triggers in the composer, fetches suggestions with debounce+cache,
// and applies the chosen suggestion to the text/caret. Detection and
// replacement are pure functions (tested without a DOM); the hook wraps the
// fetch, the dropdown's selection/open state, and the commands+skills mix.
//
// slash menu: in Claude Code, '/' opens MANY real commands (/clear,
// /compact, /model, /usage, /mcp, /agents, /help, custom ones from
// .claude/commands…); Silos used to only list skills. Now the '/' menu lists
// the REAL commands announced by the SDK's init (a live-proof rule: only
// what genuinely exists in the session) in its own section, plus skills as
// before in theirs. "Natural" commands are MAPPED to Silos's native actions
// (see KNOWN_COMMANDS); the rest pass through as-is (inserted and executed
// by the SDK in the session).
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'

const DEBOUNCE_MS = 150

export interface Trigger {
  kind: 'files' | 'skills'
  q: string
  start: number // the trigger character's ('@' or '/') index in the text
}

export interface Applied {
  text: string
  caret: number
}

// native actions a "natural" slash command maps to instead of being passed
// raw to the SDK — resolved by the composer (see Composer.tsx).
export type CommandAction = 'new-conversation' | 'open-model'

// a dropdown entry. `value` is the insertable text (no prefix) for text
// items; `section` groups them visually (Commands vs Skills vs files);
// `action`, when present, makes accepting the item fire a native action
// instead of inserting text.
export interface Suggestion {
  value: string
  label: string
  section: 'commands' | 'skills' | 'files'
  description?: string
  action?: CommandAction
}

// the result of accepting an item: insert text into the composer, or fire a
// native action (the mapping for '/clear', '/model'…). Discriminated so the
// composer decides without guessing.
export type AcceptResult = { kind: 'text'; applied: Applied } | { kind: 'action'; action: CommandAction; trigger: Trigger }

// metadata for the KNOWN slash commands: a menu description and, when it
// applies, the mapping to a native Silos action. The command LIST shown
// always comes from init (a live-proof rule); this map only enriches the
// ones we recognize — a command not listed here (e.g. a custom one) still
// shows up, with no description, as passthrough (inserted and run by the SDK).
export interface CommandMeta {
  description?: string
  action?: CommandAction
}
export const KNOWN_COMMANDS: Record<string, CommandMeta> = {
  // mapped to native UI (do what Silos already does, no raw passthrough)
  clear: { description: 'Start a new conversation', action: 'new-conversation' },
  model: { description: 'Change the model for this conversation', action: 'open-model' },
  // passthrough with a description (the SDK runs these in the session)
  compact: { description: 'Summarize and shorten this conversation' },
  usage: { description: 'Show plan usage and limits' },
  mcp: { description: 'Manage MCP servers' },
  agents: { description: 'Manage agents and subagents' },
  help: { description: 'List available commands' },
  context: { description: 'Show token context usage' },
  cost: { description: 'Show the cost of this session' },
  config: { description: 'Open the configuration panel' },
  init: { description: 'Generate a CLAUDE.md for this project' },
  review: { description: 'Review a pull request' },
  memory: { description: 'Edit memory files' },
  doctor: { description: 'Diagnose the installation' },
  status: { description: 'Show the current session status' },
}

// belt-and-suspenders for the mapping: given the composer's FINAL text (on
// send) returns the native action if that text is EXACTLY a mapped command
// ANNOUNCED by the session (init's commands) — so '/clear' or '/model' never
// slip through as a raw message to the SDK even if the autocomplete trigger
// had already broken before Enter (a prior Esc, a trailing space, etc., which
// turn the dropdown off). With args ('/model sonnet') the full name no longer
// matches any command -> null -> passes through as-is (honest). A pure function.
export function commandAction(text: string, commands: string[]): CommandAction | null {
  const t = text.trim()
  if (!t.startsWith('/')) return null
  const name = t.slice(1)
  if (!commands.map((c) => c.replace(/^\//, '')).includes(name)) return null
  return KNOWN_COMMANDS[name]?.action ?? null
}

// '@' triggers file autocomplete anywhere preceded by whitespace (or at the
// message's start); a space (or a second '@') after the '@' kills the
// trigger — the user already finished typing the mention. Always checked
// FIRST: a '/finance check @docs/inv' still triggers files even though the
// message starts with '/' (that '/' is no longer the first character up to
// the caret, just text within the command).
// '/' only triggers commands+skills when, after ruling out '@', the message
// starts with '/' and the caret is still within that first word (no spaces).
// `kind` stays 'skills' for compatibility (the trigger doesn't distinguish a
// command from a skill — the item list decides that).
export function detectTrigger(text: string, caret: number): Trigger | null {
  const beforeCaret = text.slice(0, caret)

  const idx = beforeCaret.lastIndexOf('@')
  if (idx !== -1) {
    const prev = beforeCaret[idx - 1]
    const precededBySpace = idx === 0 || (prev !== undefined && /\s/.test(prev))
    if (precededBySpace) {
      const q = beforeCaret.slice(idx + 1)
      if (!/\s/.test(q) && !q.includes('@')) {
        return { kind: 'files', q, start: idx }
      }
    }
  }

  if (beforeCaret.startsWith('/')) {
    const q = beforeCaret.slice(1)
    if (/\s/.test(q)) return null
    return { kind: 'skills', q, start: 0 }
  }

  return null
}

// replaces from trigger.start to caret with '@suggestion ' (or '/suggestion ')
// and leaves the caret right after the inserted space.
export function applySuggestion(text: string, caret: number, trigger: Trigger, suggestion: string): Applied {
  const prefix = trigger.kind === 'files' ? '@' : '/'
  const inserted = `${prefix}${suggestion} `
  const newText = text.slice(0, trigger.start) + inserted + text.slice(caret)
  return { text: newText, caret: trigger.start + inserted.length }
}

// slash menu: builds COMMAND suggestions from the real list from init
// (`commands`), filtered by what was typed and enriched with a
// description/action when the command is known. A pure function (tested).
export function buildCommands(commands: string[], q: string): Suggestion[] {
  const qq = q.toLowerCase()
  return [...new Set(commands.map((c) => c.replace(/^\//, '')))]
    .filter((c) => c !== '' && c.toLowerCase().includes(qq))
    .sort((a, b) => {
      // ones starting with what was typed come first (the same criterion as files)
      const pa = a.toLowerCase().startsWith(qq) ? 0 : 1
      const pb = b.toLowerCase().startsWith(qq) ? 0 : 1
      return pa - pb || a.localeCompare(b)
    })
    .map((c) => {
      const meta = KNOWN_COMMANDS[c]
      const sug: Suggestion = { value: c, label: `/${c}`, section: 'commands' }
      if (meta?.description) sug.description = meta.description
      if (meta?.action) sug.action = meta.action
      return sug
    })
}

export interface Autocomplete {
  open: boolean
  items: Suggestion[]
  selected: number
  moveSelection(d: 1 | -1): void
  close(): void
  accept(): AcceptResult | null
  resolve(sug: Suggestion): AcceptResult | null
  ghost: string | null
}

export function useAutocomplete(text: string, caret: number, agentId: string | null, commands: string[] = []): Autocomplete {
  const trigger = detectTrigger(text, caret)
  // raw server results for the current trigger: files (kind 'files') or
  // skills (kind 'skills'). Commands do NOT go through here — they come
  // synchronously from `commands` (already fetched by init).
  const [fetched, setFetched] = useState<string[]>([])
  const [selected, setSelected] = useState(0)
  const [manuallyClosed, setManuallyClosed] = useState(false)
  const cacheRef = useRef(new Map<string, string[]>())
  const previousSessionRef = useRef<string | null>(null)

  // the identity of the current autocomplete "session": the trigger's
  // kind+position. When it changes (a new trigger, or the trigger
  // disappears) the selection and the manual Esc-close both reset.
  const session = trigger ? `${trigger.kind}:${trigger.start}` : null
  useEffect(() => {
    if (session !== previousSessionRef.current) {
      setSelected(0)
      setManuallyClosed(false)
    }
    previousSessionRef.current = session
  }, [session])

  useEffect(() => {
    if (!trigger || !agentId) {
      setFetched([])
      return
    }
    const key = `${trigger.kind}:${trigger.q}`
    const cached = cacheRef.current.get(key)
    if (cached) {
      setFetched(cached)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void api.complete(agentId, trigger.kind, trigger.q).then((result) => {
        if (cancelled) return
        cacheRef.current.set(key, result)
        setFetched(result)
      })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger?.kind, trigger?.q, agentId])

  // the final item list, already in the `Suggestion` shape, sectioned. For
  // '/': real commands (from init) first, then skills; for '@': files.
  const items = useMemo<Suggestion[]>(() => {
    if (!trigger) return []
    if (trigger.kind === 'files') {
      return fetched.map((p) => ({ value: p, label: p, section: 'files' as const }))
    }
    const cmds = buildCommands(commands, trigger.q)
    const skills = fetched.map((s) => ({ value: s, label: `/${s}`, section: 'skills' as const }))
    return [...cmds, ...skills]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger?.kind, trigger?.q, fetched, commands])

  // if the list shrinks (fewer items than the selected index), it re-anchors
  // to the first one — avoids an out-of-range selection while filtering.
  useEffect(() => {
    if (selected >= items.length) setSelected(0)
  }, [items.length, selected])

  const open = trigger !== null && !manuallyClosed && items.length > 0

  function moveSelection(d: 1 | -1): void {
    if (items.length === 0) return
    setSelected((s) => (s + d + items.length) % items.length)
  }

  function close(): void {
    setManuallyClosed(true)
  }

  // resolves one item to its result (text to insert or a native action).
  function resolve(sug: Suggestion): AcceptResult | null {
    if (!trigger) return null
    if (sug.action) return { kind: 'action', action: sug.action, trigger }
    return { kind: 'text', applied: applySuggestion(text, caret, trigger, sug.value) }
  }

  function accept(): AcceptResult | null {
    if (!open) return null
    const sug = items[selected]
    if (sug === undefined) return null
    return resolve(sug)
  }

  const chosen = items[selected]
  const ghost = trigger && chosen !== undefined && chosen.value.startsWith(trigger.q) ? chosen.value.slice(trigger.q.length) : null

  return { open, items, selected, moveSelection, close, accept, resolve, ghost }
}
