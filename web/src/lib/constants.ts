// constants.ts — values shared between the store and the components.
// MASTER_ID is the system's only reserved id (the master agent seeded by
// the server, see agent-registry.ts): every place in `web/src` imports
// this literal from here, never declares its own local copy (there used
// to be 6 separate local declarations of the same string).
export const MASTER_ID = 'master'
// a UI alias for the master agent — the registry says "Master", but the
// whole interface presents it as "Anywhere" (the badge, ConversationHeader,
// AgentBand… and now the context column's Setup zone). Shared here so no
// surface ever shows two names for the same agent a header apart.
export const ANYWHERE_LABEL = 'Anywhere'
