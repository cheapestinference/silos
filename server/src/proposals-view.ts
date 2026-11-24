// proposals-view.ts — a proposal as the owner reads it: the server computes every word, the web paints them, so
// Home's row, the sheet, the digest and the doorbell never disagree.
//
//   automation  the sheet shows the WHOLE content before the touch — name,
//               rhythm, maxRunsPerDay, the full prompt or run.command, runsOn
//               (S5) — and row and sheet say the REAL brake of the effective
//               provider (G2-product): one that prices «… — spends within
//               X's daily cap»; a subscription without a price «… — your
//               plan's limit is the brake (the usage line shows it)». An
//               agent without a fence: «it starts when X's territory is on»
//               (its runs are skipped until then). A proposal with a
//               PERIOD keeps the default budget and says, before the touch,
//               the pace its period asks: «≈ <n> runs a day, outside X's
//               daily max» (an agent never widens its pace with a distracted click).
//   skill       every file of proposed/<name> (name + size), each openable (S4)
//   mission     the current mission and the proposed one, whole (S6): the web
//               draws the diff and opens the mission editor preloaded
import type { AgentRegistry } from './agent-registry.js'
import type { AgentStateStore } from './agent-state.js'
import { argvLine, triggerWords } from './automation-words.js'
import { DEFAULT_MAX_RUNS_PER_DAY, type Trigger } from './automations-types.js'
import { AUTOMATION_PERIOD_RULES } from './automations-validate.js'
import { parsePeriod, slotsPerDay } from './period.js'
import type { ProvidersStore } from './providers-store.js'
import { unattendedPrices } from './platform-settings.js'
import { readOutsideWords, reviewOnly, type Proposal } from './proposals.js'
import { proposedSkillsDir, readSkillTree, skillChangeFiles, type SkillFile } from './skill-accept.js'
import { basename, join } from 'node:path'
import { foldersOf, knows, ofProject, seesAll } from './project-scope.js'

export interface ProposalViewDeps {
  registry: Pick<AgentRegistry, 'get'>
  providers?: Pick<ProvidersStore, 'resolve'>
  // the install's unattended provider (platform-settings.ts)
  unattendedProvider?: () => string | null
  territoryOn?: (agentId: string) => boolean
  agentState?: Pick<AgentStateStore, 'pathFor'>
}

export interface ProposalWords {
  /** what the row names: the automation's or the skill's name, or «a new mission» */
  title: string
  /** automation: «every hour · up to 24 runs a day — <the brake>» */
  brake?: string
  /** automation on an agent without a fence */
  territoryOff?: string
  /** automation with a period: «≈ <n> runs a day, outside X's daily max» */
  pace?: string
  /** the audit's mark */
  readOutside?: string
  /** (R6) where it crosses the proposer's projects, said first: «watches
   *  Builder's conversations in beta» — decided on its card, never by the
   *  one-tap accept */
  crosses?: string
  /** skill: the project whose skill it changes (absent: a new skill of the agent's) */
  skillOf?: string
}

export interface ProposalView extends Proposal {
  agentName: string
  /** only «Review ›» (+ Dismiss): every mission, an automation with a command */
  review: boolean
  words: ProposalWords
  automation?: {
    name: string
    when: string
    maxRunsPerDay: number
    prompt?: string
    command?: string
    cwd?: string
    runsOn?: { provider?: string; model?: string }
  }
  /** `folder`: a change to that project's skill — each file then says how it
   *  differs from the project's copy, and `removed` the files that go */
  skill?: { name: string; files: (SkillFile & { change?: 'new' | 'changed' | 'same' })[] | null; folder?: string; removed?: string[] }
  mission?: { before: { text: string; never: string[] } | null; after: { text: string; never: string[] } }
}

/** Whether the effective provider of an agent's unattended turns PRICES
 *  them (an API key: real money the spend cap can brake), or a subscription
 *  that does not — the runsOn, else the install's unattended switch,
 *  else the agent's own (platform-settings.ts unattendedPrices). */
export function providerPrices(d: Pick<ProposalViewDeps, 'registry' | 'providers' | 'unattendedProvider'>, agentId: string, runsOnProvider?: string): boolean {
  const agent = d.registry.get(agentId)
  if (!agent) return false
  return unattendedPrices(agent, {
    ...(runsOnProvider !== undefined ? { runsOnProvider } : {}),
    switchId: d.unattendedProvider?.() ?? null,
    providers: d.providers,
  })
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)

/** (R6) Where a proposed automation crosses its proposer's projects, by
 *  field — judged on the input alone with the one resolver
 *  (project-scope.ts): a `conversation` trigger on an agent it does not know
 *  (or an id that is nobody — the same mark, existence is not confirmed), a
 *  kept thread whose folder is not one of its projects. The `files` folder
 *  and the `path` watch never get here: the owner's create refuses them
 *  outside the agent's projects (routes/automations.ts). The http watch's
 *  address is the route's to judge (it resolves a name). */
export function automationCrossing(by: string, input: Record<string, unknown>, registry: Pick<AgentRegistry, 'get'>): string[] {
  if (seesAll(by)) return []
  const me = registry.get(by)
  const out: string[] = []
  const t = input.trigger as { kind?: unknown; sourceAgentId?: unknown } | null | undefined
  if (
    t &&
    typeof t === 'object' &&
    t.kind === 'conversation' &&
    typeof t.sourceAgentId === 'string' &&
    t.sourceAgentId !== by &&
    !knows(me, registry.get(t.sourceAgentId))
  )
    out.push('trigger.sourceAgentId')
  const th = input.thread as { mode?: unknown; folder?: unknown } | null | undefined
  if (th && typeof th === 'object' && th.mode === 'keep' && typeof th.folder === 'string' && !ofProject(me, th.folder)) out.push('thread.folder')
  return out
}

// the owner's words for each crossing field, first one first
function crossingWords(p: Proposal, d: ProposalViewDeps, name: string): string | undefined {
  const words = (p.crosses ?? [])
    .map((f) => {
      if (f === 'trigger.sourceAgentId') {
        const id = String((p.input.trigger as { sourceAgentId?: unknown } | undefined)?.sourceAgentId ?? '')
        const other = d.registry.get(id)
        return other
          ? `watches ${other.name}'s conversations in ${
              foldersOf(other)
                .map((x) => basename(x))
                .join(', ') || 'no project'
            }`
          : `watches the conversations of ${id}, no agent of ${name}'s projects`
      }
      if (f === 'thread.folder') return `runs in ${String((p.input.thread as { folder?: unknown } | undefined)?.folder ?? '')}, outside ${name}'s projects`
      if (f === 'trigger.check.url')
        return `fetches ${String((p.input.trigger as { check?: { url?: unknown } } | undefined)?.check?.url ?? '')}, an address that is not public`
      return null
    })
    .filter((x): x is string => x !== null)
  return words.length > 0 ? words.join('; ') : undefined
}

export function proposalWords(p: Proposal, d: ProposalViewDeps): ProposalWords {
  const name = d.registry.get(p.by)?.name ?? p.by
  const outside = readOutsideWords(p.readOutside)
  const base = outside ? { readOutside: outside } : {}
  if (p.kind === 'skill')
    return { title: str(p.input.name) ?? 'a skill', ...(str(p.input.folder) ? { skillOf: basename(p.input.folder as string) } : {}), ...base }
  if (p.kind === 'mission') return { title: 'a new mission', ...base }
  const input = p.input
  let when = ''
  try {
    when = input.trigger && typeof input.trigger === 'object' ? triggerWords(input.trigger as Trigger) : ''
  } catch {
    when = ''
  }
  const max = typeof input.maxRunsPerDay === 'number' && input.maxRunsPerDay > 0 ? input.maxRunsPerDay : DEFAULT_MAX_RUNS_PER_DAY
  const rhythm = `${when ? `${when} · ` : ''}up to ${max} run${max === 1 ? '' : 's'} a day`
  const runsOn = input.runsOn as { provider?: unknown } | undefined
  const command = (input.run as { kind?: unknown } | undefined)?.kind === 'command'
  // a command spends nothing on a provider: its brake is its runs a day
  const brake = command
    ? rhythm
    : providerPrices(d, p.by, str(runsOn?.provider))
      ? `${rhythm} — spends within ${name}'s daily cap`
      : `${rhythm} — your plan's limit is the brake (the usage line shows it)`
  const fenced = d.territoryOn ? d.territoryOn(p.by) : true
  const pace = periodPace(input.trigger, name)
  const crosses = crossingWords(p, d, name)
  return {
    ...(crosses ? { crosses } : {}),
    title: str(input.name) ?? 'an automation',
    brake,
    ...(pace ? { pace } : {}),
    ...(fenced ? {} : { territoryOff: `it starts when ${name}'s territory is on` }),
    ...base,
  }
}

// the pace a proposed period asks, said whole — the accept keeps the
// default budget, so the sheet says what the period would do on its own
function periodPace(trigger: unknown, agentName: string): string | null {
  const t = trigger as { kind?: unknown; period?: unknown } | null | undefined
  if (!t || typeof t !== 'object' || t.kind !== 'period') return null
  try {
    const n = slotsPerDay(parsePeriod(t.period, AUTOMATION_PERIOD_RULES))
    return `≈ ${n} run${n === 1 ? '' : 's'} a day, outside ${agentName}'s daily max`
  } catch {
    return null
  }
}

export function proposalView(p: Proposal, d: ProposalViewDeps): ProposalView {
  const agent = d.registry.get(p.by)
  const view: ProposalView = { ...p, agentName: agent?.name ?? p.by, review: reviewOnly(p), words: proposalWords(p, d) }
  if (p.kind === 'automation') {
    const i = p.input
    const run = i.run as { kind?: unknown; argv?: unknown; cwd?: unknown } | undefined
    const argv = run?.kind === 'command' && Array.isArray(run.argv) ? run.argv.filter((x): x is string => typeof x === 'string') : null
    let when = ''
    try {
      when = i.trigger && typeof i.trigger === 'object' ? triggerWords(i.trigger as Trigger) : ''
    } catch {
      when = ''
    }
    const runsOn = i.runsOn as { provider?: unknown; model?: unknown } | undefined
    view.automation = {
      name: str(i.name) ?? 'an automation',
      when,
      maxRunsPerDay: typeof i.maxRunsPerDay === 'number' && i.maxRunsPerDay > 0 ? i.maxRunsPerDay : DEFAULT_MAX_RUNS_PER_DAY,
      ...(typeof i.prompt === 'string' ? { prompt: i.prompt } : {}),
      ...(argv ? { command: argvLine(argv) } : {}),
      ...(argv && typeof run?.cwd === 'string' ? { cwd: run.cwd } : {}),
      ...(runsOn && typeof runsOn === 'object'
        ? {
            runsOn: {
              ...(str(runsOn.provider) ? { provider: runsOn.provider as string } : {}),
              ...(str(runsOn.model) ? { model: runsOn.model as string } : {}),
            },
          }
        : {}),
    }
  } else if (p.kind === 'skill') {
    const name = str(p.input.name) ?? ''
    let files: (SkillFile & { change?: 'new' | 'changed' | 'same' })[] | null = null
    const folder = str(p.input.folder)
    let removed: string[] | undefined
    if (d.agentState && name && folder && p.state === 'pending') {
      try {
        const c = skillChangeFiles(d.agentState.pathFor(p.by), name, folder)
        files = c ? c.files : null
        removed = c?.removed
      } catch {
        files = null
      }
    } else if (d.agentState && name && p.state === 'pending') {
      try {
        const r = readSkillTree(join(proposedSkillsDir(d.agentState.pathFor(p.by)), name), name)
        files = r.ok ? r.files : null
      } catch {
        files = null
      }
    }
    view.skill = { name, files, ...(folder ? { folder } : {}), ...(removed && removed.length > 0 ? { removed } : {}) }
  } else {
    const m = agent?.mission
    const before = m ? { text: m.text, never: [...m.never] } : null
    const text = typeof p.input.text === 'string' ? p.input.text : (before?.text ?? '')
    const never = Array.isArray(p.input.never) ? (p.input.never as string[]) : (before?.never ?? [])
    view.mission = { before, after: { text, never } }
  }
  return view
}
