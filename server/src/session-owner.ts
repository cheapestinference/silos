import type { SessionMeta } from './types.js'
import type { AgentRegistry } from './agent-registry.js'
import type { NativeStore } from './native-store.js'
import type { LineageStore } from './lineage.js'
import { buriedFacts } from './harnesses/claude-code/trash.js'
import { makeAncestry, type Ancestry } from './ancestry.js'
import type { Birth } from './births-store.js'
import { harnessById, harnessForId } from './harnesses/registry.js'

// session-owner.ts — WHO a session belongs to. ONE rule for every surface
// (overview, sidebar counts, titler, resident's conversation triggers):
//
//   1. a Silos-born session belongs to its birth agent (native.json);
//   1a. a session the OpenCode reader read from an agent's OWN database
//      (agents/<id>/opencode.db) belongs to <id> — that agent's env is the
//      only one that writes there (reader.ts agentOfDb);
//   1b. a session that presented itself at START (the plugin's birth
//      marker, births-store.ts — `source: startup`) belongs to the agent
//      whose env it was born in: a `claude -p` an agent ran from Bash.
//      A clear/resume marker is a continuation and falls to 2–3, so a
//      thread the owner moved (native.json on its root) keeps moving;
//   2. an inheritance already written down stands (lineage.json owners);
//   3. a continuation (/clear rotation, `--resume` fork — Claude Code
//      writes a NEW file with no marker of its own) belongs to whoever its
//      origin belongs to, through ancestors the owner has buried;
//   4. a root is classified by its own transcript (cwd + skills).
//
// The answer is WRITTEN DOWN (lineage.owners) the moment a continuation
// resolves with certainty — i.e. from a record, or from an origin that is
// a true root (nothing above it) — so burying the origin (Maintenance,
// a mass trash) or purging it (30 days) never changes the owner. An
// uncertain answer (the chain ends in an ancestor the index doesn't hold
// yet, or never will) is the folder's default and is NOT written: when
// the ancestor lands (warm-up) the thread follows it. A buried origin is
// read from the trash once and the answer recorded — the self-healing of
// chains broken before this rule existed (e.g. a Builder thread read as
// Writer after Writer's history was mass-trashed with the thread's root in it).
interface Resolved {
  id: string
  certain: boolean
}
// how late a birth marker may land after its session's transcript was born
const BIRTH_GRACE_MS = 120_000
interface Buried {
  cwd: string | null
  skills: string[]
  resumedFrom: string | null
}

export interface SessionOwnersDeps {
  registry: AgentRegistry
  native: NativeStore
  lineage: LineageStore | null
  // metaById: the index's O(1) lookup (session-index.ts) — every hop of
  // every walk asks it; without it, a search of allSessions()
  index: { allSessions(): SessionMeta[]; metaById?(id: string): SessionMeta | null }
  // <dataDir>/trash — where a buried origin's transcript can still be read.
  trashDir: string | null
  // the plugin's birth markers (births-store.ts) — optional: without it
  // no session is nested and rule 1b never fires.
  births?: { get(sessionId: string): Birth | null } | null
  // the OpenCode reader's agent DBs (reader.ts agentOfDb): the agent whose
  // own opencode.db holds this session, or null (global DB / not OpenCode).
  agentOfDb?: (sessionId: string) => string | null
  // the OpenCode reader's contest list (reader.ts isContested): an `ses_`
  // id held by more than one DB. A native record for such an id is not
  // honoured — it may have been sealed for the copy that won the
  // registrar's sweep before the other DB was discovered.
  isContested?: (sessionId: string) => boolean
}

export class SessionOwners {
  readonly ancestry: Ancestry
  // a buried transcript is parsed once per process (its answer is then
  // recorded; the parse itself can be a 20 MB read).
  private buried = new Map<string, Buried | null>()
  constructor(private deps: SessionOwnersDeps) {
    this.ancestry = makeAncestry({ lineage: deps.lineage, metaById: (id) => this.metaById(id) })
  }

  private metaById(id: string): SessionMeta | null {
    const index = this.deps.index
    return index.metaById ? index.metaById(id) : (index.allSessions().find((s) => s.id === id) ?? null)
  }

  agentIdOf(m: SessionMeta): string {
    return this.resolve(m, 0).id
  }

  // A session an AGENT launched, not Silos: it presented itself at start
  // (a `startup` birth marker) and Silos holds no native record of having
  // launched it. Such a session is nested under `parent` (the conversation
  // whose claude ran it) or, parent unknown, under its agent — never one
  // of the owner's conversations. A clear/resume marker is a continuation
  // of a thread, not a new launch.
  //
  // Not followed (deliberately, for now): an agent's `claude --resume X`
  // or `-c` writes a resume marker — a continuation, never a birth — so a
  // nested resume of the agent's own run is not folded (deferred).
  // A grandchild inherits the TOP conversation's
  // SILOS_SESSION_ID (a nested claude doesn't overwrite it), so it folds
  // under that conversation, not under its direct parent.
  nestedBirthOf(m: SessionMeta): Birth | null {
    const b = this.startupBirth(m)
    if (!b || this.deps.native.get(m.folder, m.id)) return null
    return b
  }

  // A nested session as surfaces paint it: its agent, and the EFFECTIVE
  // parent conversation — or null (loose: it belongs to the agent).
  //  · the named parent must be indexed and resolve to the SAME agent, so
  //    an agent can never push rows into another agent's (or the owner's)
  //    column;
  //  · a console keeps the key it was launched with as SILOS_SESSION_ID
  //    across `/clear`, so the parent is the thread's session that was
  //    current when the marker landed: among the named session and its
  //    indexed continuation descendants (rotations and /clear children
  //    alike), the newest one started by the marker's ctime.
  // Only nested sessions pay the descendant scan; every other session
  // stops at the births lookup.
  nestedOf(m: SessionMeta): { agentId: string; parent: string | null } | null {
    const b = this.nestedBirthOf(m)
    return b ? { agentId: b.agentId, parent: this.effectiveParent(b) } : null
  }

  private effectiveParent(b: Birth): string | null {
    if (!b.parent) return null
    const all = this.deps.index.allSessions()
    const named = this.metaById(b.parent)
    if (!named || this.agentIdOf(named) !== b.agentId) return null
    // the thread below `named`: one children map (the same continuation
    // links ancestry.ts walks up — lineage first, the transcript's
    // resumedFrom else), then a bounded walk down
    const cont = this.deps.lineage?.continuationParents() ?? new Map<string, string | null>()
    const children = new Map<string, SessionMeta[]>()
    for (const d of all) {
      const p = cont.get(d.id) ?? d.resumedFrom ?? null
      if (!p) continue
      const list = children.get(p)
      if (list) list.push(d)
      else children.set(p, [d])
    }
    let best = named
    let bestStart = named.startedAt ?? -Infinity
    const seen = new Set<string>([named.id])
    const queue = [named]
    while (queue.length > 0 && seen.size < 256) {
      for (const d of children.get(queue.shift()!.id) ?? []) {
        if (seen.has(d.id)) continue
        seen.add(d.id)
        queue.push(d)
        if (d.startedAt === undefined || d.startedAt > b.ctimeMs || d.startedAt <= bestStart) continue
        if (this.agentIdOf(d) !== b.agentId) continue
        best = d
        bestStart = d.startedAt
      }
    }
    return best.id
  }

  // A startup marker this session can trust: it landed (ctime) no later
  // than BIRTH_GRACE_MS after the session's transcript was born. Session
  // ids are random UUIDs — nobody can plant a marker before the session
  // exists — so a late marker is a forgery naming an existing session.
  // A transcript with no birth time can't be checked: no trust.
  // Session ids are not secret (~/.claude/projects is readable by the same
  // uid), so the window alone would let an agent claim the owner's
  // `--resume` forks and `/clear` rotations, which carry no native record
  // and no genuine marker. A genuine nested `claude -p` is never a
  // continuation: a session with `resumedFrom`, a lineage continuation
  // parent, or started by /clear never trusts a startup marker.
  private startupBirth(m: SessionMeta): Birth | null {
    const b = this.deps.births?.get(m.id) ?? null
    if (!b || b.source !== 'startup') return null
    if (m.resumedFrom || m.startedByClear || this.deps.lineage?.continuationParentIdOf(m.id)) return null
    if (m.startedAt === undefined || b.ctimeMs > m.startedAt + BIRTH_GRACE_MS) return null
    return b
  }

  // Before `id` is buried: write down the owner of every indexed descendant
  // that can be resolved with certainty NOW (the origin is still readable).
  // Returns the ids whose owner is on record afterwards.
  stampDescendantsOf(id: string): string[] {
    const out: string[] = []
    for (const d of this.deps.index.allSessions()) {
      if (d.id === id || !this.ancestry.ancestorIdsOf(d, true).includes(id)) continue
      this.resolve(d, 0)
      if (this.deps.lineage?.ownerOf(d.id)) out.push(d.id)
    }
    return out
  }

  private activeAgent(id: string | null | undefined): string | null {
    const a = id ? this.deps.registry.get(id) : null
    return a && !a.archived ? a.id : null
  }

  // native.json's agent for a session — unless it is a contested OpenCode id
  private nativeAgent(folder: string, id: string): string | null {
    if (!harnessById(harnessForId(id)).fallback && this.deps.isContested?.(id)) return null
    return this.activeAgent(this.deps.native.get(folder, id)?.agentId)
  }

  private resolve(m: SessionMeta, depth: number): Resolved {
    const born = this.nativeAgent(m.folder, m.id)
    if (born) return { id: born, certain: true }
    const inOwnDb = this.activeAgent(this.deps.agentOfDb?.(m.id))
    if (inOwnDb) return { id: inOwnDb, certain: true }
    const presented = this.activeAgent(this.startupBirth(m)?.agentId)
    if (presented) return { id: presented, certain: true }
    const remembered = this.activeAgent(this.deps.lineage?.ownerOf(m.id))
    if (remembered) return { id: remembered, certain: true }
    const origin = depth < 8 ? this.ancestry.nearestIndexedAncestor(m, true) : null
    if (origin) return this.inherit(m, this.resolve(origin, depth + 1))
    const ids = this.ancestry.ancestorIdsOf(m, true)
    if (ids.length === 0) return { id: this.classifyRoot([m.id], m), certain: true }
    return this.inherit(m, this.resolveBuried(m, ids, depth))
  }

  // The chain ends above the index: its farthest known ancestor is buried
  // (trash) or gone. Walk up through buried transcripts — a `--resume`
  // twin names ITS origin (resumedFrom) — until one is back in the index
  // (then it decides) or has a Silos birth record (native.json). Failing
  // both, the NEAREST buried transcript decides, with certainty: a twin
  // copies its parent's whole history, so its cwd and skills are the
  // origin's evidence and more. Nothing readable at all: the folder's
  // default, uncertain (the file may still land in the trash, or the
  // ancestor in the index).
  private resolveBuried(m: SessionMeta, ids: string[], depth: number): Resolved {
    const seen = new Set<string>([m.id, ...ids])
    let cur = ids[ids.length - 1] as string
    // every id of the chain, nearest first: the farthest is the thread's
    // root as far as anything is known — its branches must not split.
    const chain = [m.id, ...ids]
    let folder = this.deps.lineage?.folderOfKnown(cur) ?? m.folder
    let evidence: Buried | null = null
    for (let i = 0; i < 8; i++) {
      const b = this.readBuried(cur, folder)
      if (!b) break
      evidence ??= b
      const born = this.nativeAgent(folder, cur)
      if (born) return { id: born, certain: true }
      const up = b.resumedFrom
      if (!up || seen.has(up)) break
      seen.add(up)
      const meta = this.metaById(up)
      if (meta && depth < 8) return this.resolve(meta, depth + 1)
      folder = this.deps.lineage?.folderOfKnown(up) ?? folder
      cur = up
      chain.push(up)
    }
    const roots = [...chain].reverse()
    if (evidence) return { id: this.classifyRoot(roots, { cwd: evidence.cwd, folder, skills: evidence.skills }), certain: true }
    return { id: this.classifyRoot(roots, m), certain: false }
  }

  // A root's transcript classified. A match through a SECONDARY territory
  // (Agent.folders) never overrides a chain that already has an owner on
  // record: an external root is classified fresh on every read while its
  // descendants' inheritance was written down — declaring a folder later
  // must not split one thread between two owners. `rootIds`: the chain's
  // ids, farthest (the root) first; the first one with a recorded
  // descendant decides. A primary-folder match is unchanged.
  private classifyRoot(rootIds: string[], meta: { cwd: string | null; folder: string; skills: string[] }): string {
    const { agent, via } = this.deps.registry.classifyWithRule(meta)
    if (via !== 'secondary' || !this.deps.lineage) return agent.id
    const below = this.descendantOwners()
    for (const id of rootIds) {
      for (const o of below.get(id) ?? []) {
        const owner = this.activeAgent(o)
        if (owner) return owner
      }
    }
    return agent.id
  }

  // ancestor id → the owners recorded for its descendants, built in ONE
  // pass: walk up (the same continuation rule and bound as ancestry.ts)
  // from every session that HAS a recorded owner — never from all
  // sessions — with one id → meta map for every hop. Memoized until
  // lineage.json changes (its revision): every owner write bumps it, and
  // nothing else can add a recorded descendant.
  private descOwners: { rev: number; map: Map<string, string[]> } | null = null
  private descendantOwners(): Map<string, string[]> {
    const lineage = this.deps.lineage
    if (!lineage) return new Map()
    if (this.descOwners?.rev === lineage.revision) return this.descOwners.map
    const metas = new Map(this.deps.index.allSessions().map((s) => [s.id, s]))
    const cont = lineage.continuationParents()
    const map = new Map<string, string[]>()
    for (const [id, owner] of lineage.ownerEntries()) {
      const seen = new Set<string>([id])
      let cur = id
      for (let hop = 0; hop < 8; hop++) {
        const next = cont.get(cur) ?? metas.get(cur)?.resumedFrom ?? null
        if (!next || seen.has(next)) break
        seen.add(next)
        const list = map.get(next)
        if (list) list.push(owner)
        else map.set(next, [owner])
        cur = next
      }
    }
    this.descOwners = { rev: lineage.revision, map }
    return map
  }

  private inherit(m: SessionMeta, from: Resolved): Resolved {
    if (from.certain) this.deps.lineage?.recordOwner(m.id, from.id)
    return from
  }

  // The transcript of a buried session, from the trash: the newest copy of
  // `<trashDir>/<folder>/<id>[-n].jsonl` (SessionStore.trash suffixes a
  // second burial of the same id), in the folder lineage recorded it under
  // or, for an id lineage never saw (a twin's resumedFrom), the caller's
  // hint. null when there is none.
  private readBuried(id: string, folderHint: string): Buried | null {
    if (this.buried.has(id)) return this.buried.get(id) as Buried | null
    const folder = this.deps.lineage?.folderOfKnown(id) ?? folderHint
    const result: Buried | null = this.deps.trashDir ? buriedFacts(this.deps.trashDir, folder, id) : null
    // not found: NOT memoized — the file may land in the trash later
    if (result) this.buried.set(id, result)
    return result
  }
}
