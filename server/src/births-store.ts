// births-store.ts — the plugin's birth markers, read.
//
// Every session that runs as a Silos agent presents itself at birth: the
// plugin's SessionStart hook (plugin/hooks/birth.py) writes
// agent-state/<agent>/births/<session_id>.json with the agent, the session
// that launched it ($SILOS_SESSION_ID → `parent`), its cwd and Claude
// Code's `source` (startup|resume|clear|compact). File-borne, zero tokens:
// the same truth for both engines and for a `claude -p` an agent runs from
// Bash — which is the case this exists for. Silos' own launches carry a
// native.json record too; a startup marker WITHOUT one is a nested run
// (session-owner.ts `nestedBirthOf`), folded under its parent and never
// listed as one of the owner's conversations.
//
// Trust: an agent can write anything in its OWN state dir,
// including a marker that names another agent or another session. So a
// marker counts only for the agent whose directory holds it (here), only
// if it landed early enough for the session it names (session-owner.ts:
// ctime ≤ the transcript's birth + 120 s — session ids are random UUIDs,
// a marker cannot be planted ahead of time), and its `parent` only if
// that conversation is the same agent's (session-owner.ts nestedOf).
//
// Cheap to ask per session (the overview asks for every one): a rescan is
// at most one per `ttlMs`, and it lists each births dir but reads only the
// files it has not seen (a marker is written once and never changes —
// first birth wins), plus a marker that failed to read once its file has
// changed (`pending`: a failure is never cached for good). Listing, not the dir's mtime: Linux stamps mtimes
// from a coarse clock, so two markers landing in the same tick would leave
// the second one unseen.
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { listContained, readContained } from './safe-file.js'
import type { AgentStateStore } from './agent-state.js'

/** What Silos reads of one birth marker (a few hundred bytes in practice). */
export const BIRTH_MAX_BYTES = 64 * 1024

// Only a cache key for "has this failed marker changed since?" — never what
// decides what is read (readOne goes through safe-file.ts). null = not there.
function signature(path: string): string | null {
  try {
    const st = lstatSync(path)
    return `${st.ino}:${st.nlink}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`
  } catch {
    return null
  }
}

export interface Birth {
  sessionId: string
  agentId: string
  parent: string | null
  cwd: string | null
  source: string | null
  // informational only — the file says it, so it can lie
  at: string
  // when the marker LANDED (fs ctime): the kernel's stamp, which a writer
  // cannot backdate. Every trust decision uses this, never `at`.
  ctimeMs: number
  // OpenCode markers only (plugin-opencode/silos.ts): which harness wrote
  // it, and the Silos console key it was launched in — an OpenCode console
  // can't be born under a Silos-chosen id, so the marker reports the id it
  // got (harnesses/opencode/registrar.ts seals it). Absent on Claude markers.
  harness?: string
  consoleKey?: string | null
}

const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'

function parseBirth(text: string, fileId: string, dirAgentId: string, ctimeMs: number): Birth | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.sessionId !== fileId || o.agentId !== dirAgentId || typeof o.at !== 'string') return null
  const parent = o.parent ?? null
  const cwd = o.cwd ?? null
  const source = o.source ?? null
  if (!strOrNull(parent) || !strOrNull(cwd) || !strOrNull(source)) return null
  const b: Birth = { sessionId: fileId, agentId: dirAgentId, parent: parent === '' ? null : parent, cwd, source, at: o.at, ctimeMs }
  if (typeof o.harness === 'string') b.harness = o.harness
  if (strOrNull(o.consoleKey)) b.consoleKey = o.consoleKey
  return b
}

export class BirthsStore {
  // births dir → file name → its parsed marker (null: unreadable/corrupt)
  private dirs = new Map<string, Map<string, Birth | null>>()
  private byId = new Map<string, Birth>()
  private checkedAt = -Infinity
  private warned = new Set<string>()
  private ttlMs: number
  // Markers that did NOT read (refused, half-written, corrupt) → the file's
  // stat signature when they failed. Seventh review round: a refusal was
  // cached forever, and a refusal can be transient — an older plugin's hook
  // hard-links its temp file into place and unlinks it a moment later (two
  // names for an instant, refused by safe-file.ts), a hook killed between
  // the two leaves it that way until the temp goes, and a writer may land a
  // marker's bytes after its name. So a failure is never final: the marker
  // is read again whenever its signature changes (nlink and ctime included),
  // and only then — an unchanged bad file costs an lstat per scan, not a read.
  private pending = new Map<string, string>()

  constructor(
    private agentState: AgentStateStore,
    opts: { ttlMs?: number } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 1000
  }

  get(sessionId: string): Birth | null {
    this.refresh()
    return this.byId.get(sessionId) ?? null
  }

  all(): Birth[] {
    this.refresh()
    return [...this.byId.values()]
  }

  private refresh(): void {
    const now = Date.now()
    if (this.ttlMs > 0 && now - this.checkedAt < this.ttlMs) return
    this.checkedAt = now
    let changed = false
    const seen = new Set<string>()
    for (const agentId of this.agentState.agentIdsOnDisk()) {
      // the agent's OWN births dir (safe-file.ts): a linked births/ reads
      // as none — never another agent's markers under this agent's name
      const dir = this.agentState.verifiedDir(agentId, ['births'])
      if (dir === null) continue // this agent has no births yet
      const names = listContained(dir).filter((n) => !n.startsWith('.') && n.endsWith('.json'))
      seen.add(dir)
      const known = this.dirs.get(dir) ?? new Map<string, Birth | null>()
      this.dirs.set(dir, known)
      const present = new Set(names)
      for (const name of [...known.keys()]) {
        if (!present.has(name)) {
          known.delete(name)
          this.pending.delete(join(dir, name))
          changed = true
        }
      }
      for (const name of names) {
        // a marker read and parsed is final; one that failed is read again
        // as soon as the file changes (a writer mid-way, see `pending`)
        if (known.get(name)) continue
        const key = join(dir, name)
        const sig = signature(key)
        if (known.has(name) && sig !== null && this.pending.get(key) === sig) continue
        const b = this.readOne(dir, name, name.slice(0, -'.json'.length), agentId)
        if (b === null) this.pending.set(key, sig ?? '')
        else this.pending.delete(key)
        if (!known.has(name) || b !== null) changed = true
        known.set(name, b)
      }
    }
    for (const dir of [...this.dirs.keys()]) {
      if (!seen.has(dir)) {
        this.dirs.delete(dir)
        for (const key of [...this.pending.keys()]) if (key.startsWith(dir + '/')) this.pending.delete(key)
        changed = true
      }
    }
    if (!changed) return
    // the same session claimed from two agents' dirs: one of them is lying
    // and nothing says which — trust NEITHER (ownership then falls through
    // to lineage/classify), and say so once.
    const byId = new Map<string, Birth>()
    const contested = new Set<string>()
    for (const files of this.dirs.values()) {
      for (const b of files.values()) {
        if (!b) continue
        if (byId.has(b.sessionId)) contested.add(b.sessionId)
        else byId.set(b.sessionId, b)
      }
    }
    for (const id of contested) {
      byId.delete(id)
      if (!this.warned.has(id)) {
        this.warned.add(id)
        console.warn(`births: session ${id} is claimed by more than one agent — neither marker is trusted`)
      }
    }
    this.byId = byId
  }

  // through safe-file.ts: a link or a hard link at the name (a marker
  // borrowed from elsewhere, its ctime included) is never read
  private readOne(dir: string, name: string, id: string, dirAgentId: string): Birth | null {
    try {
      const r = readContained(dir, name, { maxBytes: BIRTH_MAX_BYTES })
      return r === null ? null : parseBirth(r.data.toString('utf8'), id, dirAgentId, r.stat.ctimeMs)
    } catch {
      return null // unreadable or refused: skipped, like a corrupt one
    }
  }
}
