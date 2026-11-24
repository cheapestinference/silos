// silos-origin.ts — how THIS running Silos got here, read once, and the
// command that updates it. The CLI's `silos update` decides the same thing
// (cli/update.ts originOf); the server needs it to word a verdict whose fix
// is Silos' own update (an engine newer than Silos' client library): an
// install is told `silos update`, an npx copy `npx silosplatform@latest`,
// and only a source checkout the repo's own command (null here — the
// verdict keeps the one it names).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { originOf, PACKAGE, type Origin } from './cli/update.js'

/** The command that updates a Silos of this origin; null = a source checkout. */
export function silosUpdateCommand(origin: Origin): string | null {
  if (origin === 'installed') return 'silos update'
  if (origin === 'npx') return `npx ${PACKAGE}@latest`
  return null
}

let cached: Origin | undefined
/** This process's origin: the root manifest's name (server/src|dist → ../../package.json). */
export function thisSilosOrigin(): Origin {
  if (cached) return cached
  let name: string | null = null
  try {
    const p = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { name?: unknown }
    name = typeof p.name === 'string' ? p.name : null
  } catch {
    /* unreadable: a source checkout's words are the safe ones */
  }
  cached = originOf(name, join(import.meta.dirname, 'index.js'))
  return cached
}
