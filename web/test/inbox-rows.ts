// inbox-rows.ts — server-shaped inbox rows for the web's tests. The inbox is
// composed by the server (server/src/inbox.ts, tested in server/test/
// inbox.test.ts); the web only scopes, hides and words these rows, so its
// tests build them the way GET /api/board returns them.
import type { InboxRow, Run, SiloNeedsYou } from '../src/lib/types'

type Of<K extends InboxRow['kind']> = Extract<InboxRow, { kind: K }>
const base = { voice: '', clears: '' }

export function askRow(
  o: { agentId?: string; folder?: string; id?: string; title?: string; at?: number; cwd?: string | null; permission?: Of<'ask'>['permission'] } = {},
): Of<'ask'> {
  const folder = o.folder ?? 'f'
  const id = o.id ?? 's1'
  return {
    ...base,
    kind: 'ask',
    key: `ask:${folder}\0${id}`,
    urgency: 'blocking',
    at: o.at ?? 0,
    agentId: o.agentId ?? 'a',
    folder,
    id,
    title: o.title ?? 'Q',
    cwd: o.cwd ?? null,
    ...(o.permission ? { permission: o.permission } : {}),
  }
}
export function escalatedRow(agentId: string, at: string, summary = 'help'): Of<'escalated'> {
  return {
    ...base,
    kind: 'escalated',
    key: `escalated:${agentId}`,
    urgency: 'blocking',
    at: Date.parse(at),
    agentId,
    item: { kind: 'escalated', agentId, summary, at },
    ack: { kind: 'escalated', key: agentId, version: at },
  }
}
export function messageRow(agentId: string, from: string, messageId: string, at: string, text = 'x'): Of<'message'> {
  return {
    ...base,
    kind: 'message',
    key: `message:${agentId}/${messageId}`,
    urgency: 'blocking',
    at: Date.parse(at),
    agentId,
    item: { kind: 'message', agentId, from, messageId, text, at },
  }
}
export function approvalRow(run: Run, automation: { id: string; name: string; agentId: string } | null): Of<'approval'> {
  return { ...base, kind: 'approval', key: `approval:${run.id}`, urgency: 'due', at: Date.parse(run.at), agentId: automation?.agentId ?? null, run, automation }
}
// a plan task of the owner's as the PLANS SILO sends it (server
// silos/surfaces.ts: a sub-kind row with its `parent` plan, `resolve` for
// Done / Drop) — routine unless said; `why` is what its row adds after the
// state («· unblocks 1 task of Writer»)
export function planRow(o: {
  folder: string
  file: string
  taskId: string
  title: string
  planTitle: string
  planUpdatedAt?: string | null
  urgency?: 'due' | 'routine'
  why?: string
}): Extract<InboxRow, { kind: 'silo' }> {
  const slug = o.file.replace(/\.plan\.json$/, '')
  const at = o.planUpdatedAt ?? ''
  return siloRow({
    kind: 'silo',
    reason: 'entry',
    silo: 'plans',
    siloName: 'Plans',
    key: `folder:${o.folder}/${slug}/tasks/${o.taskId}`,
    recordKind: 'plan/task',
    urgency: o.urgency ?? 'routine',
    text: `${o.title} — pending${o.why ?? ''}`,
    identity: o.title,
    at,
    folder: o.folder,
    file: `${o.folder}/plans/${o.file}`,
    entry: o.urgency === 'due' ? 0 : 1,
    actions: ['open', 'set-field', 'append-item'],
    parent: { key: `folder:${o.folder}/${slug}`, kind: 'plan', identity: o.planTitle, at },
    resolve: { field: 'status', done: 'done', note: 'notes' },
  })
}
// the Support silo's ONE summary row:
// folded due rows, counted per agent, said with the kind's noun
export function supportRow(byAgent: Record<string, number>, at: number): Of<'siloSummary'> {
  const count = Object.values(byAgent).reduce((a, b) => a + b, 0)
  return {
    ...base,
    kind: 'siloSummary',
    key: 'silo-summary:support',
    urgency: 'due',
    at,
    silo: 'support',
    siloName: 'Support',
    count,
    agentIds: Object.keys(byAgent),
    folders: [],
    noun: { one: 'support ticket', many: 'support tickets' },
    byAgent,
  }
}
export function siloRow(item: SiloNeedsYou): Of<'silo'> {
  return {
    ...base,
    kind: 'silo',
    key: `silo:${item.reason}:${item.silo}:${item.key}`,
    urgency: item.reason === 'conflict' ? 'blocking' : item.urgency,
    at: Date.parse(item.at) || 0,
    item,
  }
}
export function siloSummaryRow(
  silo: string,
  siloName: string,
  count: number,
  o: { agentIds?: string[]; folders?: string[]; at?: number } = {},
): Of<'siloSummary'> {
  return {
    ...base,
    kind: 'siloSummary',
    key: `silo-summary:${silo}`,
    urgency: 'due',
    at: o.at ?? 0,
    silo,
    siloName,
    count,
    agentIds: o.agentIds ?? [],
    folders: o.folders ?? [],
  }
}
export function failedRunRow(
  o: { agentId?: string; automationId?: string; name?: string; runId?: string; streak?: number; text?: string; at?: number } = {},
): Of<'failedRun'> {
  const agentId = o.agentId ?? 'builder'
  const id = o.automationId ?? 'sweep'
  const runId = o.runId ?? 'r1'
  return {
    ...base,
    kind: 'failedRun',
    key: `failed-run:${id}`,
    urgency: 'due',
    at: o.at ?? 0,
    agentId,
    automation: { id, name: o.name ?? 'Nightly sweep', agentId },
    runId,
    failure: { class: 'rejected', text: o.text ?? 'the API rejected the request (400)' },
    streak: o.streak ?? 1,
    ack: { kind: 'run', key: id, version: runId },
  }
}
export function missedRetryRow(o: { agentId?: string; dueAt: string; runId?: string }): Of<'missedRetry'> {
  const agentId = o.agentId ?? 'builder'
  return {
    ...base,
    kind: 'missedRetry',
    key: 'missed-retry:sweep',
    urgency: 'due',
    at: Date.parse(o.dueAt),
    agentId,
    automation: { id: 'sweep', name: 'Nightly sweep', agentId },
    runId: o.runId ?? 'r2',
    dueAt: o.dueAt,
    ack: { kind: 'run', key: 'sweep', version: o.runId ?? 'r2' },
  }
}
// an own agent whose territory turned off
export function territoryOffRow(agentId = 'builder', at = 0): Of<'territoryOff'> {
  return {
    ...base,
    kind: 'territoryOff',
    key: `territory-off:${agentId}`,
    urgency: 'due',
    at,
    agentId,
    voice: `${agentId.toUpperCase()}'s territory turned off — it is Only when told until it is on again ›`,
  }
}
// messages from one sender its recipient hasn't read
// past its next chance — the voice is the server's (inbox.ts unreadMessagesRow)
export function unreadMessagesRow(
  o: { agentId?: string; from?: string; messageIds?: string[]; why?: Of<'unreadMessages'>['why']; at?: number; voice?: string } = {},
): Of<'unreadMessages'> {
  const agentId = o.agentId ?? 'builder'
  const from = o.from ?? 'finance'
  const messageIds = o.messageIds ?? ['m1']
  const newest = messageIds[messageIds.length - 1]!
  return {
    ...base,
    kind: 'unreadMessages',
    key: `unread-messages:${agentId}/${from}`,
    urgency: 'due',
    at: o.at ?? 0,
    agentId,
    from,
    count: messageIds.length,
    messageIds,
    ...(o.why ? { why: o.why } : {}),
    voice: o.voice ?? `${agentId} hasn't read ${messageIds.length} message${messageIds.length === 1 ? '' : 's'} from ${from} · 1 d`,
    ack: { kind: 'message', key: `${agentId}/${from}`, version: newest },
  }
}
export function agentSummaryRow(agentId: string, count: number, runsOnly = true, newest = 'Auto 1 (the API rejected the request (400))'): Of<'agentSummary'> {
  return { ...base, kind: 'agentSummary', key: `agent-summary:${agentId}`, urgency: 'due', at: 0, agentId, count, newest, runsOnly }
}
export function accountLimitRow(
  o: { automations?: { id: string; name: string; agentId: string }[]; resetsAt?: string | null; at?: number; window?: boolean } = {},
): Of<'accountLimit'> {
  const automations = o.automations ?? [
    { id: 'fiscal', name: 'Tax watch', agentId: 'finance' },
    { id: 'tds', name: '3DS watch', agentId: 'builder' },
  ]
  const resetsAt = o.resetsAt === undefined ? '2026-10-20T05:00:00.000Z' : o.resetsAt
  return {
    ...base,
    kind: 'accountLimit',
    key: 'account-limit:default',
    urgency: 'due',
    at: o.at ?? 0,
    provider: 'default',
    account: 'Your Claude account',
    window: o.window === false ? null : { label: 'Fable', percent: 100, resetsAt },
    automations,
    agentIds: [...new Set(automations.map((a) => a.agentId))],
    ack: { kind: 'limit', key: 'default', version: resetsAt ?? 'r1' },
  }
}
export function proposalRow(o: Partial<Omit<Of<'proposal'>, 'kind'>> = {}): Of<'proposal'> {
  const proposalId = o.proposalId ?? '11111111-1111-1111-1111-111111111111'
  return {
    ...base,
    kind: 'proposal',
    key: `proposal:${proposalId}`,
    urgency: 'due',
    at: 0,
    agentId: 'builder',
    proposalId,
    proposalKind: 'automation',
    reason: 'the readings must stay fresh',
    review: false,
    inputHash: 'h'.repeat(64),
    title: 'Console readings',
    brake: "every 2h · up to 24 runs a day — spends within Builder's daily cap",
    ...o,
  }
}
