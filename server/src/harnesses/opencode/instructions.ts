// harnesses/opencode/instructions.ts — Harness.instructions for OpenCode:
// what its launch passes (spec memory-places T2), READ-ONLY — the project's
// AGENTS.md / CLAUDE.md / CONTEXT.md by OpenCode's own rule (launch.ts
// projectInstructions: the first name found from the folder up to its
// worktree) and the operator's global ~/.config/opencode/AGENTS.md. No row
// is editable and no new file has a place: Memory shows them, Silos writes
// none of them for this engine.
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { InstructionRow, InstructionsInput, InstructionsList } from '../contract.js'
import { projectInstructions } from './launch.js'
import { worktreeOf } from './worktree.js'

const READ_ONLY = 'OpenCode reads it as its launch passes it — Silos shows it, never writes it'
const LAUNCHES: InstructionRow['reach']['launches'] = ['console', 'chat', 'wake', 'run', 'run-inherits']
const realOf = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

export async function opencodeInstructions(input: InstructionsInput): Promise<InstructionsList> {
  const { folder, home } = input
  const shown = (p: string): string => {
    if (folder !== null) {
      const r = relative(folder, p)
      if (r !== '' && !r.startsWith('..') && !isAbsolute(r)) return r
    }
    const h = relative(home, p)
    return h !== '' && !h.startsWith('..') && !isAbsolute(h) ? `~/${h}` : p
  }
  const rows: InstructionRow[] = []
  const add = (path: string, origin: InstructionRow['origin'], reach: InstructionRow['reach']): void => {
    let s
    try {
      s = statSync(path)
    } catch {
      return
    }
    if (!s.isFile()) return
    const real = realOf(path)
    if (rows.some((r) => r.real === real)) return
    rows.push({
      path,
      real,
      rel: shown(path),
      origin,
      kind: 'launch',
      engineType: null,
      reach,
      when: { at: 'start' },
      weight: { chars: s.size, tokens: Math.round(s.size / 4), as: 'disk' },
      bytes: s.size,
      mtime: s.mtimeMs,
      editable: false,
      readOnly: READ_ONLY,
    })
  }
  if (folder !== null) {
    let worktree = folder
    try {
      worktree = worktreeOf(folder)
    } catch {
      /* not a repo: the folder itself */
    }
    for (const p of projectInstructions(folder, worktree)) {
      const here = dirname(realOf(p)) === realOf(folder)
      add(p, here ? 'project' : 'above', here ? { scope: 'project', launches: LAUNCHES } : { scope: 'under', under: dirname(p), launches: LAUNCHES })
    }
  }
  add(join(home, '.config', 'opencode', 'AGENTS.md'), 'machine', { scope: 'machine', launches: LAUNCHES })
  return { engine: 'OpenCode', folder, rows, places: [], notes: [] }
}

export async function readOpencodeInstruction(input: InstructionsInput, path: string): Promise<{ row: InstructionRow; content: string }> {
  const list = await opencodeInstructions(input)
  const real = realOf(resolve(path))
  const row = list.rows.find((r) => r.real === real || r.path === path)
  if (!row) throw new Error('not listed')
  return { row, content: readFileSync(row.real, 'utf8') }
}
