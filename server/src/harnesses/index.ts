// harnesses/index.ts — the registration list: the one place that names every
// engine. Evaluating it fills the leaf registry (registry.ts); only the
// composition root (server/src/index.ts), test/setup-harnesses.ts and tests
// import it. Neutral modules and adapters import ../registry.js instead, which
// keeps the runtime graph acyclic: index.ts → adapters → neutral → registry.ts.
// The registry API is re-exported so existing import paths still resolve.

import { registerHarness } from './registry.js'
import { claudeCode } from './claude-code/index.js'
import { opencode } from './opencode/index.js'

// registered here, not by the adapter module itself: no import-order surprises
registerHarness(claudeCode)
registerHarness(opencode)

export {
  harnesses,
  registerHarness,
  registeredHarnesses,
  harnessById,
  findHarness,
  fallbackHarness,
  isHarnessId,
  harnessOf,
  harnessForId,
  harnessIds,
  quotedIds,
  nonFallbackFirst,
  fallbackFirst,
  providerOwners,
  ownsProviders,
  fencePermissionFor,
  fenceSummary,
} from './registry.js'
