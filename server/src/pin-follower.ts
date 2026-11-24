// pin-follower.ts — a model picked INSIDE an engine's console is the
// owner's latest decision about the conversation, so it becomes the
// conversation's own pin (otherwise a model picked in the TUI is reverted
// to the previous one at the next relaunch). Without this the pin
// Silos holds wins at every relaunch and resume and pulls the conversation
// back. For an engine with traits.consolePinsModel (today OpenCode's TUI,
// /models).
//
// Source of truth: the reader's `requestedModel` — the last user message's
// model, in the engine's own id dialect; the engine says which pin it
// stands for (Harness.requestedModelPin; OpenCode: harnesses/opencode/pin.ts).
// Guard: only a pick NEWER than the pin's last write follows (a pin just
// set in the panel, not yet run, must not be reverted by an older message).
import type { SessionMeta } from './types.js'
import type { ProvidersStore } from './providers-store.js'
import type { ConversationPrefsStore } from './conversation-prefs.js'
import type { ConsolePin } from './harnesses/contract.js'
import { findHarness } from './harnesses/registry.js'

export type Pin = ConsolePin

const sameProvider = (a: string | null | undefined, b: string | null | undefined): boolean => (a ?? 'default') === (b ?? 'default')

export interface PinFollowerDeps {
  providers: Pick<ProvidersStore, 'list' | 'get'>
  convPrefs: Pick<ConversationPrefsStore, 'get' | 'patch' | 'writtenAt'>
  log?: (line: string) => void
}

export class TuiPinFollower {
  // the last requested model seen per conversation (memory): a pick is a
  // DECISION only when the TUI's model CHANGES between prompts — the same
  // model prompt after prompt is inertia, and inertia after a relaunch that
  // did not land must never revert the panel's pick (silos-f9)
  private readonly seen = new Map<string, string>()
  constructor(private readonly deps: PinFollowerDeps) {}

  /** returns the pin written, or null when nothing changed */
  onSession(meta: SessionMeta): Pin | null {
    const h = findHarness(meta.harness)
    if (!h?.traits.consolePinsModel || !h.requestedModelPin || !meta.requestedModel || meta.requestedModelAt === undefined) return null
    const key = `${meta.folder}/${meta.id}`
    const prev = this.seen.get(key)
    this.seen.set(key, meta.requestedModel)
    const wanted = h.requestedModelPin(meta.requestedModel, this.deps.providers)
    if (!wanted) return null
    const current = this.deps.convPrefs.get(meta.folder, meta.id)
    if (current && sameProvider(current.provider, wanted.provider) && (current.model ?? '') === wanted.model) return null
    const pinned = current !== null && (current.provider !== undefined || current.model !== undefined)
    // a pinned conversation follows the TUI only on a CHANGE of its model
    // (prev known and different); the first sighting after a start, or the
    // same model again, cannot be told from a relaunch that did not land
    if (pinned && (prev === undefined || prev === meta.requestedModel)) return null
    // a pin written after this prompt is the newer decision — keep it
    const writtenAt = this.deps.convPrefs.writtenAt(meta.folder, meta.id)
    if (writtenAt !== null && writtenAt >= meta.requestedModelAt) return null
    this.deps.convPrefs.patch(meta.folder, meta.id, { provider: wanted.provider, model: wanted.model })
    this.deps.log?.(`pin follows the console: ${meta.id} → ${wanted.provider ?? 'the engine’s own login'} / ${wanted.model}`)
    return wanted
  }
}
