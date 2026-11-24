// memory-rows.ts — every instruction file Memory shows (GET /api/memory
// `rows`, spec memory-places §3), said in the scope review's words: the
// group head is the ORIGIN («From …» — this module gives its owner and the
// qualifier in the owner's name slot), the muted phrase on the row is WHOM
// IT REACHES by default, the weight as last loaded («on disk» until a start
// names it). Pure: the server supplied origin, reach, when and weight.
import type { MemoryRow } from './types'
import type { Owner } from './owners'

/** The engine's own size warning for one file (characters). */
export const FILE_WARN_CHARS = 40_000

/** Whose a row is: the origin's owner on the heads. */
export function memoryOwner(r: Pick<MemoryRow, 'origin'>): Owner {
  if (r.origin === 'agent') return 'agent'
  if (r.origin === 'project' || r.origin === 'private' || r.origin === 'auto') return 'project'
  return 'you'
}

/** The head's qualifier where one owner makes two groups (§3): a folder
 *  above, the private file, auto memory. */
export function memoryQualifier(r: Pick<MemoryRow, 'origin'>): string | null {
  if (r.origin === 'above') return 'a folder above'
  if (r.origin === 'private') return 'private to you'
  if (r.origin === 'auto') return 'auto memory'
  return null
}

/** The qualifiers' order inside one owner: the engine's load order. */
export const QUALIFIER_ORDER = ['', 'a folder above', 'private to you', 'auto memory']

const tail = (p: string): string => p.replace(/\/+$/, '').split('/').slice(-2).join('/')

/** Whom the row reaches by default (§3's column), and when it loads. */
export function memoryReachWords(r: MemoryRow, agentName: string): string {
  const parts: string[] = []
  switch (r.reach.scope) {
    case 'organization':
      parts.push('set by your organization · every Claude Code here · always loaded')
      break
    case 'machine':
      parts.push('every project on this machine')
      break
    case 'under':
      parts.push(`every project under ${r.reach.under ?? 'a folder above'}`)
      break
    case 'agent':
      parts.push(`only ${agentName} · every conversation Silos starts for it`)
      break
    default:
      if (r.kind === 'import') parts.push(`with ${r.importedBy ?? 'the file that imports it'}`)
      else if (r.kind === 'auto-index') parts.push('every agent here reads and writes it')
      else if (r.kind === 'auto-note') parts.push(r.inIndex === false ? 'opened when needed · not in the index' : 'opened when needed')
      else parts.push('every agent here')
  }
  if (r.kind === 'agents') parts.push(r.through === 'alone' ? 'in place of a CLAUDE.md' : 'through CLAUDE.md')
  if (r.kind === 'private') parts.push('the conversations you open — not wakes or isolated runs')
  if (r.when.at === 'on-demand' && r.when.under) parts.push(`when it works under ${r.when.under}/`)
  if (r.reach.paths) parts.push(`only for files matching ${r.reach.paths}`)
  for (const d of r.reach.notOn ?? []) parts.push(`not on the login at ${tail(d)}`)
  return parts.join(' · ')
}

/** ≈ tokens as last loaded, else on disk; amber over the engine's warning. */
export function memoryWeightWords(r: MemoryRow): { text: string; amber: boolean } {
  const tokens = r.weight.tokens
  const n = tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens)
  return { text: `≈ ${n} tokens${r.weight.as === 'disk' ? ' on disk' : ''}`, amber: r.weight.chars > FILE_WARN_CHARS }
}

/** What Save says it reaches (§5): the machine's files ask first. */
export function saveWords(r: Pick<MemoryRow, 'reach' | 'confirm'>, agentName: string): string {
  if (r.confirm || r.reach.scope === 'machine') return 'Save — for every project on this machine'
  if (r.reach.scope === 'agent') return `Save — for ${agentName} only`
  if (r.reach.scope === 'project') return 'Save — for every agent here'
  return 'Save'
}
