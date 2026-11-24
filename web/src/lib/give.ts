// give.ts — the gestures' words, ONE source:
// what the owner's gestures say BEFORE the click (Give, Open, Write) and what
// the live line says AFTER it. The dialog, the task page and the live line
// only call these; none composes a sentence of its own.
//
//   controlOf      how an agent moves: `own` (starts what you give it) or
//                  `told` (opens with you) — the server's DERIVED control
//                  (control.ts controlOf, carried as `controlNow`)
//   giveVoice      New task's buttons and the line under «For»
//   openLabel      the door names the surface: «Open console ›» / «Open chat ›»
//   surfaceOf      console only when the agent has a console in the index
//                  and its engine's console takes the briefing; else chat
//                  (the facts: server open-surface.ts)
//   liveStateOf    the server's live facts + the WS stream's pulse → a state
//   liveLine       Starting X… → X is on it · <tool> · <n>s ago → or X
//                  couldn't start: <why>; and the two queues
//   writeVoice     the task page's composer by control and state
//
// Words: Start = without you, Open = you go in; «things», never «turns».
import type { DoorMode } from '../components/tasks/TaskMode'
import type { TaskLiveFact } from './types'
import type { TurnPulse } from '../store/state'

export type Control = 'own' | 'told'

// the server says the effective one (an `own` without its territory or its
// mission operates as told); unknown reads as told — nothing starts on a guess
export function controlOf(a: { controlNow?: Control } | null | undefined): Control {
  return a?.controlNow === 'own' ? 'own' : 'told'
}

// a phone has no console to open (m8-r7): «Give» and «Send» alone
export function isPhone(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 639px)').matches
  } catch {
    return false
  }
}

// the surface Open goes to: a console only when one already exists for the
// agent (the first is always opened by the owner by hand) and its engine's
// console carries the briefing (OpenCode: always chat)
export function surfaceOf(o: { hasConsole: boolean; consoleBriefs: boolean }): DoorMode {
  return o.hasConsole && o.consoleBriefs ? 'console' : 'chat'
}

// an agent's surface, from the facts the overview carries (unknown ⇒ chat:
// the first console is always opened by the owner by hand)
export function surfaceOfAgent(a: { open?: { hasConsole: boolean; consoleBriefs: boolean } } | null | undefined): DoorMode {
  return surfaceOf(a?.open ?? { hasConsole: false, consoleBriefs: true })
}

export function openLabel(surface: DoorMode): string {
  return surface === 'console' ? 'Open console ›' : 'Open chat ›'
}

export interface GiveVoice {
  primary: { label: string; act: 'assign' | 'open' | 'add' }
  // «Save for later»: the task without the gesture
  secondary: { label: string; act: 'save' } | null
  // under «For»: what will happen
  line: string | null
}

// who: an agent (with its control and the surface Open would use) or you
export function giveVoice(o: { owner: { name: string; control: Control; surface: DoorMode } | null; mobile?: boolean }): GiveVoice {
  if (!o.owner) return { primary: { label: 'Add to my list', act: 'add' }, secondary: null, line: null }
  const { name, control, surface } = o.owner
  const later = { label: 'Save for later', act: 'save' as const }
  if (control === 'own') return { primary: { label: `Give to ${name}`, act: 'assign' }, secondary: later, line: 'Starts now, on its own' }
  // told: the owner goes in — the surface named on the button (m4/m8); on a
  // phone there is no console to open, so «Give» alone (m8-r7)
  if (o.mobile) return { primary: { label: 'Give', act: 'add' }, secondary: later, line: 'Opens with you — nothing starts without you' }
  return {
    primary: { label: surface === 'console' ? 'Give and open console ›' : 'Give and open chat ›', act: 'open' },
    secondary: later,
    line: 'Opens with you — nothing starts without you',
  }
}

// the live line of one turn on a task (the dialog's row and the task page)
export type LiveState =
  | { kind: 'starting' }
  // `lastAt` null: it is working, the stream has not spoken since you came
  | { kind: 'on-it'; tool: string | null; lastAt: number | null }
  | { kind: 'failed'; why: string; engine?: boolean }
  // the agent's own live turns hold it (OWN_TURNS_LIVE) …
  | { kind: 'queued-agent'; running: number }
  // … or the fleet's unattended turns (UNATTENDED_TURNS_LIVE_GLOBAL)
  | { kind: 'queued-fleet'; running: number }
  // held for another reason (its conversation busy, the throttle, the
  // ceiling — never a gesture's): the server's words
  | { kind: 'held'; why: string }
  // a console works it: no Stop — it is yours
  | { kind: 'console' }

// the server's facts (GET /api/tasks/mode `live`) read with what the WS
// stream said of the running turn: its first output turns «Starting» into
// «on it», an error into «couldn't start»
export function liveStateOf(fact: TaskLiveFact | null | undefined, pulse: Readonly<Record<string, TurnPulse>>): LiveState | null {
  if (!fact) return null
  switch (fact.kind) {
    case 'running': {
      const turn = fact.turns[0]!
      const p = pulse[turn.turnId]
      if (p?.ended === 'error') return { kind: 'failed', why: p.error ?? 'its turn ended with an error' }
      if (p && p.lastAt > 0) return { kind: 'on-it', tool: p.tool, lastAt: p.lastAt }
      return turn.started ? { kind: 'on-it', tool: null, lastAt: null } : { kind: 'starting' }
    }
    case 'queued':
      return fact.cap === 'agent' ? { kind: 'queued-agent', running: fact.running } : { kind: 'queued-fleet', running: fact.running }
    case 'failed':
      return { kind: 'failed', why: fact.why, ...(fact.engine ? { engine: true } : {}) }
    case 'held':
      return { kind: 'held', why: fact.why }
    case 'console':
      return { kind: 'console' }
    case 'starting':
      return { kind: 'starting' }
  }
}

export function liveLine(name: string, s: LiveState, now: number): { text: string; stop: boolean } {
  switch (s.kind) {
    case 'starting':
      return { text: `Starting ${name}…`, stop: true }
    case 'on-it': {
      if (s.lastAt === null) return { text: `${name} is on it${s.tool ? ` · ${s.tool}` : ''}`, stop: true }
      const ago = Math.max(0, Math.round((now - s.lastAt) / 1000))
      return { text: `${name} is on it${s.tool ? ` · ${s.tool}` : ''} · ${ago}s ago`, stop: true }
    }
    case 'failed':
      return { text: `${name} couldn't start: ${s.why}`, stop: false }
    case 'queued-agent':
      return { text: `${name} is running ${things(s.running)} already — it starts when one ends`, stop: false }
    case 'queued-fleet':
      return { text: `the fleet is running ${things(s.running)} — ${name} starts when one ends`, stop: false }
    case 'held':
      return { text: heldWords(name, s.why), stop: false }
    case 'console':
      return { text: 'Your console is on it', stop: false }
  }
}

export function heldWords(name: string, why: string): string {
  if (why.startsWith('its ')) return `${name}'s ${why.slice(4)}`
  if (/^(started|spent) /.test(why)) return `${name} ${why}`
  return `${name} waits — ${why}`
}

function things(n: number): string {
  return n === 1 ? '1 thing' : `${n} things`
}

export interface WriteVoice {
  placeholder: string
  primary: string
  // told: «Send and open ›» — your note, then you go in
  secondary: string | null
}

// the composer: `held` = what would hold a start right now (a live
// turn, an open console — the server's heldNow); `name` null = the task is yours
export function writeVoice(o: { name: string | null; control: Control; finished: boolean; held: string | null; mobile?: boolean }): WriteVoice {
  if (o.name === null) return { placeholder: 'Add a note for the record', primary: 'Add note', secondary: null }
  const n = o.name
  // told: «Send» is primary — the note stays and X reads it in its next
  // conversation; «Send and open ›» goes in with it (none on a phone, m8-r7)
  const open = o.control === 'told' && !o.mobile ? 'Send and open ›' : null
  if (o.finished) return { placeholder: `Write to ${n} — reopens it`, primary: 'Send', secondary: open }
  if (o.held) return { placeholder: `Write to ${n} — your note waits: ${o.held}`, primary: 'Send', secondary: null }
  return { placeholder: `Write to ${n}`, primary: 'Send', secondary: open }
}
