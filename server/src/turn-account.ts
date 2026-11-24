// turn-account.ts — the account an agent's next UNATTENDED turn runs on
// — the same resolution ChatService.send makes (the
// automation's runsOn, the install's switch, the agent's own with its
// fallback), classified for the heartbeat's brakes:
//
//   priced     a provider that prices (an API key): its spend cap brakes it
//   readable   a Claude account whose plan reading Silos can take — ONLY when
//              the turn's engine really runs on that Claude account. An
//              engine that cannot run a Claude account (its harness does not
//              list the kind) runs the agent's «default» on its own login:
//              no price, no reading ⇒ ROUNDS_UNMEASURED_PER_DAY.
//
// Neutral: the engine is asked through the harness contract
// (HarnessProviderRules.kinds), never named.
import type { Agent } from './types.js'
import type { ResolvedProvider } from './providers-store.js'
import { providerPrices } from './providers-store.js'
import { harnessOf, ownsProviders } from './harnesses/registry.js'
import type { TurnAccount } from './resident/deps.js'

/** What a resolved provider is to a turn of `agent` (null provider: no
 *  providers store — the machine's own login, the engine's default). */
export function turnAccountFor(agent: Pick<Agent, 'framework'>, p: ResolvedProvider | null): TurnAccount {
  const id = p?.id ?? 'default'
  if (providerPrices(p)) return { id, priced: true, readable: false }
  let runsClaudeAccounts = false
  try {
    runsClaudeAccounts = ownsProviders(harnessOf(agent), 'claude-account')
  } catch {
    runsClaudeAccounts = false
  }
  const claudeAccount = p === null || p.kind === 'claude-account'
  return { id, priced: false, readable: runsClaudeAccounts && claudeAccount }
}

/** The account the agent's next unattended turn runs on, resolved as
 *  ChatService will resolve it. An unknown agent: the default, unreadable. */
export function turnAccountOf(
  deps: { registry: { get(id: string): Agent | null }; chat: { unattendedTurnProvider(agentId: string, runsOnProvider?: string): ResolvedProvider | null } },
  agentId: string,
  runsOnProvider: string | undefined,
): TurnAccount {
  const agent = deps.registry.get(agentId)
  if (!agent) return { id: 'default', priced: false, readable: false }
  return turnAccountFor(agent, deps.chat.unattendedTurnProvider(agentId, runsOnProvider))
}
