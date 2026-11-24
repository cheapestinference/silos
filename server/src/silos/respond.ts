// silos/respond.ts — ONE gesture for a gate of the owner's that agents wait
// on: the gate closes with the owner's Done FIRST
// (taskGesture 'done', judged on the state the owner saw —
// done, and its wait and next check cleared, in one write), THEN the
// text lands as an owner note on EACH open agent task that depends on it
// directly — with the gate closed nothing holds a waiter any more, so the
// note's own write reopens it (D17, J10.10). No new schema; the notes are
// append-item's.
//
// A note that fails after the close leaves the gate done: the answer says
// `closed: true` and which waiters `missing` it, and respond can be sent again
// over the done gate (its Done answers `already`) — it writes only the notes
// that are missing (a waiter whose notes hold the owner's same words already
// is not written twice).
//
// Owner-only by design (the routes' agent allow-list never names it): an
// agent answering a gate would be approving its own wait. And the gate must
// be a PERSON's — this gesture never closes an agent's task.
import type { SiloActions } from './actions.js'
import type { SiloRecord } from './reader.js'
import { flowOf, kindsOf, recordsOfKind, type KindRecord, type Voice } from './voice.js'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

export type RespondResult =
  | { ok: true; value: SiloRecord & { nowReady?: unknown; already?: boolean }; notified: Array<{ key: string; owner: string }> }
  | { ok: false; code: number; reason: string; notified: Array<{ key: string; owner: string }>; closed?: true; missing?: string[] }

export function respondToGate(i: {
  siloId: string
  manifest: Json
  // the kernel's current records of the silo (kernel.reading)
  base: KindRecord[]
  key: string
  text: string
  // the gate's state as the owner saw it (F4): its Done is judged on it
  state: string | null
  actions: Pick<SiloActions, 'appendItem' | 'taskGesture'>
  voice: Voice
  isAgent: (id: string) => boolean
}): RespondResult {
  const no = (code: number, reason: string, notified: Array<{ key: string; owner: string }> = []): RespondResult => ({ ok: false, code, reason, notified })
  const kinds = kindsOf(i.manifest)
  const info = [...kinds.values()].find((k) => k.dict.task)
  if (!info) return no(400, `${i.siloId} has no kind with roles.task — nothing waits on a task here`)
  const all = recordsOfKind(kinds, i.base, info.name)
  const rec = all.find((r) => r.key === i.key)
  if (!rec) return no(404, `no record ${i.key} in ${i.siloId}`)
  const ownerField = info.dict.task!.owner
  const owner = typeof rec.rec[ownerField] === 'string' ? (rec.rec[ownerField] as string) : ''
  if (i.isAgent(owner)) return no(409, `${i.key} is ${owner}'s task — a person answers their own gate; to nudge ${owner}, add a note on ITS task`)
  // where an answer lands: the appendOnly sub-kind the manifest lets the
  // owner append to (plans: notes) — the same lookup the Done chip uses
  const declared = (Array.isArray((i.manifest.spec as Json)?.actions) ? ((i.manifest.spec as Json).actions as unknown[]) : []).filter(isObj)
  const append = declared.find(
    (a) =>
      a.verb === 'append-item' &&
      typeof a.subKind === 'string' &&
      kinds.get(a.subKind)?.parent === info &&
      (Array.isArray(a.by) ? a.by.includes('owner') : a.by === 'owner'),
  )
  const noteColl = append && typeof append.subKind === 'string' ? kinds.get(append.subKind)?.coll : undefined
  if (!noteColl) return no(400, `${info.name} has no owner-writable notes — nothing to answer with`)
  const flow = flowOf(info, rec, i.voice)
  const unblocks = flow?.unblocks ?? []
  if (unblocks.length === 0) return no(409, 'nothing waits on this task directly — answer with Done, or write on the waiting task itself')
  const planKey = i.key.replace(new RegExp(`/${info.coll}/[^/]+$`), '')
  // (J10.10, K7) the gate first: ONE write, judged on what the owner saw
  const done = i.actions.taskGesture(i.siloId, i.key, 'done', i.state !== null ? { state: i.state } : {})
  if (!done.ok) return no(done.code, done.reason)
  const notified: Array<{ key: string; owner: string }> = []
  const missing: string[] = []
  const words = i.text.trim()
  let why = ''
  for (const u of unblocks) {
    const uKey = `${planKey}/${info.coll}/${u.id}`
    // already there (a repeat over a done gate): never twice
    const waiter = all.find((r) => r.key === uKey)
    const notes = waiter && Array.isArray(waiter.rec[noteColl]) ? (waiter.rec[noteColl] as unknown[]).filter(isObj) : []
    if (notes.some((n) => n.by === 'owner' && typeof n.text === 'string' && n.text.trim() === words)) {
      notified.push({ key: uKey, owner: u.owner })
      continue
    }
    const r = i.actions.appendItem(i.siloId, uKey, noteColl, { text: i.text })
    if (!r.ok) {
      missing.push(uKey)
      why = why || r.reason
      continue
    }
    notified.push({ key: uKey, owner: u.owner })
  }
  if (missing.length > 0) {
    return {
      ok: false,
      code: 409,
      reason: `the gate is done, but the answer did not land on ${missing.length === 1 ? 'one task' : `${missing.length} tasks`} waiting on it: ${why} — answer again to write ${missing.length === 1 ? 'it' : 'them'}`,
      notified,
      closed: true,
      missing,
    }
  }
  return { ok: true, value: done.value as SiloRecord & { nowReady?: unknown; already?: boolean }, notified }
}
