// helpers/built-ins.ts — the two engines Silos ships, for tests that pin the
// engine list. A test compares against the registry (harnessIds(),
// registeredHarnesses(), quotedIds(...)) so a third engine added the
// documented way (its folder + one registerHarness line + a conformance
// fixture) breaks nothing; it ALSO asserts the built-ins lead the list in
// this order, which is today's exact literal when only they are registered.
import { expect } from 'vitest'
import { harnessIds } from '../../src/harnesses/index.js'

export const BUILT_INS = ['claude-code', 'opencode'] as const

/** An id no engine will ever take — the "unknown engine" in refusal tests
 *  (never a plausible engine name like `codex`, which a third engine may be). */
export const NOT_AN_ENGINE = 'not-an-engine'

/** The registered ids, checked: the built-ins first, in registration order. */
export function registeredIds(): string[] {
  const ids = harnessIds()
  expect(ids.slice(0, BUILT_INS.length)).toEqual([...BUILT_INS])
  return ids
}
