// harness-descriptor.ts — what the web knows about each registered engine
// (GET /api/harnesses, design D.4): its id and label, whether it is the
// default (the fallback: an agent with no framework runs there), its caps,
// the provider kinds it can run, whether a started conversation may switch
// console ⇄ chat (traits.handover) and its UI facts. Read lazily, in
// registration order — a harness registered later appears with no edit here.
// web/src/lib/harnesses.seed.json is a copy of this answer for the built-in
// engines (first paint, automocked tests); a test keeps the two equal.

import type { HarnessCaps, HarnessUiFacts, ProviderKind } from './harnesses/contract.js'
import { registeredHarnesses } from './harnesses/registry.js'

export interface HarnessDescriptor {
  id: string
  label: string
  default: boolean
  caps: HarnessCaps
  providerKinds: ProviderKind[]
  modeSwitch: boolean
  ui: HarnessUiFacts
}

export function describeHarnesses(): HarnessDescriptor[] {
  return registeredHarnesses().map((h) => ({
    id: h.id,
    label: h.label,
    default: h.fallback === true,
    caps: { ...h.caps },
    providerKinds: [...h.providers.kinds],
    modeSwitch: h.traits.handover,
    ui: { ...h.ui },
  }))
}
