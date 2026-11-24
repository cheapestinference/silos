// session-origins.ts — WHO gave birth to a session.
//
// A conversation the owner starts and a conversation an automation run
// opens are different kinds of thing: the first belongs in
// the sidebar's conversation list, the second under its automation. The
// transcript on disk doesn't say which is which — the resident is the only
// witness of the birth (a chat-init with no `resume`), and it records it
// here, durably, keyed by "folder/id". Independent of runs.jsonl on
// purpose: run history rotates and is dropped as hygiene; a session's
// origin is a fact for the session's whole life.
//
// First record wins: a keep thread is born ONCE (its first run); later runs
// append to it and must not rename its birth.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, backupCorruptJson } from './json-store.js'
import type { AutomationsStore } from './automations-store.js'

// A conversation Silos opened to work ONE urgent message (the retired
// message dispatcher) is the third kind — HISTORY: no longer written — no message wakes anyone;
// read on saved records only: neither the owner's own nor a run. It stays a conversation anyone can continue, but it
// is out of the owner's unread, counts and digest lines. `gist` = the
// message's first line, so the title's provenance line needs no inbox read.
// The fourth: a conversation Task mode opened to wake an agent on ONE task
// (task-mode/engine.ts, a wake turn on a task with no conversation yet) —
// it lives under its task (listed in its conversations[]), never among the
// owner's own: out of «N conversations finished» and the counts. `task` is
// the plans record key, `ref` the words people say (plan#t3).
export type SessionOrigin =
  | { kind: 'automation'; automationId: string; runId: string; at: string }
  | { kind: 'message'; agentId: string; messageId: string; from: string; gist: string; at: string }
  | { kind: 'task'; agentId: string; task: string; ref: string; at: string }
export type AutomationOrigin = Extract<SessionOrigin, { kind: 'automation' }>
export type MessageOrigin = Extract<SessionOrigin, { kind: 'message' }>
export type TaskOrigin = Extract<SessionOrigin, { kind: 'task' }>

// a message's first non-empty line, ≤120 chars — the origin's gist
export function messageGist(text: string): string {
  const line =
    text
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? ''
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

interface Shape {
  origins: Record<string, SessionOrigin>
}

function isOrigin(v: unknown): v is SessionOrigin {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (typeof o.at !== 'string') return false
  if (o.kind === 'automation') return typeof o.automationId === 'string' && typeof o.runId === 'string'
  if (o.kind === 'message') return typeof o.agentId === 'string' && typeof o.messageId === 'string' && typeof o.from === 'string' && typeof o.gist === 'string'
  if (o.kind === 'task') return typeof o.agentId === 'string' && typeof o.task === 'string' && typeof o.ref === 'string'
  return false
}

export class SessionOriginsStore {
  private origins: Record<string, SessionOrigin> = {}
  private file: string

  constructor(dataDir: string) {
    this.file = join(dataDir, 'session-origins.json')
  }

  load(): void {
    if (!existsSync(this.file)) return
    const text = readFileSync(this.file, 'utf8')
    let raw: Shape
    try {
      raw = JSON.parse(text) as Shape
    } catch {
      backupCorruptJson(this.file, text, 'session-origins')
      this.origins = {}
      return
    }
    const entries = raw.origins && typeof raw.origins === 'object' && !Array.isArray(raw.origins) ? raw.origins : {}
    const good: Record<string, SessionOrigin> = {}
    for (const [key, o] of Object.entries(entries)) {
      if (isOrigin(o)) good[key] = o
      else console.warn(`session-origins: entry discarded for invalid value (${key})`)
    }
    this.origins = good
  }

  get(sessionKey: string): SessionOrigin | null {
    return this.origins[sessionKey] ?? null
  }

  // the automation birth only — what «is this a run?» asks
  automation(sessionKey: string): AutomationOrigin | null {
    const o = this.origins[sessionKey]
    return o?.kind === 'automation' ? o : null
  }

  // Records the birth. Idempotent and first-wins: a later call for the same
  // session (a keep thread's run #2) changes nothing and writes nothing.
  record(sessionKey: string, origin: SessionOrigin): boolean {
    if (this.origins[sessionKey]) return false
    this.origins[sessionKey] = origin
    this.save()
    return true
  }

  // One-time adoption of history: before this store existed, every run of a
  // `thread.mode: 'new'` automation opened its own session — those sessions
  // are automation-born by construction and get their origin from the run
  // that carries their key. Keep threads are NOT backfilled: a keep thread
  // can be the owner's own conversation (an automation created from the
  // composer), and a guess there would steal a human conversation from the
  // sidebar. Going forward the resident records keep births at chat-init.
  backfill(store: AutomationsStore): number {
    let added = 0
    for (const a of store.list()) {
      if (a.thread.mode !== 'new') continue
      // oldest first, so the FIRST run to touch a key is its birth
      for (const r of [...store.listRuns(a.id)].reverse()) {
        if (!r.sessionKey || this.origins[r.sessionKey]) continue
        this.origins[r.sessionKey] = { kind: 'automation', automationId: a.id, runId: r.id, at: r.startedAt ?? r.at }
        added++
      }
    }
    if (added > 0) this.save()
    return added
  }

  private save(): void {
    atomicWriteJson(this.file, { origins: this.origins } satisfies Shape)
  }
}
