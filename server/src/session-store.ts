import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { trashTranscript } from './harnesses/claude-code/trash.js'
import { backupCorruptJson } from './json-store.js'

// Auto-titles: `titles` are the owner's MANUAL renames — sacred, never
// overwritten. `autoTitles` is the parallel field the resident's titler
// writes; the precedence (manual > auto > raw) is what makes an autoTitle
// irrelevant once the owner renames by hand — it never needs to be deleted.
interface Overrides {
  titles: Record<string, string>
  autoTitles: Record<string, string>
}

export type TitleOrigin = 'manual' | 'auto' | 'raw'

export class SessionStore {
  private overridesFile: string
  constructor(
    private root: string,
    private dataDir: string,
  ) {
    this.overridesFile = join(dataDir, 'overrides.json')
  }

  private backedUpCorrupt = false

  private readOverrides(): Overrides {
    if (existsSync(this.overridesFile)) {
      let text: string | null = null
      try {
        text = readFileSync(this.overridesFile, 'utf8')
        const raw = JSON.parse(text) as Partial<Overrides>
        // back-compat: an overrides.json written before auto-titles existed
        // has no autoTitles field (and a malformed one might not even have
        // titles) — missing field = {}, never a crash.
        return { titles: raw.titles ?? {}, autoTitles: raw.autoTitles ?? {} }
      } catch {
        // corrupt → keep the only copy ONCE (this runs per operation), then
        // start fresh: manual titles are sacred, the next write replaces
        // the file.
        if (text !== null && !this.backedUpCorrupt) {
          this.backedUpCorrupt = true
          backupCorruptJson(this.overridesFile, text, 'session titles')
        }
      }
    }
    return { titles: {}, autoTitles: {} }
  }

  private writeOverrides(o: Overrides): void {
    const tmp = this.overridesFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(o, null, 2) + '\n')
    renameSync(tmp, this.overridesFile)
  }

  titleOverride(folder: string, id: string): string | null {
    return this.readOverrides().titles[`${folder}/${id}`] ?? null
  }

  // A single read+parse of overrides.json for consumers that walk many
  // sessions (overview) instead of one per session.
  titleOverrides(): Record<string, string> {
    return this.readOverrides().titles
  }

  autoTitle(folder: string, id: string): string | null {
    return this.readOverrides().autoTitles[`${folder}/${id}`] ?? null
  }

  autoTitles(): Record<string, string> {
    return this.readOverrides().autoTitles
  }

  // The title synthesized by the titler. NEVER touches `titles` — the
  // owner's manual rename keeps following its usual path (rename()) and
  // wins by precedence even after this autoTitle gets written.
  setAutoTitle(folder: string, id: string, title: string): void {
    const o = this.readOverrides()
    o.autoTitles[`${folder}/${id}`] = title.trim().slice(0, 40)
    this.writeOverrides(o)
  }

  // Effective precedence (manual > auto > raw from the parser) with its
  // origin, in a single overrides.json read — the same resolver serves
  // overview, detail, board, and WS broadcast.
  titleResolver(): (folder: string, id: string, raw: string) => { title: string; origin: TitleOrigin } {
    const o = this.readOverrides()
    return (folder, id, raw) => {
      const key = `${folder}/${id}`
      const manual = o.titles[key]
      if (manual !== undefined) return { title: manual, origin: 'manual' }
      const auto = o.autoTitles[key]
      if (auto !== undefined) return { title: auto, origin: 'auto' }
      return { title: raw, origin: 'raw' }
    }
  }

  rename(folder: string, id: string, title: string): void {
    const o = this.readOverrides()
    const key = `${folder}/${id}`
    if (title.trim() === '') delete o.titles[key]
    else o.titles[key] = title.trim().slice(0, 120)
    this.writeOverrides(o)
  }

  async trash(folder: string, id: string): Promise<string> {
    return trashTranscript(this.root, this.dataDir, folder, id)
  }
}
