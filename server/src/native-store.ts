import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { backupCorruptJson } from './json-store.js'

export interface NativeEntry {
  agentId: string
  createdAt: string
}
interface Shape {
  sessions: Record<string, NativeEntry>
}

export class NativeStore {
  // Single writer process: caching in memory avoids re-reading native.json
  // on every get/isNative call (one per session shown in /api/overview). No
  // external invalidation needed since nothing else writes this file.
  private cache: Shape | null = null
  constructor(private file: string) {}

  private read(): Shape {
    if (this.cache) return this.cache
    let s: Shape = { sessions: {} }
    if (existsSync(this.file)) {
      let text: string | null = null
      try {
        text = readFileSync(this.file, 'utf8')
        const raw = JSON.parse(text) as Shape
        if (raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object') s = raw
        else backupCorruptJson(this.file, text, 'native sessions')
      } catch {
        // corrupt → keep the only copy, then start fresh (the next write
        // replaces the file; ownership records must never vanish silently)
        if (text !== null) backupCorruptJson(this.file, text, 'native sessions')
      }
    }
    this.cache = s
    return s
  }

  get(folder: string, id: string): NativeEntry | null {
    return this.read().sessions[`${folder}/${id}`] ?? null
  }

  isNative(folder: string, id: string): boolean {
    return this.get(folder, id) !== null
  }

  register(folder: string, id: string, entry: NativeEntry): void {
    const s = this.read()
    s.sessions[`${folder}/${id}`] = entry
    this.write(s)
  }

  /** Takes back a record written for a session that was never born (the
   *  engine refused to start before any process existed). */
  unregister(folder: string, id: string): void {
    const s = this.read()
    if (!(`${folder}/${id}` in s.sessions)) return
    delete s.sessions[`${folder}/${id}`]
    this.write(s)
  }

  private write(s: Shape): void {
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n')
    renameSync(tmp, this.file)
    this.cache = s
  }
}
