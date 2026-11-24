// harnesses/claude-code/login.ts — a Claude account's sign-in terminal:
// the command and the env it runs under (TerminalService.openAccountLogin).

// What a sign-in terminal runs: the UNMODIFIED `claude auth login` under the
// account's CLAUDE_CONFIG_DIR — the same binary the console runs. The owner
// signs in with Claude's own flow (its link, its paste prompt); Silos only
// carries the bytes between the PTY and xterm, never reads the code or the
// token (Anthropic: no login of claude.ai offered by the product itself).
// The machine's own account (configDir null — ~/.claude + ~/.claude.json) is
// the same command with NO CLAUDE_CONFIG_DIR: exactly what its operator would
// type in a terminal. Silos offers it only while that account is signed out
// (routes/providers.ts — the first run's «Sign in to Claude ›»), so a UI sign-in never replaces a login the machine has.
export type LoginCommand = (configDir: string | null) => { file: string; args: string[] }
export const defaultLoginCommand: LoginCommand = () => ({ file: 'claude', args: ['auth', 'login', '--claudeai'] })

// cleanEnv() drops inherited CLAUDE* vars, so the account's dir is set after
// it; the machine's account (null) keeps Claude's own default location
export function loginEnv(configDir: string | null): Record<string, string> {
  return configDir === null ? {} : { CLAUDE_CONFIG_DIR: configDir }
}
