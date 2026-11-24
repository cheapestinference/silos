// harnesses/opencode/hidden — Silos' "trash" for OpenCode sessions. Their
// rows live in a database Silos did not create and never writes (invariant
// 3), so deleting one HIDES it: `<dataDir>/hidden/opencode.json` maps
// sessionId → ISO time it was hidden. Like the trash, an entry lapses after
// 30 days (trash-purge.ts) — the session shows again if OpenCode still has it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const HIDDEN_DAYS = 30
const HIDDEN_MS = HIDDEN_DAYS * 86_400_000

export class HiddenList {
  private readonly file: string
  private entries: Record<string, string> = {}

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = join(dataDir, 'hidden', 'opencode.json')
    this.load()
  }

  private lapsed(at: string): boolean {
    const ms = Date.parse(at)
    return !Number.isFinite(ms) || this.now() - ms > HIDDEN_MS
  }

  // Lapsed (or unreadable) entries are dropped on load and the file rewritten.
  private load(): void {
    if (!existsSync(this.file)) return
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    let dropped = false
    for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof at === 'string' && !this.lapsed(at)) this.entries[id] = at
      else dropped = true
    }
    if (dropped) this.save()
  }

  has(id: string): boolean {
    const at = this.entries[id]
    return at !== undefined && !this.lapsed(at)
  }

  add(id: string): void {
    this.entries[id] = new Date(this.now()).toISOString()
    this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.entries, null, 2))
    renameSync(tmp, this.file)
  }
}
