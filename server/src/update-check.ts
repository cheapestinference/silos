// update-check.ts — whether a newer Silos is published, and how THIS
// install takes it. One source of truth for every channel: the npm
// registry's `latest` dist-tag of `silosplatform` (the GHCR image and the
// Railway template are tagged with the same version, docs/releasing.md),
// asked at most once a day, anonymously (a plain GET, nothing of the
// install in the request), and never when SILOS_NO_UPDATE_CHECK is set.
// A failed or disabled check is silence, never a row: Silos must not nag
// about a network it does not have.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** How this Silos got onto the machine — it decides the update words. */
export type InstallKind = 'npm' | 'docker' | 'railway' | 'git'

export interface UpdateStatus {
  installed: string
  kind: InstallKind
  /** the newest published version, or null while unknown (check pending, failed or disabled) */
  latest: string | null
  /** latest is a strictly newer MAJOR.MINOR.PATCH than installed */
  newer: boolean
  how: string
}

/** The root package.json this server runs from (the repo's, or the npm
 *  package's): the version lives there and nowhere else (docs/releasing.md). */
export function installedVersion(fromDir = dirname(fileURLToPath(import.meta.url))): string {
  let dir = fromDir
  for (let i = 0; i < 5; i++) {
    const p = join(dir, 'package.json')
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf8')) as { name?: unknown; version?: unknown }
      if ((pkg.name === 'silosplatform' || pkg.name === 'silos') && typeof pkg.version === 'string') return pkg.version
    } catch {
      /* keep walking */
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return '0.0.0'
}

/** Where this install came from, by what the environment can honestly say:
 *  Railway sets its own vars; a container has /.dockerenv; a git checkout
 *  (development) has the repo beside the code; everything else is the npm
 *  package (global install or npx). */
export function detectInstallKind(o: { env?: NodeJS.ProcessEnv; rootDir?: string } = {}): InstallKind {
  const env = o.env ?? process.env
  if (env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID) return 'railway'
  if (existsSync('/.dockerenv')) return 'docker'
  const root = o.rootDir ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  if (existsSync(join(root, '.git'))) return 'git'
  return 'npm'
}

/** b strictly newer than a, by MAJOR.MINOR.PATCH alone (the `latest`
 *  dist-tag never names a pre-release; an unreadable version is never newer). */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string): number[] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const av = parse(a)
  const bv = parse(b)
  if (!av || !bv) return false
  for (let i = 0; i < 3; i++) {
    if ((bv[i] as number) !== (av[i] as number)) return (bv[i] as number) > (av[i] as number)
  }
  return false
}

/** The one line that updates THIS install. */
export function howToUpdate(kind: InstallKind): string {
  switch (kind) {
    case 'npm':
      return 'npm install -g silosplatform@latest (an npx run just takes npx silosplatform@latest)'
    case 'docker':
      return 'docker pull ghcr.io/cheapestinference/silos:latest, then recreate the container'
    case 'railway':
      return 'with image auto-updates on, Railway takes it alone; otherwise redeploy the service'
    case 'git':
      return 'git pull, npm install, npm run build'
  }
}

const DAY_MS = 24 * 60 * 60_000
const FETCH_TIMEOUT_MS = 5_000

/** Asks the npm registry for the `latest` version of silosplatform.
 *  null on any failure — the caller stays silent. */
export async function fetchLatestFromNpm(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl('https://registry.npmjs.org/silosplatform/latest', {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    return typeof body.version === 'string' ? body.version : null
  } catch {
    return null
  }
}

/** The cached checker the server holds: status() answers from the last
 *  reading and refreshes in the background at most once per TTL. */
export class UpdateCheck {
  private readonly installed: string
  private readonly kind: InstallKind
  private readonly disabled: boolean
  private readonly ttlMs: number
  private readonly fetchLatest: () => Promise<string | null>
  private latest: string | null = null
  private checkedAt = 0
  private inflight: Promise<void> | null = null

  constructor(o: { installed?: string; kind?: InstallKind; env?: NodeJS.ProcessEnv; ttlMs?: number; fetchLatest?: () => Promise<string | null> } = {}) {
    const env = o.env ?? process.env
    this.installed = o.installed ?? installedVersion()
    this.kind = o.kind ?? detectInstallKind({ env })
    this.disabled = env.SILOS_NO_UPDATE_CHECK === '1' || env.SILOS_NO_UPDATE_CHECK === 'true'
    this.ttlMs = o.ttlMs ?? DAY_MS
    this.fetchLatest = o.fetchLatest ?? fetchLatestFromNpm
  }

  /** The current reading, refreshing in the background when stale — the
   *  caller never waits on the network. */
  status(now = Date.now()): UpdateStatus {
    if (!this.disabled && now - this.checkedAt >= this.ttlMs && !this.inflight) {
      this.inflight = this.fetchLatest()
        .then((v) => {
          this.latest = v ?? this.latest
          this.checkedAt = Date.now()
        })
        .catch(() => {
          this.checkedAt = Date.now()
        })
        .finally(() => {
          this.inflight = null
        })
    }
    const latest = this.disabled ? null : this.latest
    return {
      installed: this.installed,
      kind: this.kind,
      latest,
      newer: latest !== null && isNewer(this.installed, latest),
      how: howToUpdate(this.kind),
    }
  }
}
