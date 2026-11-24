// transcript-only.ts — ONE rule for both engines (console route, chat-turn
// route, the task door): a session that someone other than the owner gave
// birth to is a transcript, never continued.
//  · an automation run: a --resume would make the run one of the owner's
//    threads (and spawn a claude nobody is driving);
//  · a nested run (births — an agent's own `claude -p`): likewise.
// The refusal names which, so the client goes read-only at once and names
// the automation / the conversation that ran it; null = continuable.
// Moved out of buildServer so index.ts can hand the same
// rule to the task machinery (task-threads.ts continuable). Types only.
import type { SessionMeta } from './types.js'
import type { SessionOriginsStore } from './session-origins.js'
import type { SessionOwners } from './session-owner.js'

export type TranscriptOnly = (meta: SessionMeta) => Record<string, unknown> | null

export function makeTranscriptOnly(o: {
  origins: Pick<SessionOriginsStore, 'automation'> | undefined | null
  owners: Pick<SessionOwners, 'nestedOf'>
}): TranscriptOnly {
  return (meta) => {
    // a MESSAGE conversation is not here: it stays continuable
    const born = o.origins?.automation(`${meta.folder}/${meta.id}`) ?? null
    if (born) return { error: 'an automation run — read its transcript', automationId: born.automationId, runId: born.runId }
    const nested = o.owners.nestedOf(meta)
    if (nested) return { error: 'nested run', nested: true, parent: nested.parent, agentId: nested.agentId }
    return null
  }
}
