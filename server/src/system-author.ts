// system-author.ts — the author Silos signs its OWN writes with: the
// escalation's recovery note and wait, task mode's reopen, cleared check,
// lost-note note and the conversations it links, the escalation's hop
// messages, the takeover note, the installer's
// events. Never the agent id `silos` — that is an agent.
//
// `Silos` can never be an agent id
// (agent ids are lowercase slugs — agent-registry.ts SLUG), and every screen
// that names an author by agent lookup falls back to the raw id, which reads
// «Silos».
export const SILOS_AUTHOR = 'Silos'
