// territory.ts — every folder an agent works in: [folder, ...folders],
// absolute only, trailing slashes stripped (never `/` itself), deduplicated,
// primary first. Mirror of server/src/territory.ts territoriesOf — a
// declared folder makes the agent a member of that project.
import type { AgentView } from './types'

const strip = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p)

export function territoriesOf(agent: Pick<AgentView, 'folder' | 'folders'>): string[] {
  const out: string[] = []
  for (const p of [agent.folder, ...(agent.folders ?? [])]) {
    if (typeof p !== 'string' || !p.startsWith('/')) continue
    const t = strip(p)
    if (!out.includes(t)) out.push(t)
  }
  return out
}

// Where an agent's territory is turned on or off: its own Settings, on the
// Runs on card (doors used to say «Settings › Runs on», a page that
// only showed it; the switch was a page away, on the roster). The roster —
// Settings › Territory — stays the fleet's view of the three surfaces. Every
// door that names an agent's territory says these words.
export const TERRITORY_DOOR_WORDS = 'Turn it on in its Settings ›'
