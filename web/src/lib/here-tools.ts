// here-tools.ts — the words of a conversation's own line in «Where it
// loads» (spec scope-ui-review §4.3): when its entry takes effect, said on
// the line of its agent's page opened from it. Pure: the server answered
// where the entry stands (the line's `here`); this only words it.
import type { LoadsLine } from './types'

/** How the conversation starts its next process — what «when» it says. */
export type HereMode = 'chat' | 'console-running' | 'console' | 'run'

/** When the conversation's own entry takes effect. `restart`: its console
 *  runs now — the entry waits for it to be reopened. */
export function whenWords(line: LoadsLine, mode: HereMode): { text: string; amber?: true; restart?: true } | null {
  if (line.entry === undefined) return null
  const on = line.entry === 'on'
  const what = on ? 'on' : 'off'
  const state = line.here?.state ?? 'pending'
  if (state === 'in-effect') return { text: on ? 'on only in this conversation' : 'off in this conversation' }
  if (state === 'didnt-take')
    return on ? { text: 'didn’t load — its own “on” didn’t take', amber: true } : { text: 'still loaded — the switch didn’t take', amber: true }
  return { text: `${what} ${startWords(mode)}`, ...(mode === 'console-running' ? { restart: true as const } : {}) }
}

/** When the conversation's own position for a skill takes effect — a
 *  skill cannot be proven (no reading lists skills): from its next start. */
export function skillWhenWords(entry: string | undefined, mode: HereMode): { text: string; restart?: true } | null {
  if (entry === undefined) return null
  const what = entry === 'off' ? 'off' : entry === 'name-only' ? 'name only' : 'on'
  return { text: `${what} ${startWords(mode)}`, ...(mode === 'console-running' ? { restart: true as const } : {}) }
}

function startWords(mode: HereMode): string {
  if (mode === 'console-running' || mode === 'console') return 'when this console is reopened'
  if (mode === 'run') return 'from its next run'
  return 'from its next message'
}
