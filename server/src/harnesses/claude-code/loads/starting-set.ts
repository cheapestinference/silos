// harnesses/claude-code/loads/starting-set.ts — Claude Code's starting set
// (spec tools-origin §8): the classes of what a new project loads that come
// from the Claude account, each with the ONE origin key the engine
// documents per folder, and Silos' recommendation by origin — the plugins
// and the connectors your Claude account sends off, the skills it sends on.
// What you set up on this machine is a class with no key of its own (the
// engine has no origin switch for it): Recommended on; off, the seam writes
// the per-item «off» entries the project's bulk click writes, for what
// exists at the birth (server/src/starting-set.ts, D6) — never ~/.claude.
//
// `apply` writes through the one writer (local-settings.ts), key by key,
// only where the folder's local file does not set the key already — a
// choice on disk wins. A class that stays on writes nothing (its key's
// absence is «on»). A home folder, a link out of the folder or a file it
// can't read throws (the writer's refusals): the seam says so as a warn.
import type { HarnessStartingSet, StartingSetClass } from '../../contract.js'
import { editLocalSettings } from '../local-settings.js'

const ACCOUNT = 'your Claude account'

export const CLAUDE_STARTING_CLASSES: readonly StartingSetClass[] = [
  { id: 'machine', what: 'what you set up on this machine', from: 'this machine', recommended: true, covers: 'machine' },
  { id: 'account-plugins', what: 'plugins', from: ACCOUNT, recommended: false, covers: 'plugin', origin: 'plugins' },
  { id: 'account-connectors', what: 'connectors', from: ACCOUNT, recommended: false, covers: 'connector', origin: 'connectors' },
  { id: 'account-skills', what: 'skills', from: ACCOUNT, recommended: true, covers: 'skill', origin: 'skills' },
]

/** Each class's key and the value that turns it off. */
const OFF: Readonly<Record<string, { key: string; value: boolean }>> = {
  'account-plugins': { key: 'syncClaudeAiPlugins', value: false },
  'account-connectors': { key: 'disableClaudeAiConnectors', value: true },
  'account-skills': { key: 'syncClaudeAiSkills', value: false },
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

export const claudeStartingSet: HarnessStartingSet = {
  classes: CLAUDE_STARTING_CLASSES,
  apply({ folder, home }, set) {
    const offs = CLAUDE_STARTING_CLASSES.filter((c) => OFF[c.id] !== undefined && (own(set, c.id) ? set[c.id] : c.recommended) === false).map((c) => OFF[c.id]!)
    if (offs.length === 0) return []
    const written: string[] = []
    editLocalSettings(folder, home, (s) => {
      for (const o of offs) {
        if (own(s, o.key)) continue // a choice already in the file is kept
        s[o.key] = o.value
        written.push(o.key)
      }
      return written.length > 0
    })
    return written
  },
}
