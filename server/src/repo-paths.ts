// repo-paths.ts — where the Silos checkout's own files are, as filesystem
// paths. One place, from one known location (this module sits in server/src,
// or server/dist when built: two levels below the repo root either way), so
// a module moved into a subfolder never silently points one level off.
// The rule for the whole class: a path is derived from `import.meta.dirname`
// (or `fileURLToPath`) — never the `pathname` of the module's file URL,
// which percent-encodes a space (`/My%20Repo/…`) and names a file that does
// not exist. server/test/repo-paths.test.ts holds every server/src file to it.
import { join } from 'node:path'

/** The root of the Silos checkout (or of the installed package). */
export const REPO_ROOT = join(import.meta.dirname, '..', '..')

/** `<repo>/plugin` — the Claude Code plugin (hooks, skills, context). */
export const PLUGIN_DIR = join(REPO_ROOT, 'plugin')

/** `<repo>/plugin/hooks` — the scripts Settings › Engines › Silos hooks wires into ~/.claude/settings.json. */
export const PLUGIN_HOOKS_DIR = join(PLUGIN_DIR, 'hooks')
