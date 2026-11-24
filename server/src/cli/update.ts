// cli/update.ts — `silos update` and `silos uninstall`: what each does
// depends on HOW this copy of Silos got here, so that is decided first and
// in one place (q4 t48).
//
//   - installed (npm install -g silosplatform): npm moves it, then the
//     service — when there is one — restarts on the new version.
//   - fetched by npx: nothing to move; npx runs the newest when asked to.
//   - a source checkout: git's business; the commands are said, never run.
//
// There is no data migration step and no backup: Silos keeps plain files
// under its data directory and a newer Silos reads them as they are. Going
// back is the same command with `--version`.
import { compareVersions } from '../harness-run.js'
import { isNpxCopy } from './service.js'

export const PACKAGE = 'silosplatform'

export type Origin = 'installed' | 'npx' | 'source'

/** How this copy got here: the package's own name and where its files are. */
export function originOf(pkgName: string | null, entry: string): Origin {
  if (pkgName !== PACKAGE) return 'source'
  return isNpxCopy(entry) ? 'npx' : 'installed'
}

export type UpdatePlan = { kind: 'say'; lines: string[] } | { kind: 'install'; from: string; to: string; cmd: string; args: string[] }

export interface UpdateInput {
  origin: Origin
  current: string
  /** what the registry says is published; null = it could not be asked */
  latest: string | null
  /** `--version x.y.z`: that one, whatever is newest */
  pin?: string
  /** `--check`: say, change nothing */
  checkOnly?: boolean
}

export function updatePlan(i: UpdateInput): UpdatePlan {
  if (i.origin === 'source') {
    return {
      kind: 'say',
      lines: [`This Silos (${i.current}) runs from a source checkout. Update it there:`, '  git pull && npm install && npm run build', 'then restart it.'],
    }
  }
  if (i.origin === 'npx') {
    return {
      kind: 'say',
      lines: [
        `This Silos (${i.current}) was fetched by npx. The newest runs with:`,
        `  npx ${PACKAGE}@latest`,
        `To keep it installed (and run it as a service): npm install -g ${PACKAGE}`,
      ],
    }
  }
  const to = i.pin ?? i.latest
  if (!to) return { kind: 'say', lines: [`Could not ask npm which version of ${PACKAGE} is published — check the network and try again.`] }
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(to)) return { kind: 'say', lines: [`«${to}» is not a version (expected x.y.z).`] }
  if (to === i.current) return { kind: 'say', lines: [`Silos ${i.current} is ${i.pin ? 'already that version' : 'the newest published'}.`] }
  if (!i.pin && compareVersions(i.current, to) > 0) return { kind: 'say', lines: [`Silos ${i.current} is newer than the published ${to}. Nothing to do.`] }
  if (i.checkOnly) return { kind: 'say', lines: [`Silos ${to} is available (this is ${i.current}). Update with: silos update`] }
  return { kind: 'install', from: i.current, to, cmd: 'npm', args: ['install', '-g', `${PACKAGE}@${to}`] }
}

/** What `silos uninstall` removes of the program itself (after the service). */
export function uninstallPlan(origin: Origin): { cmd: string; args: string[] } | { say: string } {
  if (origin === 'installed') return { cmd: 'npm', args: ['uninstall', '-g', PACKAGE] }
  if (origin === 'npx') return { say: 'This copy was fetched by npx: there is no installed program to remove.' }
  return { say: 'This Silos runs from a source checkout: delete the folder to remove it.' }
}
