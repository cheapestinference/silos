// peer-registry.ts — the cross-session ADDRESS of a conversation: the name
// Claude Code's ListAgents/SendMessage use to reach a running session
// ("silos-1f", "acme-91"). Claude Code keeps one
// ~/.claude/sessions/<pid>.json per process (sessionId, cwd, name, status,
// pid…); the bracketed [ref] ListAgents prints beside the name is NOT in
// that file (verified 26-08: no hash of any stored field yields it), so
// only the name travels — it is enough to address a session unless two
// share it. Read-only over foreign data (invariant 3); a dead process's
// file (Claude Code doesn't always clean up) is skipped by a pid probe.
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface PeerAddress {
  name: string
  sessionId: string
  status?: string
}

const TTL_MS = 5_000

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export class PeerRegistry {
  private cache: { at: number; map: Map<string, PeerAddress> } | null = null

  constructor(
    private readonly dir: string = join(homedir(), '.claude', 'sessions'),
    private readonly isAlive: (pid: number) => boolean = defaultIsAlive,
    private readonly now: () => number = Date.now,
  ) {}

  // sessionId → address, for LIVE processes only. Cached for a few seconds:
  // the overview asks per request and the directory holds a hundred files.
  bySession(): Map<string, PeerAddress> {
    const t = this.now()
    if (this.cache && t - this.cache.at < TTL_MS) return this.cache.map
    const map = new Map<string, PeerAddress>()
    const seenAt = new Map<string, number>()
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      names = []
    }
    for (const f of names) {
      if (!f.endsWith('.json')) continue
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Record<string, unknown>
      } catch {
        continue
      }
      const { sessionId, name, pid, status, updatedAt } = raw
      if (typeof sessionId !== 'string' || typeof name !== 'string' || name === '') continue
      if (typeof pid !== 'number' || !this.isAlive(pid)) continue
      const at = typeof updatedAt === 'number' ? updatedAt : 0
      // one session can be re-registered by a newer process (a resume):
      // the most recently updated file wins.
      if ((seenAt.get(sessionId) ?? -1) > at) continue
      seenAt.set(sessionId, at)
      const addr: PeerAddress = { name, sessionId }
      if (typeof status === 'string') addr.status = status
      map.set(sessionId, addr)
    }
    this.cache = { at: t, map }
    return map
  }
}
