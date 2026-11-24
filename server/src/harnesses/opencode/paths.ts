// harnesses/opencode/paths — where OpenCode databases live. The operator's
// own OpenCode keeps one global DB under the XDG data dir; an agent Silos
// runs on OpenCode gets its own DB under <dataDir>/agents/<id>/.

import { homedir } from 'node:os'
import { join } from 'node:path'

/** `$SILOS_OPENCODE_DATA` › `$XDG_DATA_HOME` › `~/.local/share`, + `/opencode/opencode.db`
 *  (an empty variable counts as unset). `home` is the server's cfg.home, so
 *  the E2E harness (SILOS_HOME) never reads the operator's real DB. */
export function globalDbPath(home: string = homedir()): string {
  return join(opencodeDataDir(home), 'opencode.db')
}

/** The operator's OpenCode data dir (same precedence as globalDbPath). */
export function opencodeDataDir(home: string = homedir()): string {
  const base = process.env.SILOS_OPENCODE_DATA || process.env.XDG_DATA_HOME || join(home, '.local', 'share')
  return join(base, 'opencode')
}

export function agentDbPath(dataDir: string, agentId: string): string {
  return join(dataDir, 'agents', agentId, 'opencode.db')
}
