// Per-agent bearer tokens: the API's answer to "WHICH agent is calling".
// One file per agent at <dataDir>/agents/<id>/token (0600, 32 random bytes
// hex) — next to the agent's memory.md. Both engines receive it as
// SILOS_AGENT_TOKEN (via AgentStateStore.envFor), so an agent's curl names
// itself with `Authorization: Bearer $SILOS_AGENT_TOKEN`.
// EVERY agent has one — master included, fence on or off: the fence governs file rules, never identity.
// Authentication is against MEMORY (G8-r6): the files are loaded once at
// boot, and every mint/rotate/revoke updates memory and disk together; a
// value planted on disk after boot never authenticates (the seal with
// rotation over these files comes later).
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { secretsMatch } from './resident.js'

// Same rule as agent-state.ts: one path segment, no traversal.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** The seal over agents/<id>/token (seals.ts): a
 *  credential — written in the seal's order; a delta (planted while Silos
 *  was off, or while it runs) is ROTATED, with no row and one log line. */
export interface AgentTokensSeal {
  bootCredential(rel: string): 'ok' | 'delta' | 'none'
  writeCredential(rel: string, value: string, mode?: number): void
  remove(rel: string): void
  bindAgentTokens(rotate: (agentId: string) => void): void
}

export class AgentTokens {
  // agent id → its live token: the only thing agentIdOf compares against
  private live = new Map<string, string>()

  constructor(
    private dataDir: string,
    private seal: AgentTokensSeal | null = null,
  ) {
    this.load()
    this.seal?.bindAgentTokens((id) => {
      this.rotate(id)
    })
  }

  // boot: every token already on disk becomes the live one
  private load(): void {
    let ids: string[]
    try {
      ids = readdirSync(join(this.dataDir, 'agents'))
    } catch {
      return
    }
    for (const id of ids) {
      if (!SAFE_ID.test(id)) continue
      if (this.seal && this.seal.bootCredential(`agents/${id}/token`) === 'delta') {
        // planted while Silos was off: never served — a fresh one now
        console.log(`silos: ${id}'s bearer changed outside Silos while it was off — rotated`)
        this.write(id)
        continue
      }
      const t = this.read(join(this.dataDir, 'agents', id, 'token'))
      if (t !== null) this.live.set(id, t)
    }
  }

  private fileFor(agentId: string): string {
    if (!SAFE_ID.test(agentId)) throw new Error(`invalid agent id: ${JSON.stringify(agentId)}`)
    return join(this.dataDir, 'agents', agentId, 'token')
  }

  private read(file: string): string | null {
    try {
      const t = readFileSync(file, 'utf8').trim()
      return t === '' ? null : t
    } catch {
      return null
    }
  }

  private write(agentId: string): string {
    const file = this.fileFor(agentId)
    mkdirSync(join(this.dataDir, 'agents', agentId), { recursive: true, mode: 0o700 })
    const t = randomBytes(32).toString('hex')
    this.live.set(agentId, t)
    if (this.seal) {
      this.seal.writeCredential(`agents/${agentId}/token`, t, 0o600)
      return t
    }
    // temp + rename: a reader never sees a half-written token
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, t, { mode: 0o600 })
    renameSync(tmp, file)
    this.live.set(agentId, t)
    return t
  }

  // The live token, minted on first need. Never adopted from disk after
  // boot: a file that appeared since is overwritten by a fresh mint.
  tokenFor(agentId: string): string {
    this.fileFor(agentId) // validates the id
    return this.live.get(agentId) ?? this.write(agentId)
  }

  // A new token, in memory and on disk: the old one stops resolving at once.
  rotate(agentId: string): string {
    return this.write(agentId)
  }

  // An archived agent keeps no bearer: the file goes (it is Silos' own
  // secret, not session data — nothing to keep in the trash). A missing file
  // is fine. Unarchiving mints a NEW token on the next launch; the old one
  // never comes back. The auth hook also refuses a bearer whose agent is
  // archived or gone (server.ts), so a token left in memory by a hand edit
  // of agents.json resolves to nobody either.
  revoke(agentId: string): void {
    const file = this.fileFor(agentId)
    this.live.delete(agentId)
    if (this.seal) this.seal.remove(`agents/${agentId}/token`)
    rmSync(file, { force: true })
  }

  // Compared in memory, never read from disk per request (G8-r6).
  agentIdOf(bearer: string): string | null {
    if (bearer === '') return null
    let found: string | null = null
    for (const [id, t] of this.live) {
      // no early return: every candidate is compared, constant-time each
      if (secretsMatch(t, bearer) && found === null) found = id
    }
    return found
  }
}
