// harnesses/opencode/bin.ts — the OpenCode binary Silos runs. A leaf of its
// own so the adapter's modules (auto-mode, tui-auth) and the composition
// root can name it without importing the adapter's index.ts.
import { join } from 'node:path'

/** `$SILOS_OPENCODE_BIN` › `opencode` (on the console's PATH). */
export function opencodeBin(): string {
  return process.env.SILOS_OPENCODE_BIN || 'opencode'
}

/** Where OpenCode's documented installer puts `opencode`
 *  (https://opencode.ai/install → ~/.opencode/bin). */
export function opencodeInstallDirs(home: string): string[] {
  return [join(home, '.opencode', 'bin')]
}
