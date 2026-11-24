// harnesses.ts — the ONE web module that knows engine descriptors (design D.4).
// It holds the list of engines the server registered (GET /api/harnesses), in
// registration order, seeded from harnesses.seed.json (a copy of the server's
// answer for the built-in engines, used for first paint and by automocked
// tests). The store's loadHarnesses() replaces the list when the route answers
// with a valid shape; anything else keeps what is there.
//
// Two rules every caller relies on:
// - descriptorOf(undefined) is the default engine (the server's harnessOf
//   legacy rule: an agent or session with no harness runs on the default).
// - descriptorOf('<unregistered>') is unknownDescriptor(id): label = id and
//   nothing granted — it never borrows the default engine's affordances.
//
// No store import here (the store seeds itself from this module, so importing
// it back would make a cycle that reads the list before it exists). useHarness
// re-renders through this module's own subscription, which every
// setHarnessDescriptors — the store's loadHarnesses included — notifies.

import { useSyncExternalStore } from 'react'
import seed from './harnesses.seed.json'
import type { HarnessCaps, HarnessDescriptor, HarnessUiFacts } from './types'

const CAP_KEYS: readonly (keyof HarnessCaps)[] = ['compaction', 'subagents', 'skills', 'thinking', 'costFromHarness', 'permissionsAsEvents', 'sendToConsole']
const PROVIDER_KINDS: readonly string[] = ['claude-account', 'anthropic-compatible', 'harness-provider', 'harness-native']
const MODEL_STYLES: readonly string[] = ['catalog', 'provider-model', 'none']

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isStrOrNull = (v: unknown): boolean => v === null || typeof v === 'string'
const absentOr = (v: unknown, ok: (x: unknown) => boolean): boolean => v === undefined || ok(v)
const isPairOrNull = (v: unknown, a: string, b: string): boolean => v === null || (isObj(v) && typeof v[a] === 'string' && typeof v[b] === 'string')

function validDescriptor(v: unknown): v is HarnessDescriptor {
  if (!isObj(v)) return false
  if (typeof v.id !== 'string' || v.id === '' || typeof v.label !== 'string') return false
  if (!isBool(v.default) || !isBool(v.modeSwitch)) return false
  const caps = v.caps
  if (!isObj(caps) || !CAP_KEYS.every((k) => isBool(caps[k]))) return false
  if (!Array.isArray(v.providerKinds) || !v.providerKinds.every((k) => typeof k === 'string' && PROVIDER_KINDS.includes(k))) return false
  const ui = v.ui
  if (!isObj(ui)) return false
  return (
    isBool(ui.contextPercent) &&
    typeof ui.models === 'string' &&
    MODEL_STYLES.includes(ui.models) &&
    isBool(ui.ownLogin) &&
    isBool(ui.territoryFenced) &&
    isStrOrNull(ui.territoryNote) &&
    isStrOrNull(ui.settingsAbout) &&
    isPairOrNull(ui.loginImport, 'list', 'import') &&
    isPairOrNull(ui.providerExport, 'target', 'label') &&
    absentOr(ui.updateLabel, isStrOrNull) &&
    absentOr(ui.consoleColours, isBool) &&
    absentOr(ui.consoleColoursHint, isStrOrNull) &&
    absentOr(ui.providersAbout, isStrOrNull) &&
    absentOr(ui.providerIdPlaceholder, isStrOrNull) &&
    absentOr(ui.loginCommand, isStrOrNull)
  )
}

// a whole list: every entry valid, ids unique, exactly one default
function validList(v: unknown): v is HarnessDescriptor[] {
  if (!Array.isArray(v) || v.length === 0 || !v.every(validDescriptor)) return false
  if (new Set(v.map((d) => d.id)).size !== v.length) return false
  return v.filter((d) => d.default).length === 1
}

function frozenCopy(list: readonly HarnessDescriptor[]): readonly HarnessDescriptor[] {
  return Object.freeze(
    list.map((d) =>
      Object.freeze({
        ...d,
        caps: Object.freeze({ ...d.caps }),
        providerKinds: Object.freeze([...d.providerKinds]) as HarnessDescriptor['providerKinds'],
        ui: Object.freeze({
          ...d.ui,
          loginImport: d.ui.loginImport && Object.freeze({ ...d.ui.loginImport }),
          providerExport: d.ui.providerExport && Object.freeze({ ...d.ui.providerExport }),
        }),
      }),
    ),
  )
}

if (!validList(seed.harnesses)) throw new Error('harnesses.seed.json does not hold a valid descriptor list')
let current: readonly HarnessDescriptor[] = frozenCopy(seed.harnesses)
const listeners = new Set<() => void>()

export function harnessDescriptors(): readonly HarnessDescriptor[] {
  return current
}

// validates; false → the list is left unchanged
export function setHarnessDescriptors(next: unknown): boolean {
  if (!validList(next)) return false
  current = frozenCopy(next)
  for (const l of [...listeners]) l()
  return true
}

export function defaultHarnessId(): string {
  return defaultDescriptor().id
}

function defaultDescriptor(): HarnessDescriptor {
  // validList guarantees exactly one
  return current.find((d) => d.default)!
}

// an engine this web does not know: its id as the label, nothing granted
export function unknownDescriptor(id: string): HarnessDescriptor {
  const caps = Object.fromEntries(CAP_KEYS.map((k) => [k, false])) as unknown as HarnessCaps
  const ui: HarnessUiFacts = {
    contextPercent: false,
    models: 'none',
    ownLogin: true,
    territoryFenced: true,
    territoryNote: null,
    settingsAbout: null,
    loginImport: null,
    providerExport: null,
  }
  return { id, label: id, default: false, caps, providerKinds: [], modeSwitch: false, ui }
}

export function descriptorOf(id: string | undefined | null): HarnessDescriptor {
  if (!id) return defaultDescriptor()
  return descriptorIn(current, id)
}

// one id in a given list (the one useHarnessDescriptors returned, so a render
// reads the same snapshot it subscribed to): unknownDescriptor when absent —
// an id from a server fact (Settings' engine rows, Territory) is never ''
export function descriptorIn(list: readonly HarnessDescriptor[], id: string): HarnessDescriptor {
  return list.find((d) => d.id === id) ?? unknownDescriptor(id)
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

// re-renders when the list changes (setHarnessDescriptors, the store's
// loadHarnesses); an unknown id gets a fresh unknownDescriptor per call, so
// the snapshot is the list itself and the lookup happens after it
export function useHarness(id: string | undefined | null): HarnessDescriptor {
  useSyncExternalStore(subscribe, harnessDescriptors, harnessDescriptors)
  return descriptorOf(id)
}

// the whole list, in registration order, re-rendering when it changes (the
// engine picker of the create form)
export function useHarnessDescriptors(): readonly HarnessDescriptor[] {
  return useSyncExternalStore(subscribe, harnessDescriptors, harnessDescriptors)
}
