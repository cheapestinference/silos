// harnesses/claude-code/env.ts — what a Claude process's env carries for
// its provider: envForProvider (the SDK's subprocess) and
// consoleEnvForProvider (the real console's tmux delta). The cleanup step
// (cleanEnv) stays neutral in ../../env.ts — see its header for why the
// two steps are separate.
import { cleanEnv } from '../../env.js'
import type { ResolvedProvider } from '../../providers-store.js'

// Final subprocess env for the SDK, depending on the agent's provider.
// - default (or no resolved provider): byte-identical to cleanEnv() — the
//   long-standing behavior, verified by a regression test.
// - claude-account with configDir: cleanEnv() + CLAUDE_CONFIG_DIR (injected
//   AFTER cleanup — see header).
// - anthropic-compatible: cleanEnv() without inherited ANTHROPIC_* credentials
//   (an ANTHROPIC_API_KEY from the owner's shell would compete with the
//   provider's key) + the provider's ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN.
//   ANTHROPIC_AUTH_TOKEN is used and NOT ANTHROPIC_API_KEY on purpose: Claude
//   Code/the SDK accept both (verified in node_modules/@anthropic-ai/
//   claude-agent-sdk/sdk.mjs: ANTHROPIC_API_KEY travels as the x-api-key
//   header, ANTHROPIC_AUTH_TOKEN as Authorization: Bearer), and
//   Anthropic-compatible proxies expect the Bearer form — cheapestinference's
//   own docs (docs/guides/claude-code.md) instruct exporting
//   ANTHROPIC_AUTH_TOKEN with the subscriber key.
export function envForProvider(provider: ResolvedProvider | null | undefined): Record<string, string> {
  const env = cleanEnv()
  if (!provider || provider.kind === 'claude-account') {
    if (provider?.configDir) {
      // An inherited ANTHROPIC_API_KEY/AUTH_TOKEN from the owner's shell
      // would COMPETE with (and typically win over) the chosen account's
      // OAuth login — the multi-account feature would silently misbehave.
      // Inherited credentials are pruned ONLY when a specific account is
      // injected; the default branch (configDir null) stays byte-identical
      // to cleanEnv() (regression test).
      delete env.ANTHROPIC_BASE_URL
      delete env.ANTHROPIC_API_KEY
      delete env.ANTHROPIC_AUTH_TOKEN
      env.CLAUDE_CONFIG_DIR = provider.configDir
    }
    return env
  }
  // OpenCode kinds (harness-provider / harness-native) never reach a Claude
  // process (providers-validate.ts refuses the pairing); should one slip
  // through, it adds nothing — the key only ever rides an OpenCode process
  // (harnesses/opencode/launch.ts providerLaunch).
  if (provider.kind !== 'anthropic-compatible') return env
  delete env.ANTHROPIC_BASE_URL
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  env.ANTHROPIC_BASE_URL = provider.baseUrl
  // a gateway's FIRST known model is the default model (a pin still wins:
  // --model / the SDK option beat the env) — Claude's own default id would
  // get a 404 from a pool key; the small/fast model follows for the same reason
  if (provider.models && provider.models.length > 0) {
    env.ANTHROPIC_MODEL = provider.models[0] as string
    env.ANTHROPIC_SMALL_FAST_MODEL = provider.models[0] as string
  }
  env.ANTHROPIC_AUTH_TOKEN = provider.apiKey
  return env
}

// The REAL CONSOLE's provider delta — session env vars for the tmux spawn
// (ensureConsole's extraEnv), mirroring envForProvider()'s semantics without
// shipping the whole process env through `tmux -e`:
// - default provider (null / configDir null): EMPTY delta — the console
//   stays byte-identical to what it always was (the machine's login).
// - claude-account with configDir: CLAUDE_CONFIG_DIR, plus the ANTHROPIC_*
//   credential vars pinned to '' so an inherited key from the server's
//   shell can't compete with the chosen account's OAuth login (claude
//   treats '' as unset).
// - anthropic-compatible: the provider's BASE_URL + AUTH_TOKEN (Bearer, the
//   form proxies expect), with ANTHROPIC_API_KEY pinned to ''.
export function consoleEnvForProvider(provider: ResolvedProvider | null | undefined): Record<string, string> {
  if (!provider || provider.kind === 'claude-account') {
    if (!provider?.configDir) return {}
    return { CLAUDE_CONFIG_DIR: provider.configDir, ANTHROPIC_BASE_URL: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' }
  }
  // OpenCode kinds: an empty delta (see envForProvider)
  if (provider.kind !== 'anthropic-compatible') return {}
  const first = provider.models && provider.models.length > 0 ? (provider.models[0] as string) : null
  return {
    ANTHROPIC_BASE_URL: provider.baseUrl,
    ANTHROPIC_AUTH_TOKEN: provider.apiKey,
    ANTHROPIC_API_KEY: '',
    // same default-model rule as envForProvider; cleared when the gateway lists nothing
    ANTHROPIC_MODEL: first ?? '',
    ANTHROPIC_SMALL_FAST_MODEL: first ?? '',
  }
}
