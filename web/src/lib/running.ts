// running.ts — what the column says about the claudes holding a conversation
// open RIGHT NOW (GET /api/sessions/:folder/:id `running`: each holder with
// the account its live process really spends). The line under the account
// is the account the conversation was SET to; this is the account it RUNS
// on — they differ when the account was changed with the console already
// open (the process keeps the login it was born with), or when a claude
// outside Silos resumed the same conversation (seen: two conversations set
// to an extra account ran on the machine's, and one was open twice, on two
// accounts).
import type { ProviderView, SessionRunning } from './types'
import { canonicalProviderId } from './runs-on'

// Only THIS view's claude counts — the Silos console of the conversation
// (only the one active now in this terminal or chat); a claude started
// outside Silos on the same conversation is not
// what the owner is looking at. In chat mode each turn honours the account
// it is set to, so there is nothing to say.
export interface RunningNote {
  runsOn: string
  runsOnId: string | null
  setTo: string
}

// an account by its email (the display name repeats across one person's
// accounts); an unknown dir is said as unknown, never dressed as an account
export function accountWho(providers: readonly ProviderView[], providerId: string | null): string {
  if (providerId === null) return 'an account Silos doesn\u2019t know'
  const p = providers.find((x) => x.id === providerId)
  if (p && p.kind === 'claude-account') return p.account.email ?? p.account.name
  return providerId === 'default' ? 'this machine\u2019s login' : providerId
}

export function runningNote(running: readonly SessionRunning[] | undefined, providers: readonly ProviderView[], setTo: string | null): RunningNote | null {
  const console = running?.find((r) => r.silos)
  if (!console) return null
  const wanted = canonicalProviderId(setTo)
  // only a Claude account can be told apart by its config dir; a key
  // (anthropic-compatible) rides the machine's dir with its own env
  const wantedIsAccount = providers.some((p) => p.id === wanted && p.kind === 'claude-account') || wanted === 'default'
  if (!wantedIsAccount || console.providerId === wanted) return null
  return { runsOn: accountWho(providers, console.providerId), runsOnId: console.providerId, setTo: accountWho(providers, wanted) }
}
