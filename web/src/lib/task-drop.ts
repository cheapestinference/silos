// task-drop.ts — the owner's Drop on a Home row of a silo whose kind is NOT
// a task (no roles.task — a Plans task is the owner's
// verb, lib/task-gesture.ts act): the «Dropped: <why>» note, then
// the state to the kind's drop state (plans: cancelled — finished, and it
// resolves no dependency). Two writes, so a retry must not write the note
// twice: when THIS tab wrote the note and the state write
// then lost a race, and the record's LAST note is still that note, only the
// state is written again. A Drop whose state landed is over — a later Drop
// with the same words (Drop → Reopen → Drop) is a new Drop and leaves its own
// note. Each write carries the CAS version of the read
// before it; a 409 throws, and the caller says «try once more».
import { api } from './api'

export interface DropApi {
  record(silo: string, key: string): Promise<{ version: string | null; value?: Record<string, unknown> }>
  append(silo: string, body: { key: string; collection: string; values: Record<string, string>; version?: string }): Promise<unknown>
  setField(
    silo: string,
    body: { key: string; field: string; value: unknown; version?: string },
  ): Promise<{ nowReady?: Array<{ key: string; id: string; identity: string; owner: string; wakes?: 'task' | 'never' }> }>
}

const defaultApi: DropApi = { record: (s, k) => api.silos.record(s, k), append: (s, b) => api.silos.append(s, b), setField: (s, b) => api.silos.setField(s, b) }

// the one default when the owner gives no reason — Home and the page alike
export const DROP_DEFAULT_REASON = 'by the owner'

export function dropNoteText(reason: string): string {
  return `Dropped: ${reason.trim() || DROP_DEFAULT_REASON}`
}

const lastNoteText = (value: Record<string, unknown> | undefined, coll: string): string | null => {
  const notes = Array.isArray(value?.[coll]) ? (value![coll] as unknown[]) : []
  const last = notes[notes.length - 1]
  if (typeof last === 'string') return last
  return last && typeof last === 'object' && typeof (last as { text?: unknown }).text === 'string' ? (last as { text: string }).text : null
}

// `how`: the row's resolve (field, the drop state, the notes collection).
// `seen`: the version the owner was looking at — the note is written against
// it, so a plan someone changed meanwhile answers 409 and nothing is written.
export async function dropTask(
  silo: string,
  key: string,
  reason: string,
  how: { field: string; value: string; note?: string | undefined },
  seen: string | null = null,
  deps: DropApi = defaultApi,
): ReturnType<DropApi['setField']> {
  const text = dropNoteText(reason)
  const id = `${silo}\u0000${key}`
  let version = seen
  if (how.note) {
    const before = await deps.record(silo, key)
    if (unfinished.get(id) === text && lastNoteText(before.value, how.note) === text) version = before.version
    else {
      await deps.append(silo, { key, collection: how.note, values: { text }, ...((seen ?? before.version) ? { version: (seen ?? before.version)! } : {}) })
      unfinished.set(id, text)
      version = (await deps.record(silo, key)).version
    }
  }
  const r = await deps.setField(silo, { key, field: how.field, value: how.value, ...(version ? { version } : {}) })
  unfinished.delete(id)
  return r
}

// the Drops whose note this tab wrote and whose state has not landed yet
const unfinished = new Map<string, string>()
