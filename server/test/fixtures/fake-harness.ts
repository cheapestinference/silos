// fixtures/fake-harness.ts — a third agent engine, TEST-ONLY (never under
// src): it registers through the seam (registerHarness) and carries every
// field neutral code reads — caps, traits, providers, ui, fencePermission,
// console — plus an in-memory reader (boot) and a chat engine (headless).
// It brings no server hooks, so the console routes take console-open.ts's
// generic path. harness-fake-engine.test.ts proves the server runs it with
// no change in src; the conformance suite holds it to the same contract as
// Claude Code and OpenCode (conformance/fake.fixture.ts).
import { randomUUID } from 'node:crypto'
import type { Harness, HarnessReader, HeadlessEngine, SessionRef } from '../../src/harnesses/contract.js'
import { RULE_RE, TOOL_MAP, type PermissionAction, type PermissionConfig } from '../../src/harnesses/fence-rules.js'
import type { ChatEvent } from '../../src/chat-types.js'
import type { SessionMeta } from '../../src/types.js'

export const FAKE_T0 = 1776984076759

/** Sessions in memory; remove() hides (true) or answers false for an id it never knew. */
export class FakeReader implements HarnessReader {
  private metas = new Map<string, SessionMeta>()
  private gone = new Set<string>()
  constructor(readonly harness: string, private prefix: string, seed: SessionMeta[] = []) {
    for (const m of seed) this.metas.set(m.id, m)
  }
  ownsId(id: string): boolean { return id.startsWith(this.prefix) }
  list(): SessionMeta[] { return [...this.metas.values()].filter((m) => !this.gone.has(m.id)) }
  async init(): Promise<void> {}
  getMeta(folder: string, id: string): SessionMeta | null {
    const m = this.metas.get(id)
    return m && m.folder === folder && !this.gone.has(id) ? m : null
  }
  getContext(): null { return null }
  async readTurns(): Promise<[]> { return [] }
  async refresh(folder: string, id: string): Promise<SessionMeta | null> { return this.getMeta(folder, id) }
  remove(folder: string, id: string): boolean {
    if (!this.getMeta(folder, id)) return false
    this.gone.add(id)
    return true
  }
  watch(_onChange: (ref: SessionRef, kind: 'created' | 'updated' | 'removed') => void): () => void { return () => {} }
}

export function fakeMeta(harness: string, id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return { id, folder: '-p', title: `${harness} one`, skills: [], cwd: '/p', mtime: FAKE_T0, size: 0, turnCount: 1, harness, ...over }
}

// the fence as-is: each Claude deny rule `Tool(pattern)` → { kind: { pattern: 'deny' } }
function passThrough(fence: { permissions: { deny: string[] } }): PermissionConfig {
  const out: Record<string, Record<string, PermissionAction>> = {}
  for (const rule of fence.permissions.deny) {
    const m = RULE_RE.exec(rule)
    const kind = m ? TOOL_MAP[m[1]!] : undefined
    if (!m || !kind) continue
    ;(out[kind] ??= {})[m[2]!] = 'deny'
  }
  return out
}

export interface FakeOptions {
  id?: string
  label?: string
  prefix?: string
  idDiscovery?: 'silos-chosen' | 'reported-by-plugin'
}

export function makeFakeHarness(o: FakeOptions = {}): Harness {
  const id = o.id ?? 'fake'
  const prefix = o.prefix ?? 'fake_'
  return {
    id,
    label: o.label ?? 'Fake',
    ownsId: (x: string) => x.startsWith(prefix),
    caps: { compaction: false, subagents: false, skills: false, thinking: false, costFromHarness: false, permissionsAsEvents: false, sendToConsole: false, outputStyles: false },
    traits: { deletion: 'hide', handover: false, consolePinsModel: false, agentStateDirs: [] },
    providers: { kinds: ['anthropic-compatible'] },
    ui: { contextPercent: false, models: 'none', ownLogin: true, territoryFenced: true, territoryNote: null, settingsAbout: null, loginImport: null, providerExport: null, consoleColours: true, consoleColoursHint: null },
    fencePermission: (fence) => passThrough(fence),
    console: {
      idDiscovery: o.idDiscovery ?? 'silos-chosen',
      // born under an id it owns (console-open.ts genericOpenNew)
      newSessionId: () => `${prefix}${randomUUID()}`,
      command: (spec) => ['fake-cli', '--session', spec.key],
      env: () => ({ FAKE_HOME: '/tmp/fake' }),
    },
    boot: () => ({ reader: new FakeReader(id, prefix, [fakeMeta(id, `${prefix}1`)]) }),
    // one text event, then done — the ChatEvent shapes a text turn has
    // (opencode-headless.test.ts); each emitted through hooks.emit, in order
    headless: (ctx): HeadlessEngine => ({
      async *send(agent, input) {
        const events: ChatEvent[] = [
          { ev: 'chat-delta', turnId: input.turnId, text: `${id} says hi` },
          { ev: 'chat-done', turnId: input.turnId, subtype: 'success', costUsd: null },
        ]
        for (const ev of events) {
          ctx.hooks.emit(agent.id, ev)
          yield ev
        }
      },
      cancel: async () => false,
      isInflight: () => false,
      isSessionActive: () => false,
    }),
  }
}

/** The fake third harness: id `fake`, ids `fake_…`, a console whose id Silos chooses. */
export const fakeHarness: Harness = makeFakeHarness()
