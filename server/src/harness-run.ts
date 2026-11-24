// harness-run.ts — what every engine's version row and probe share: the
// process runner (RunFn, defaultRun), version parsing and comparison, the
// `--version` probe, and the status row of a non-Claude engine. A leaf:
// it imports no engine and no part of harness.ts (only types from
// harnesses/contract.ts), so harness.ts and the harnesses/<id>/version.ts
// files can all import it without a cycle.
import { execFile } from 'node:child_process'
import type { HarnessId } from './harnesses/contract.js'

export interface RunResult {
  stdout: string
  stderr: string
}
// throws on a non-zero exit / timeout; the error may carry stdout/stderr.
export type RunFn = (cmd: string, args: string[], opts: { timeoutMs: number }) => Promise<RunResult>

/** Another harness Silos drives (OpenCode today): one binary, its version
 *  (null = not installed / unreadable), where it is, no published-latest
 *  lookup (null — the UI says nothing about "up to date"). */
export interface OtherHarnessStatus {
  harness: HarnessId
  name: string
  version: string | null
  path: string | null
  latest: null
}

export const VERSION_MS = 15_000

export const defaultRun: RunFn = (cmd, args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CI: '1', NO_COLOR: '1' } }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
      else resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })

// "2.1.304 (Claude Code)" → "2.1.304"; anything without a x.y.z → null.
export function parseVersion(text: string): string | null {
  const m = /\b(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/.exec(text)
  return m ? m[1]! : null
}

// numeric x.y.z comparison (a prerelease suffix is ignored): >0 when a is newer.
export function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0]!.split('.').map(Number)
  const pb = b.split('-')[0]!.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

// ---------------------------------------------------------------------------
// Compatibility: Silos declares the engine versions it needs
// and never tolerates an older one with fallbacks. Each adapter states its
// minimum and reads its installed version; the verdict says what is
// installed, what is needed and the exact command that fixes it.
// ---------------------------------------------------------------------------

/** What Silos refuses to start on an engine: its consoles, its chat turns. */
export type CompatPart = 'console' | 'chat'

/** One engine's compatibility verdict (GET /api/harness `compat`).
 *  ok — installed ≥ needed. outdated — older than Silos needs. missing — not
 *  installed, or no version could be read. ahead — newer than the client
 *  library Silos ships for it (Claude Code: the Agent SDK pinned in
 *  server/package.json); Silos itself needs the update. `refuses` names what
 *  Silos won't start on it (empty = it runs); `message` is the one line said
 *  wherever the engine is refused or shown (null when ok). */
export interface EngineCompat {
  harness: HarnessId
  name: string
  state: 'ok' | 'outdated' | 'missing' | 'ahead'
  installed: string | null
  needed: string
  /** The exact command that fixes it (null when ok). */
  update: string | null
  refuses: CompatPart[]
  message: string | null
}

/** A chat turn the compat gate refused (chat-service.ts): the verdict's one
 *  line as its message. Typed so the unattended lanes (resident: messages,
 *  task turns, runs) HOLD the work for the engine instead of counting a
 *  failure — the engineCompat row is what the owner hears. */
export class EngineRefusedError extends Error {
  constructor(
    message: string,
    readonly harness: HarnessId,
  ) {
    super(message)
  }
}
/** A turn refused at send time is tried again after this when no up-front
 *  reading (harness.ts peekRefusal) says the engine is ok again. */
export const ENGINE_RETRY_MS = 5 * 60_000

/** The minimum check every engine shares: missing / outdated / ok. Both an
 *  older and a missing binary refuse consoles and chat turns alike. */
export function minimumVerdict(f: {
  harness: HarnessId
  name: string
  installed: string | null
  needed: string
  update: string
  install: string
}): EngineCompat {
  const base = { harness: f.harness, name: f.name, installed: f.installed, needed: f.needed }
  if (f.installed === null) {
    return {
      ...base,
      state: 'missing',
      update: f.install,
      refuses: ['console', 'chat'],
      message: `Silos can't find ${f.name} (not on its PATH, or its version can't be read) — Silos needs ${f.name} ${f.needed} or newer. Not installed: ${f.install} · Installed: restart Silos from a shell where it runs`,
    }
  }
  if (compareVersions(f.installed, f.needed) < 0) {
    return {
      ...base,
      state: 'outdated',
      update: f.update,
      refuses: ['console', 'chat'],
      message: `${f.name} ${f.installed} is older than Silos needs (${f.needed}) — update it: ${f.update}`,
    }
  }
  return { ...base, state: 'ok', update: null, refuses: [], message: null }
}

// `<cmd> --version` → x.y.z; a failed run or no version on stdout → null.
// Shared by both engines' version rows (harnesses/<id>/version.ts).
export async function versionOf(run: RunFn, cmd: string): Promise<string | null> {
  try {
    const r = await run(cmd, ['--version'], { timeoutMs: VERSION_MS })
    return parseVersion(r.stdout)
  } catch {
    return null
  }
}
