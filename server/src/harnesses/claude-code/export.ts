// harnesses/claude-code/export.ts — "Copy config" for a Claude agent: the env
// block it takes for an anthropic-compatible gateway, NEVER with the key (a
// placeholder the operator fills in by hand). null: no Claude form for that
// provider (an engine-owned one).

import { EXPORT_KEY_PLACEHOLDER, type ResolvedProvider } from '../../providers-store.js'

export function claudeExportSnippet(p: ResolvedProvider): string | null {
  if (p.kind !== 'anthropic-compatible') return null
  return `ANTHROPIC_BASE_URL=${p.baseUrl}\nANTHROPIC_AUTH_TOKEN=${EXPORT_KEY_PLACEHOLDER}\n`
}
