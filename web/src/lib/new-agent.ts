// new-agent.ts — the words of an agent's birth, said once
// for Welcome and the New agent form. The form asks no decisions: a name,
// what it takes care of, where its files are (derived — change it if they
// live elsewhere); everything else is a default the page lets you change.
export const NEW_AGENT_ASK = 'Who do you want working for you?'
export const missionAsk = (name: string): string => `What will ${name || 'it'} take care of?`
export const missionHelp = (name: string): string =>
  `One or two sentences. Add “Never: …” for what it must always ask you first — a rule it follows; the real locks are what it can't touch, set later on its page. Leave it empty and ${name || 'it'} does only what you give it.`
export const FOLDER_ASK = 'Where are the files it works with?'
// the fence is a deny-list, never a confinement — never «can only open that folder»
export const keepsOut = (name: string): string => `${name || 'It'} keeps out of your keys, your settings and other agents' desks.`
export const derivedFolder = (id: string): string => `~/Silos/${id || '<name>'}`

// the first-run tour's steps (Welcome): each one says what the thing is, in
// one or two lines — the tour is these lines, nothing over the app
export const TOUR_STEPS = [
  { id: 'who', name: 'Who' },
  { id: 'engine', name: 'Engine' },
  { id: 'runs-on', name: 'Runs on' },
  // only for an engine that declares what a new project starts with (lib/first-run.ts tourSteps)
  { id: 'at-start', name: 'At start' },
  { id: 'silos', name: 'Silos' },
] as const
export type TourStep = (typeof TOUR_STEPS)[number]['id']
// what an agent is, said once under the first step's question
export const AGENT_IS = 'An agent is a name, a job and a folder — its project. It keeps its own conversations, files and tasks.'
export const ENGINE_ASK = 'What should it run on?'
export const ENGINE_ABOUT = 'Silos doesn’t replace your coding agent — it runs the one you choose, unmodified, on this machine.'
export const ENGINE_ONCE = 'Chosen once per agent. Your next agents can use another.'
// said on the first run's engine step: connecting the engine wires it
export const ENGINE_WIRES =
  'Connecting wires Claude Code to Silos — its inbox at start, the birth marker and the cron gate, two hooks in your ~/.claude/settings.json. One click removes them in Settings › Engines.'
export const RUNS_ON_ASK = 'Which plan pays for its work?'
export const RUNS_ON_ABOUT = 'A subscription you already have, or an API key. Each conversation can switch later from its Run on panel.'
export const atStartAsk = (name: string): string => `What should ${name || 'it'} start with?`
export const AT_START_ABOUT = 'What a new project loads before its first conversation. Each project changes it later, one switch at a time.'
export const AT_START_MACHINE = 'What you set up on this machine'
export const AT_START_LATER = 'For every project to come — Settings › Accounts & providers changes it later.'
export const SILOS_ASK = 'What should Silos keep track of?'
export const SILOS_ABOUT =
  'Silos is built of silos — each one a way of working you can add or remove. The recommended ones come installed; the rest are one click away.'
export const SILOS_INCLUDED = 'Included'
export const SILOS_ADD = 'Add if you like'
export const SILOS_LATER =
  'Support needs an agent of its own to read your mailbox — install it from Settings › Silos once you have one. Everything here can change there later.'

// how it works — asked at birth (lib/first-run.ts Works), in Welcome and
// the New agent form alike
export const worksAsk = (name: string): string => `How does ${name || 'it'} work?`
export const WORKS_TOLD = {
  title: 'When you give it work',
  note: 'It does what you ask, nothing more. A mission is optional — every conversation starts with it: what it looks after and what it must ask you first.',
}
export const WORKS_OWN = {
  title: 'Also on its own',
  note: 'Once a week it wakes, looks after its mission and acts or asks you. It needs a mission; the rhythm changes on its page.',
}
// the ladder's third rung, named at birth so it is known — chosen later,
// on the agent's page, in its own sheet
export const WORKS_LATER = 'Later, on its page, you can also make it look for work on its own — Proactive.'
export const missionAskFor = (name: string, works: 'told' | 'own'): string => (works === 'own' ? missionAsk(name) : `${missionAsk(name)} (optional)`)
