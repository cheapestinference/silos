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
import { proposedSkillsDir, readSkillTree, type SkillFile } from './skill-accept.js'
import { join } from 'node:path'

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
  skill?: { name: string; files: SkillFile[] | null }
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

export function proposalWords(p: Proposal, d: ProposalViewDeps): ProposalWords {
  const name = d.registry.get(p.by)?.name ?? p.by
  const outside = readOutsideWords(p.readOutside)
  const base = outside ? { readOutside: outside } : {}
  if (p.kind === 'skill') return { title: str(p.input.name) ?? 'a skill', ...base }
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
  return {
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
    let files: SkillFile[] | null = null
    if (d.agentState && name && p.state === 'pending') {
      try {
        const r = readSkillTree(join(proposedSkillsDir(d.agentState.pathFor(p.by)), name), name)
        files = r.ok ? r.files : null
      } catch {
        files = null
      }
    }
    view.skill = { name, files }
  } else {
    const m = agent?.mission
    const before = m ? { text: m.text, never: [...m.never] } : null
    const text = typeof p.input.text === 'string' ? p.input.text : (before?.text ?? '')
    const never = Array.isArray(p.input.never) ? (p.input.never as string[]) : (before?.never ?? [])
    view.mission = { before, after: { text, never } }
  }
  return view
}
