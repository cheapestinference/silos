// owners.ts — the ONE vocabulary of whose a thing is (the owner must always
// know what they are looking at). Every thing on screen belongs to exactly one
// owner, and an owner is always written with its type word first — a bare
// name or path is never shown («silos» meant four things at once). Bars,
// filters, group headers, item lines and page headers all read from here;
// `OwnerLabel` is the one component that renders it. No symbol stands for an
// owner (owner 24-11): the words carry it, an agent's own emoji inside its
// label, and a bar's tone key beside it. Pure.

export type Owner = 'conversation' | 'agent' | 'project' | 'silos' | 'you' | 'account' | 'engine'

/** display order everywhere: the subject first, the furthest inheritance last */
export const OWNER_ORDER: Owner[] = ['conversation', 'agent', 'project', 'silos', 'you', 'account', 'engine']

/** the type word — what kind of owner this is, said before any name. ONE
 *  label per thing, the same on both axes: an origin is «From» + the label,
 *  a place is the label alone (spec scope-ui-review §3.1). */
export const OWNER_TYPE: Record<Owner, string> = {
  conversation: 'Conversation',
  agent: 'Agent',
  project: 'Project',
  silos: 'Silos platform',
  you: 'This machine',
  account: 'Your Claude account',
  engine: 'Claude Code',
}

/** where each owner's things are changed — its one house (null: nowhere in Silos) */
export const OWNER_HOUSE: Record<Owner, string | null> = {
  conversation: 'its agent’s page, opened from it',
  agent: 'its page',
  project: 'the project page',
  silos: null,
  you: 'Settings',
  account: null, // claude.ai, outside Silos
  engine: null, // not managed
}

/** what names an owner beyond its type: the agent, the folder, the account */
export interface OwnerContext {
  agentName?: string
  agentEmoji?: string
  /** the project folder (a path); its basename is the name */
  folder?: string | null
  accountName?: string
  /** the conversation's title: «Conversation · Fix the importer» */
  conversationTitle?: string
  /** off a conversation (the agent's At start), the «conversation» part is
   *  just its first message — said so, never «This conversation» */
  offConversation?: boolean
}

/** the type word, in context (a conversation with no title known: «This conversation») */
export function ownerType(owner: Owner, ctx: OwnerContext = {}): string {
  if (owner === 'conversation') return ctx.offConversation ? 'First message' : ctx.conversationTitle ? OWNER_TYPE.conversation : 'This conversation'
  return OWNER_TYPE[owner]
}

const basename = (p: string): string => p.replace(/\/+$/, '').slice(p.replace(/\/+$/, '').lastIndexOf('/') + 1) || p

/** the name after the type word, or null for owners that are one of a kind */
export function ownerName(owner: Owner, ctx: OwnerContext = {}): string | null {
  if (owner === 'agent') return ctx.agentName ?? null
  if (owner === 'project') return ctx.folder ? basename(ctx.folder) : null
  if (owner === 'account') return ctx.accountName ?? null
  if (owner === 'conversation' && !ctx.offConversation) return ctx.conversationTitle ?? null
  return null
}

/** the label as plain text, the spec's words: «Agent · 🛠 Builder»,
 *  «Project · acme», «This machine», «Your Claude account · sam@example.com»,
 *  «Conversation · Fix the importer» */
export function ownerText(owner: Owner, ctx: OwnerContext = {}): string {
  const name = ownerName(owner, ctx)
  if (!name) return ownerType(owner, ctx)
  const face = owner === 'agent' && ctx.agentEmoji ? `${ctx.agentEmoji} ` : ''
  return `${OWNER_TYPE[owner]} · ${face}${name}`
}

/** WHERE a thing comes from: the lead word «From» + the owner's label,
 *  exactly as written — never a second set of origin phrases to keep in
 *  step (owner 24-11). «Where it loads» names a place by the bare label. */
export const ORIGIN_LEAD = 'From'

/** the origin as plain text: «From Your Claude account · sam@example.com» */
export function ownerOriginText(owner: Owner, ctx: OwnerContext = {}): string {
  return `${ORIGIN_LEAD} ${ownerText(owner, ctx)}`
}

// one luminance step per owner, the page's own the darkest: what the page is
// about reads strongest, what it inherits recedes (Tailwind needs the
// literal class strings). Only a BAR's key uses it (At start, Context size).
const TONES = ['bg-ink/85', 'bg-ink/60', 'bg-ink/42', 'bg-ink/30', 'bg-ink/20', 'bg-ink/14', 'bg-ink/9'] as const

/** the bar tone of an owner on a page whose own owner is `own` */
export function ownerTone(owner: Owner, own: Owner = 'conversation'): string {
  const step = Math.max(0, OWNER_ORDER.indexOf(owner) - OWNER_ORDER.indexOf(own))
  return TONES[Math.min(step, TONES.length - 1)]!
}

/** sort helper: by display order */
export const byOwnerOrder = (a: Owner, b: Owner): number => OWNER_ORDER.indexOf(a) - OWNER_ORDER.indexOf(b)
