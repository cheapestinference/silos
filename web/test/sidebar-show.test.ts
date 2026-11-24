import { describe, expect, it } from 'vitest'
import { causeWords, conversationCause, listedConversations } from '../src/lib/sidebar-show'
import type { SessionView } from '../src/lib/types'

type S = Pick<SessionView, 'id' | 'folder' | 'origin'>
const own: S = { id: 'own', folder: 'f' }
const kept: S = { id: 'kept', folder: 'f', origin: { kind: 'automation', automationId: 'a1', runId: 'r1' } }
const msg: S = { id: 'msg', folder: 'f', origin: { kind: 'message', messageId: 'm1', from: 'builder', gist: 'x' } }
const run: S = { id: 'run', folder: 'f', origin: { kind: 'automation', automationId: 'a2', runId: 'r2' } }
const all = [own, kept, msg, run]
const keptBy = new Map([['kept', 'Daily digest']])
const ids = (xs: S[]): string[] => xs.map((s) => s.id)

describe('listedConversations — the sidebar lists what you started; Silos-started work lives under its cause', () => {
  it('at rest: only your own', () => {
    expect(ids(listedConversations(all, keptBy, { searching: false, isOpen: () => false }))).toEqual(['own'])
  })
  it('a kept thread or a message conversation shows while open, or when a search matches — a run never', () => {
    expect(ids(listedConversations(all, keptBy, { searching: false, isOpen: (s: S) => s.id !== 'own' }))).toEqual(['own', 'kept', 'msg'])
    expect(ids(listedConversations(all, keptBy, { searching: true, isOpen: () => false }))).toEqual(['own', 'kept', 'msg'])
  })
})

describe('conversationCause — why a row the sidebar would not list exists (C1)', () => {
  const keptBy = new Map([['kept1', 'Nightly report']])
  const facts = {
    keptBy,
    automationName: (id: string) => (id === 'auto1' ? 'Invoice checks' : null),
    parentTitle: (sid: string) => (sid === 'mother1' ? 'Refactor the importer' : null),
  }
  it('an open task outranks every origin — a wake reads as work on its task', () => {
    const tasks = [{ title: 'Ship the fix' }, { title: 'Review' }]
    expect(conversationCause({ id: 'x', origin: { kind: 'task', task: 'k', ref: 'p#t1' } }, { ...facts, tasks })).toEqual({
      kind: 'task',
      title: 'Ship the fix',
      more: 1,
    })
    expect(conversationCause({ id: 'x', origin: { kind: 'automation', automationId: 'auto1', runId: 'r' } }, { ...facts, tasks })).toEqual({
      kind: 'task',
      title: 'Ship the fix',
      more: 1,
    })
  })
  it('a nested run names its mother when the list has her', () => {
    expect(conversationCause({ id: 'x', origin: { kind: 'nested', parent: 'mother1', agentId: 'builder' } }, facts)).toEqual({
      kind: 'nested',
      parent: 'Refactor the importer',
    })
    expect(conversationCause({ id: 'x', origin: { kind: 'nested', parent: null, agentId: 'builder' } }, facts)).toEqual({ kind: 'nested', parent: null })
  })
  it('a kept thread, a heartbeat, a run — each its own cause', () => {
    expect(conversationCause({ id: 'kept1', origin: { kind: 'automation', automationId: 'auto1', runId: 'r' } }, facts)).toEqual({
      kind: 'kept',
      automation: 'Nightly report',
    })
    expect(conversationCause({ id: 'x', origin: { kind: 'automation', automationId: 'heartbeat-builder', runId: 'r' } }, facts)).toEqual({ kind: 'heartbeat' })
    expect(conversationCause({ id: 'x', origin: { kind: 'automation', automationId: 'auto1', runId: 'r' } }, facts)).toEqual({
      kind: 'run',
      automation: 'Invoice checks',
    })
    expect(conversationCause({ id: 'x', origin: { kind: 'automation', automationId: 'deleted', runId: 'r' } }, facts)).toEqual({
      kind: 'run',
      automation: null,
    })
  })
  it('a message conversation, a task birth with no open task, and the owner own', () => {
    expect(conversationCause({ id: 'x', origin: { kind: 'message', messageId: 'm', from: 'owner', gist: 'g' } }, facts)).toEqual({ kind: 'message' })
    expect(conversationCause({ id: 'x', origin: { kind: 'task', task: 'k', ref: 'p#t3' } }, facts)).toEqual({ kind: 'born-of-task', ref: 'p#t3' })
    expect(conversationCause({ id: 'x' }, facts)).toBeNull()
  })
  it('every cause has words, and none has none', () => {
    const causes = [
      { kind: 'task', title: 'T', more: 0 },
      { kind: 'nested', parent: null },
      { kind: 'kept', automation: 'A' },
      { kind: 'heartbeat' },
      { kind: 'run', automation: null },
      { kind: 'message' },
      { kind: 'born-of-task', ref: 'p#t1' },
    ] as const
    for (const c of causes) expect(causeWords(c)).toBeTruthy()
    expect(causeWords(null)).toBeNull()
  })
})
