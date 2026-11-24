// needs-you-acks.ts — the owner's "Seen" on a kernel needs-you row,
// persisted in ~/.silos/needs-you-acks.json:
//   { escalated: { [agentId]: <at of the status the owner acknowledged> },
//     run:       { [automationId]: <id of the run the owner saw> },
//     mission:   { [agentId]: <the local day the owner saw it stalled> },
//     message:   { [<recipient>/<sender>]: <the newest unread messageId seen> } }
// Seen means one thing everywhere: «I know about THIS
// version; don't show it again until it changes». Each map is key → the
// version the owner saw; a row whose version differs (a newer escalation, a
// new failed run, another day) shows again on its own. Resolved is a
// different thing — the signal is gone, and only the source can do that.
//
// The file written before the other kinds existed ({ escalated } alone)
// reads as it always did. `limit: { [account]: <the window's reset> }` is
// the Seen of a usage-limit episode (inbox.ts accountLimitRows).
// `digest: { home: <newest digest date seen> }` is
// the Home band's Seen (digest-job.ts) — the same «this version» rule.
// `tasksStalled: { tasks: <the stalled keys, sorted> }` the Seen
// of «N tasks stalled — nobody is moving them» for that set;
// `ownTurns: { [agentId]: <the local day> }` an agent's own turns at its
// ceiling that day (inbox.ts tasksStalledRow, ownTurnsCeilingRow).
// (A2.8) `consoleIdle: { [session]: <the oldest heldSince> }`
// the Seen of «X's console on «title» is open and idle» for that hold.
// Same store discipline as seen-store.ts: tolerant
// loading, atomic write, a .corrupt-<stamp> backup before starting fresh.
// No sweep: one entry per key at most, a stale one is harmless (it matches
// nothing).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, backupCorruptJson } from './json-store.js'

export const ACK_KINDS = ['escalated', 'run', 'cut', 'message', 'digest', 'limit', 'tasksStalled', 'ownTurns', 'audit', 'spend', 'consoleIdle'] as const
export type AckKind = (typeof ACK_KINDS)[number]

export function isAckKind(v: unknown): v is AckKind {
  return typeof v === 'string' && (ACK_KINDS as readonly string[]).includes(v)
}

export interface EscalationAcks {
  escalatedAckedAt(agentId: string): string | null
}

export class NeedsYouAcksStore implements EscalationAcks {
  private maps: Record<AckKind, Record<string, string>> = {
    escalated: {},
    run: {},
    cut: {},
    message: {},
    digest: {},
    limit: {},
    tasksStalled: {},
    ownTurns: {},
    audit: {},
    spend: {},
    consoleIdle: {},
  }
  private file: string

  constructor(dataDir: string) {
    this.file = join(dataDir, 'needs-you-acks.json')
  }

  load(): void {
    if (!existsSync(this.file)) return
    const text = readFileSync(this.file, 'utf8')
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      backupCorruptJson(this.file, text, 'needs-you-acks')
      this.maps = { escalated: {}, run: {}, cut: {}, message: {}, digest: {}, limit: {}, tasksStalled: {}, ownTurns: {}, audit: {}, spend: {}, consoleIdle: {} }
      return
    }
    for (const kind of ACK_KINDS) {
      const src = (raw as Record<string, unknown> | null)?.[kind]
      const good: Record<string, string> = {}
      if (src && typeof src === 'object' && !Array.isArray(src)) {
        for (const [key, version] of Object.entries(src as Record<string, unknown>)) {
          if (typeof version === 'string' && version !== '') good[key] = version
          else console.warn(`needs-you-acks: ${kind} entry discarded for invalid value (${key})`)
        }
      }
      this.maps[kind] = good
    }
  }

  ackedVersion(kind: AckKind, key: string): string | null {
    return Object.hasOwn(this.maps[kind], key) ? this.maps[kind][key]! : null
  }

  ack(kind: AckKind, key: string, version: string): void {
    this.maps[kind][key] = version
    // the escalated map is always written (the file's original shape);
    // the others only once they hold something
    const out: Record<string, Record<string, string>> = { escalated: this.maps.escalated }
    for (const k of ACK_KINDS) if (k !== 'escalated' && Object.keys(this.maps[k]).length > 0) out[k] = this.maps[k]
    atomicWriteJson(this.file, out)
  }

  escalatedAckedAt(agentId: string): string | null {
    return this.ackedVersion('escalated', agentId)
  }

  ackEscalated(agentId: string, at: string): void {
    this.ack('escalated', agentId, at)
  }
}
