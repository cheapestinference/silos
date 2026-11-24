// new-agent.ts — the words of an agent's birth, said once
// for Welcome and the New agent form (both draw lib/birth.ts through
// components/new-agent/BirthFields.tsx). A birth asks only its project, a
// name, how it works, its mission and — when this machine can run more
// than one — its engine; everything else is chosen later on its page or
// per conversation.
export const NEW_AGENT_ASK = 'Who do you want working for you?'
export const missionAsk = (name: string): string => `What will ${name || 'it'} take care of?`
export const missionHelp = (name: string): string =>
  `One or two sentences. Add “Never: …” for what it must always ask you first — a rule it follows; the real locks are what it can't touch, set later on its page. Leave it empty and ${name || 'it'} does only what you give it.`
// its project: one Silos knows, or a new one — never a path
export const PROJECT_ASK = 'Project'
export const PROJECT_NEW = 'A new project'
export const PROJECT_NAME_LABEL = 'The new project’s name'
export const PROJECT_GIVEN = 'the folder you just picked'
export const projectNewNote = (slug: string): string =>
  `A new folder, ${derivedFolder(slug)} — the agent works in it, and so will the agents you add to this project.`
// a project is a boundary: joining one means knowing who is there
export const projectJoinNote = (others: readonly string[]): string =>
  others.length > 0 ? `It joins ${others.join(', ')} there — they know each other.` : 'It works in that project’s folder.'
export const projectNameEmpty = 'The project needs a name — letters or digits.'
export const projectClash = (name: string): string => `A project called ${name} exists — pick it from the list, or name the new one differently.`
export const ENGINE_FIELD = 'Engine'
// the fence is a deny-list, never a confinement — never «can only open that folder»
export const keepsOut = (name: string): string => `${name || 'It'} keeps out of your keys, your settings and other agents' desks.`
export const derivedFolder = (id: string): string => `~/Silos/${id || '<name>'}`

// the first-run tour's steps (Welcome): each one says what the thing is, in
// one or two lines — the tour is these lines, nothing over the app
export const TOUR_STEPS = [
  { id: 'project', name: 'Project' },
  { id: 'who', name: 'Who' },
  // only when this machine can run more than one engine (lib/first-run.ts tourSteps)
  { id: 'engine', name: 'Engine' },
  { id: 'runs-on', name: 'Runs on' },
  // only for an engine that declares what a new project starts with (lib/first-run.ts tourSteps)
  { id: 'at-start', name: 'At start' },
  { id: 'silos', name: 'Silos' },
] as const
export type TourStep = (typeof TOUR_STEPS)[number]['id']
// the first step: its project, and what a project is
export const PROJECT_STEP_ASK = 'What are you working on?'
export const PROJECT_IS = 'A project is a folder. Its agents work in it, and it is the edge of what they know.'
// what an agent is, said once under the Who step's question
export const AGENT_IS = 'An agent is a name and a job, in that project. It keeps its own conversations, files and tasks.'
export const ENGINE_ASK = 'What should it run on?'
export const ENGINE_ABOUT = 'Silos doesn’t replace your coding agent — it runs the one you choose, unmodified, on this machine.'
export const ENGINE_ONCE = 'Chosen once per agent. Your next agents can use another.'
// said on the first run's engine step: Create connects the engine to
// Silos — what that writes is Settings › Engines' to say, never the tour's
export const ENGINE_CONNECTS = 'Silos connects to it when you create — Settings › Engines shows how, and undoes it.'
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
// the ladder's third rung: born with Silos' default limits (a round every
// 3 hours by day, up to 5 tasks a day), changed on its page
export const WORKS_PROACTIVE = {
  title: 'Proactive',
  note: 'On its own, and it looks for work: every few hours it checks what its mission covers, creates the tasks it finds and starts them — within Silos’ default limits, changed on its page. It needs a mission.',
}
export const missionAskFor = (name: string, works: 'told' | 'own' | 'proactive'): string =>
  works === 'told' ? `${missionAsk(name)} (optional)` : missionAsk(name)
