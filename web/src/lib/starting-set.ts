// starting-set.ts — the New agent form's one line about what a new project
// starts with (spec tools-origin §8, server/src/starting-set.ts): built from
// the classes the engine declares, never from an engine's name. A folder a
// project already has: it joins that project and loads what it loads. A new
// one: what the agent starts with, grouped by where each class comes from;
// for a folder that exists, whom the set reaches.
import type { StartingSetClass, StartingSetPreview } from './types'

const list = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

export type StartingLine = { kind: 'joins'; agents: string[] } | { kind: 'born'; starts: string; reaches: boolean }

export function startingLine(p: StartingSetPreview | null): StartingLine | null {
  if (!p || p.classes.length === 0) return null
  if (p.joins) return { kind: 'joins', agents: p.joins.agents.map((a) => a.name) }
  // what you set up on this machine (D6): its own class, said first
  const machineOn = p.classes.find((c) => c.covers === 'machine')?.on ?? true
  const accountClasses = p.classes.filter((c) => c.covers !== 'machine')
  const origins = [...new Set(accountClasses.map((c) => c.from))]
  const parts = origins.map((from) => {
    const on = accountClasses.filter((c) => c.from === from && c.on).map((c) => c.what)
    const off = accountClasses.filter((c) => c.from === from && !c.on).map((c) => c.what)
    if (off.length === 0) return ` and the ${list(on)} ${from} sends`
    if (on.length === 0) return `; the ${list(off)} ${from} sends stay off`
    return ` and the ${list(on)} ${from} sends; the ${list(off)} it sends stay off`
  })
  // what you set up here, counted when read — what the machine keeps off said apart
  const loads = machineLoads(p.facts?.machine)
  const mine = loads ? `your ${loads}` : 'what you set up on this machine'
  if (!machineOn) {
    // nothing of the machine's: the account's classes carry the sentence
    const rest = parts
      .join('')
      .replace(/^ and the /, 'the ')
      .replace(/^; the /, 'nothing from your account; the ')
    return { kind: 'born', starts: `Starts without what you set up on this machine${rest ? ` — with ${rest}` : ''}`, reaches: p.exists }
  }
  return { kind: 'born', starts: `Starts with ${mine}${parts.join('')}`, reaches: p.exists }
}

// ── the starting set, chosen (Welcome › At start, Settings › Accounts &
// providers): one class's words, built from what the engine declares —
// its title, the project list it is switched in, what goes when it is off

/** a class as the screens get it: Silos' recommendation and, when the user
 *  picked, their choice (GET /api/settings) */
export type ChosenClass = StartingSetClass & { chosen?: boolean }

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
/** «Plugins» — under a head that already says where they come from */
export const classWhat = (c: StartingSetClass): string => cap(c.what)
/** «Plugins from your Claude account» · «What you set up on this machine» */
export const classTitle = (c: StartingSetClass): string => (c.covers === 'machine' ? cap(c.what) : `${cap(c.what)} from ${c.from}`)
/** the project tab it is switched in */
export const classTab = (c: StartingSetClass): 'Skills' | 'Tools' | 'Tools and Skills' =>
  c.covers === 'skill' ? 'Skills' : c.covers === 'machine' ? 'Tools and Skills' : 'Tools'
/** what goes when it is off, and what comes when on — one line each, the same on every screen */
export const classOffWords = (c: StartingSetClass): string =>
  c.covers === 'machine'
    ? 'Off: a new project turns each one off in its own Tools and Skills — what you set up later will load. This machine is not changed.'
    : `Off: they wait in each project’s ${classTab(c)}, one click away.`
export const classOnWords = (c: StartingSetClass): string =>
  c.covers === 'machine'
    ? 'On: every new project loads them — what you set up later too.'
    : `On: every new project loads them — what ${c.from} sends later too.`
/** what the origin sends, when it was read: «Today: Linear, Figma and 2 more» */
export function sendsWords(names: readonly string[] | undefined, shown = 3): string | null {
  if (!names || names.length === 0) return null
  const head = names.slice(0, shown)
  const rest = names.length - head.length
  return `Today: ${rest > 0 ? `${head.join(', ')} and ${rest} more` : list(head)}`
}
/** what you set up on this machine — counted when read */
const counted = (m: { what: string; n: number }): string => `${m.n} ${m.n === 1 ? m.what.replace(/s$/, '') : m.what}`
/** what this machine keeps off, counted and named: «2 off on this machine (stripe, linear)» */
export function machineOffWords(machine: readonly { what: string; n: number; off?: string[] }[] | undefined, shown = 3): string | null {
  const off = (machine ?? []).flatMap((m) => m.off ?? [])
  if (off.length === 0) return null
  const head = off.slice(0, shown)
  return `${off.length} off on this machine (${head.join(', ')}${off.length > head.length ? ` and ${off.length - head.length} more` : ''})`
}
/** what a new project loads of what you set up on this machine — and what
 *  this machine keeps off, apart: «12 plugins · 3 MCP servers — 2 off on this machine (…)» */
export function machineLoads(machine: readonly { what: string; n: number; off?: string[] }[] | undefined): string | null {
  const parts = (machine ?? []).filter((m) => m.n > 0).map(counted)
  const off = machineOffWords(machine)
  if (parts.length === 0 && !off) return null
  return `${parts.length > 0 ? parts.join(' · ') : 'nothing'}${off ? ` — ${off}` : ''}`
}
export function machineWords(machine: readonly { what: string; n: number; off?: string[] }[] | undefined): string {
  const loads = machineLoads(machine)
  const turns = 'A project turns any one off in its Tools or Skills.'
  return loads ? `Every new project loads your ${loads}. ${turns}` : `Every new project loads the plugins, MCP servers and skills you add here. ${turns}`
}

/** whether a class is on: the tick, else the user's choice, else Recommended */
export const classOn = (c: ChosenClass, ticks: Readonly<Record<string, boolean>>): boolean => ticks[c.id] ?? c.chosen ?? c.recommended

/** What Create saves for one engine (PATCH /api/settings `startingSet`):
 *  a class that differs from Recommended carries its value; one back on
 *  Recommended while a choice is stored carries null; nothing else is sent.
 *  null: the set is Recommended and nothing is stored — no call at all. */
export function startingSetPatch(
  engine: string,
  classes: readonly ChosenClass[],
  ticks: Readonly<Record<string, boolean>>,
): Record<string, Record<string, boolean | null>> | null {
  const out: Record<string, boolean | null> = {}
  for (const c of classes) {
    const on = classOn(c, ticks)
    if (on !== c.recommended) out[c.id] = on
    else if (c.chosen !== undefined) out[c.id] = null
  }
  return Object.keys(out).length > 0 ? { [engine]: out } : null
}
