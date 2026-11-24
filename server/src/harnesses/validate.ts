// harnesses/validate.ts — the harness is chosen when an agent is created and
// never changed afterwards. Pure body check for POST/PATCH /api/agents, same
// shape as validateAgentProviderFields: returns the error message or null.

import { findHarness, isHarnessId } from './registry.js'
import type { HarnessId, OutputStyleInfo } from './contract.js'

/**
 * `existing` is the agent's current harness on PATCH (undefined on POST).
 */
export function harnessFieldError(body: unknown, existing?: string): string | null {
  if (typeof body !== 'object' || body === null) return null
  const v = (body as Record<string, unknown>).framework
  if (v === undefined) return null
  if (!isHarnessId(v)) return `unknown harness: ${String(v)}`
  if (existing && existing !== v) return 'harness is chosen at creation'
  return null
}

/** The styles an engine offers for a conversation in `cwd`, or null when
 *  the engine has no output styles (caps.outputStyles false). */
export function outputStylesFor(harness: HarnessId, cwd: string | null): OutputStyleInfo[] | null {
  const h = findHarness(harness)
  if (!h || !h.caps.outputStyles || !h.outputStyles) return null
  return h.outputStyles(cwd)
}

/** A style set on an agent or a conversation must be one its engine offers
 *  NOW for that folder (Claude falls back to default in silence on an
 *  unknown name — Silos refuses it instead). The error or null. */
export function outputStyleError(harness: HarnessId, style: string, cwd: string | null): string | null {
  const offered = outputStylesFor(harness, cwd)
  const label = findHarness(harness)?.label ?? harness
  if (offered === null) return `${label} has no output styles`
  if (!offered.some((s) => s.id === style)) return `unknown output style for ${label}: ${style} (offered: ${offered.map((s) => s.id).join(', ')})`
  return null
}
