import { homedir } from 'node:os'
import { join } from 'node:path'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { Config } from './types.js'
import { claudeManagedSettingsDir } from './plugin-enablement.js'

export function defaultConfig(): Config {
  return {
    root: process.env.SILOS_ROOT ?? join(homedir(), '.claude', 'projects'),
    dataDir: process.env.SILOS_DATA_DIR ?? join(homedir(), '.silos'),
    // Loopback by default (CLAUDE.md invariant 1: transcripts hold secrets,
    // the reverse proxy/tunnel is what exposes the instance). SILOS_HOST=0.0.0.0
    // is for containers (Railway/Docker), where the platform's own proxy is
    // the only way in and auth is still enforced per request (server.ts).
    host: process.env.SILOS_HOST ?? '127.0.0.1',
    // PORT is what every PaaS injects (Railway, Render, Fly…); SILOS_PORT wins.
    port: Number(process.env.SILOS_PORT ?? process.env.PORT ?? 3210),
    liveMs: 120_000,
    // SILOS_WEB_DIST exists so that tests
    // (npm run e2e) don't clobber the bundle served in production — the E2E
    // harness builds to web/dist-e2e and points here instead of the
    // web/dist that the real `npm run dev` serves (see web/e2e/helpers.ts).
    // Without an override, the default stays the same as always: web/dist
    // relative to this file.
    webDist: process.env.SILOS_WEB_DIST ?? join(import.meta.dirname, '..', '..', 'web', 'dist'),
    // Silos Graph: the disk sources (claude-plugins.ts, claude-mcp.ts) and
    // their watchers read from here, never os.homedir() directly — SILOS_HOME
    // is what lets tests and the E2E harness point them at a fake home
    // instead of the real ~/.claude.
    home: process.env.SILOS_HOME ?? homedir(),
    // Claude Code's managed-settings directory (managed-settings.json +
    // managed-settings.d/) — read-only; its enabledPlugins wins over every
    // other file (plugin-enablement.ts). SILOS_CLAUDE_MANAGED_DIR lets tests
    // and the E2E harness point it elsewhere.
    claudeManagedDir: process.env.SILOS_CLAUDE_MANAGED_DIR ?? claudeManagedSettingsDir(),
  }
}

export function ensureData(cfg: Config): { token: string } {
  // 0700: transcripts with secrets end up under trash/, and the source tree is already 0700 — ours shouldn't be any less strict.
  for (const d of [cfg.dataDir, join(cfg.dataDir, 'cache'), join(cfg.dataDir, 'trash')]) {
    mkdirSync(d, { recursive: true, mode: 0o700 })
  }
  // mkdir's mode only applies to a directory it creates: one that was already
  // there (made by hand, by an older Silos, under a loose umask) is closed
  // here, at every start. Not ours to chmod (another user's) = left as it is;
  // `silos doctor` says so.
  try {
    chmodSync(cfg.dataDir, 0o700)
  } catch {
    /* not the owner */
  }
  const tokenFile = join(cfg.dataDir, 'token')
  // SILOS_TOKEN: fix the access token from the environment (PaaS deploys set
  // it in the dashboard instead of reading the volume). It's also persisted
  // to the token file so everything that reads the file (docs, scripts) stays
  // consistent; setting a new value rotates it. Empty/whitespace = unset.
  const envToken = process.env.SILOS_TOKEN?.trim()
  if (envToken) {
    if (!existsSync(tokenFile) || readFileSync(tokenFile, 'utf8').trim() !== envToken) {
      writeFileSync(tokenFile, envToken, { mode: 0o600 })
    }
    return { token: envToken }
  }
  if (!existsSync(tokenFile)) {
    writeFileSync(tokenFile, randomBytes(16).toString('hex'), { mode: 0o600 })
  }
  return { token: readFileSync(tokenFile, 'utf8').trim() }
}
