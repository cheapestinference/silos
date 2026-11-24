// server-task-row.ts — a plans/plan/task record row as the server sends it
// (server silos/views.ts + task-flow.ts): the project's list says so
// (`parent.standingList`), the row carries the label it paints, the flow
// carries the conversations still current on it, and the state's word is
// the manifest's («dropped» for cancelled). Test factories wrap their bare
// rows with it, so the web is tested against what the server really says —
// the web holds no fallback for a server that says less.
import type { SiloRecordRow } from '../src/lib/types'

export function serverTaskRow(r: SiloRecordRow): SiloRecordRow {
  const parent = r.parent
  if (!parent) return r
  const planId = parent.key.slice(parent.key.lastIndexOf('/') + 1)
  const folder = typeof r.anchors.folder === 'string' ? r.anchors.folder : null
  const standing = parent.standingList === true || planId === 'tasks'
  const v = (r.value ?? {}) as Record<string, unknown>
  const convs = (Array.isArray(v.conversations) ? v.conversations : [])
    .map((c) => (c && typeof c === 'object' ? (c as { session?: unknown }).session : c))
    .filter((s): s is string => typeof s === 'string' && s !== '')
  const released = new Set<string>()
  for (const m of Array.isArray(v.releases) ? v.releases : []) {
    if (!m || typeof m !== 'object' || typeof (m as { session?: unknown }).session !== 'string') continue
    const s = (m as { session: string }).session
    if ((m as { released?: unknown }).released === true) released.add(s)
    else released.delete(s)
  }
  const flow = r.flow ?? { waiting: false, gate: false, unblocks: [], stalled: false, stalledCause: null, stalledBy: null }
  return {
    ...r,
    stateLabel: r.state === 'cancelled' ? 'dropped' : r.stateLabel || String(r.state ?? '').replace('_', ' '),
    parent: standing ? { ...parent, standingList: true } : parent,
    label: r.label ?? (standing && folder ? `${folder.split('/').filter(Boolean).pop()}#${r.id}` : `${planId}#${r.id}`),
    flow: flow.currentConversations ? flow : { ...flow, currentConversations: convs.filter((s) => !released.has(s)) },
  }
}
