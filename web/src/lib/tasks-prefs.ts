// tasks-prefs.ts — the Tasks view's per-viewer memory:
// the sidebar's «Conversations | Tasks» choice, the last preset and the last
// layout. localStorage, every access wrapped: a private window, blocked site
// data or a thumbnail capture throws or comes back empty, and the view then
// opens on its defaults (Conversations · Mine · list) — never broken.
import { TASK_LAYOUTS, TASK_PRESETS, type TaskLayout, type TaskPreset } from './tasks'

const KEYS = {
  list: 'silos.sidebar.list',
  preset: 'silos.tasks.preset',
  layout: 'silos.tasks.layout',
  plans: 'silos.sidebar.tasks.expanded',
  lens: 'silos.tasks.lens',
} as const

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* the choice lives for this page only */
  }
}

export type SidebarList = 'conversations' | 'tasks'
export function readSidebarList(): SidebarList {
  return read(KEYS.list) === 'tasks' ? 'tasks' : 'conversations'
}
export function writeSidebarList(v: SidebarList): void {
  write(KEYS.list, v)
}

export function readPreset(): TaskPreset {
  const v = read(KEYS.preset)
  return TASK_PRESETS.some((p) => p.id === v) ? (v as TaskPreset) : 'mine'
}
export function writePreset(v: TaskPreset): void {
  write(KEYS.preset, v)
}

export function readLayout(): TaskLayout {
  const v = read(KEYS.layout)
  return (TASK_LAYOUTS as readonly string[]).includes(v ?? '') ? (v as TaskLayout) : 'list'
}
export function writeLayout(v: TaskLayout): void {
  write(KEYS.layout, v)
}

// the plans the viewer unfolded in the sidebar's Tasks list (plan keys)
export function readExpandedPlans(): string[] {
  try {
    const v = JSON.parse(read(KEYS.plans) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
export function writeExpandedPlans(keys: readonly string[]): void {
  write(KEYS.plans, JSON.stringify(keys))
}

// the lens chip: on by default once a lens is installed; the viewer's
// «off» is remembered per lens (its silo), so a new lens starts on again
export function readLensOff(silo: string): boolean {
  return read(KEYS.lens) === `off:${silo}`
}
export function writeLensOff(silo: string, off: boolean): void {
  write(KEYS.lens, off ? `off:${silo}` : 'on')
}
