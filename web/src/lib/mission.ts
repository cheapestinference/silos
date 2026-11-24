// mission.ts — the mission on screen (server twin: server/src/mission.ts).
// ONE split rule, the same code in the
// create dialog and in the mission editor: the text is cut by lines; every
// line that STARTS (after trim, any case) with «Never:» goes to `never`
// without the prefix; the rest, in order, is the mission text. A «Never:»
// mid-sentence cuts nothing.
import type { AgentView, MissionInput } from './types'

export const MISSION_TEXT_MAX = 2000
export const MISSION_NEVER_MAX_LINES = 10
export const MISSION_NEVER_LINE_MAX = 200

const NEVER_PREFIX = /^never:\s*/i

export function splitMission(raw: string): MissionInput {
  const never: string[] = []
  const text: string[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (NEVER_PREFIX.test(t)) {
      const rule = t.replace(NEVER_PREFIX, '').trim()
      if (rule) never.push(rule)
    } else {
      text.push(line)
    }
  }
  return { text: text.join('\n').trim(), never }
}

// the editor's two fields → one mission: a «Never:» line written in the text
// field moves to the rules (the same split), then the rules field's lines
export function missionFromFields(text: string, neverField: string): MissionInput {
  const fromText = splitMission(text)
  const rules = neverField
    .split('\n')
    .map((l) => l.trim().replace(NEVER_PREFIX, '').trim())
    .filter(Boolean)
  return { text: fromText.text, never: [...fromText.never, ...rules] }
}

// what the server would refuse, said before sending — in the words of the
// field the person is looking at (never the API's field names)
export function missionProblem(m: MissionInput, name: string): string | null {
  if (m.text === '') return m.never.length > 0 ? `Write what ${name} takes care of — “Never” lines alone aren't a mission yet` : null
  if (m.text.length > MISSION_TEXT_MAX) return `Keep it under ${MISSION_TEXT_MAX} characters — it is ${m.text.length} now`
  if (m.never.length > MISSION_NEVER_MAX_LINES) return `Up to ${MISSION_NEVER_MAX_LINES} “Never” lines — there are ${m.never.length}`
  const long = m.never.find((l) => l.length > MISSION_NEVER_LINE_MAX)
  if (long) return `Each “Never” line fits in ${MISSION_NEVER_LINE_MAX} characters — “${long.slice(0, 40)}…” is longer`
  return null
}

// the first sentence, whitespace collapsed — the regex of the server's
// firstSentence (and of the fleet roster), so every surface says the same line
export function firstSentence(text: string): string {
  const s = text.split(/\s+/).filter(Boolean).join(' ')
  const m = /^(.+?[.!?])(?=\s|$)/.exec(s)
  return m ? m[1]! : s
}

// an agent's one line wherever a name needs a second line ('' without a mission)
export function missionLine(agent: Pick<AgentView, 'mission'> | null | undefined): string {
  return agent?.mission?.text ? firstSentence(agent.mission.text) : ''
}
