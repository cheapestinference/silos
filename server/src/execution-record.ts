// execution-record.ts — reads the "SDD ledger" into an ExecutionRecord.
// The ledger is `.superpowers/sdd/<plan>/progress.md`, a file the subagent-driven-development
// skill appends to mechanically as it executes a plan; the plan itself is a
// markdown document with `### Task N: title` headings. Silos reads both
// rather than keeping its own execution state: the files are the truth, so
// there is nothing to drift.
//
// Rules (the ledger format read):
//  - header `# SDD ledger — plan: <ref>` gives the plan reference; any other
//    first line gives none.
//  - a state line opens with a task reference (`taskRefOf`: `Task N`,
//    `Tasks 2+3`, `Task 8 (v2)`, `Task 2A`, then `:`); every number counts.
//  - `Task N: complete …` marks the task complete; the rest is its detail.
//  - `Task N: fix round R[/M] …` marks it fixing — unless a complete line
//    exists for it, before or after: complete always wins.
//  - every other line is ignored for state.
//  - the plan document gives the title (first `# `) and the task list,
//    outside fenced code blocks, first heading per number.
// Pure functions: no file system here, the store does the reading.
import type { ExecutionRecord, ExecutionRecordTask } from './types.js'

export const LEDGER_PATH_RE = /\/\.superpowers\/sdd\/[^/]+\/progress\.md$/

export function isLedgerPath(path: string): boolean {
  return LEDGER_PATH_RE.test(path)
}

export function repoRootOfLedger(ledgerPath: string): string {
  const i = ledgerPath.indexOf('/.superpowers/')
  return i < 0 ? ledgerPath : ledgerPath.slice(0, i)
}

export interface ParsedLedger {
  planRef: string | null
  tasks: Map<number, { state: 'complete' | 'fixing'; round?: number; detail?: string }>
}

function cleanDetail(rest: string): string | undefined {
  let d = rest.trim()
  // A trailing ")" is stripped only with its "(": "— e2e (after 2 fixes)" keeps its own.
  if (d.startsWith('(')) d = d.slice(1).replace(/\)$/, '')
  else d = d.replace(/^[—-]/, '')
  d = d.trim()
  return d === '' ? undefined : d
}

// The one task-reference grammar of a ledger line (final review ruling):
//   Tasks? <n>[letter]? ( [+,&-] <n>[letter]? )* ( (…) )? :
// "Task 3:", "Tasks 2+3:", "Tasks 4-6:", "Task 8 (v2):", "Task 2A:" — every
// number named or inside a range gets the line's state; a letter suffix maps
// to its bare number; the
// parenthetical before the colon is ignored. Returns the numbers and the
// remainder after the colon, or null for any other line.
const TASK_REF_RE = /^Tasks? (\d+)[A-Za-z]?((?:\s*[+,&\-–]\s*\d+[A-Za-z]?)*)(?:\s*\([^)]*\))?:\s*(.*)$/

// A ledger is written by agents: a range wider than any plan keeps its two ends
// rather than filling memory.
const MAX_RANGE = 200

export function taskRefOf(line: string): { numbers: number[]; rest: string } | null {
  const m = TASK_REF_RE.exec(line)
  if (!m) return null
  const numbers = [Number(m[1])]
  for (const [, sep, digits] of (m[2] ?? '').matchAll(/\s*([+,&\-–])\s*(\d+)/g)) {
    const n = Number(digits)
    const from = numbers[numbers.length - 1]!
    if ((sep === '-' || sep === '–') && n > from && n - from <= MAX_RANGE) {
      for (let i = from + 1; i < n; i++) numbers.push(i)
    }
    numbers.push(n)
  }
  return { numbers: [...new Set(numbers)], rest: m[3] ?? '' }
}

export function parseLedger(text: string): ParsedLedger {
  const out: ParsedLedger = { planRef: null, tasks: new Map() }
  const lines = text.split(/\r?\n/)
  const head = /^# SDD ledger — plan:\s*(.+)$/.exec(lines[0] ?? '')
  if (head) out.planRef = (head[1] ?? '').trim()
  for (const line of lines) {
    const ref = taskRefOf(line)
    if (!ref) continue
    const done = /^complete\b\s*(.*)$/.exec(ref.rest)
    if (done) {
      const detail = cleanDetail(done[1] ?? '')
      for (const n of ref.numbers) out.tasks.set(n, detail ? { state: 'complete', detail } : { state: 'complete' })
      continue
    }
    const fix = /^fix round (\d+)(?:\/\d+)?\b\s*(.*)$/.exec(ref.rest)
    if (fix) {
      const detail = cleanDetail(fix[2] ?? '')
      for (const n of ref.numbers) {
        if (out.tasks.get(n)?.state === 'complete') continue
        out.tasks.set(n, detail ? { state: 'fixing', round: Number(fix[1]), detail } : { state: 'fixing', round: Number(fix[1]) })
      }
    }
  }
  return out
}

export interface ParsedPlanDoc {
  title: string | null
  tasks: { n: number; title: string }[]
}

// Headings inside fenced code blocks (``` or ~~~, closed by the same
// marker) are examples, not tasks; the FIRST heading per number wins.
export function parsePlanDoc(text: string): ParsedPlanDoc {
  let title: string | null = null
  const tasks: { n: number; title: string }[] = []
  const seen = new Set<number>()
  let fence: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const marker = /^(```|~~~)/.exec(line)?.[1]
    if (marker) {
      if (fence === null) fence = marker
      else if (fence === marker) fence = null
      continue
    }
    if (fence !== null) continue
    if (title === null) {
      const h = /^# (.+)$/.exec(line)
      if (h) {
        title = (h[1] ?? '').trim()
        continue
      }
    }
    const t = /^### Task (\d+): (.+)$/.exec(line)
    if (t) {
      const n = Number(t[1])
      if (seen.has(n)) continue
      seen.add(n)
      tasks.push({ n, title: (t[2] ?? '').trim() })
    }
  }
  return { title, tasks }
}

export interface RecordInput {
  ledgerPath: string
  ledger: string
  ledgerMtime: number
  planPath: string | null
  plan: string | null
  gone: boolean
}

export function buildRecord(input: RecordInput): ExecutionRecord {
  const ledger = parseLedger(input.ledger)
  const doc = input.plan === null ? null : parsePlanDoc(input.plan)
  const byN = new Map<number, ExecutionRecordTask>()
  for (const t of doc?.tasks ?? []) byN.set(t.n, { n: t.n, title: t.title, state: 'pending' })
  for (const [n, l] of ledger.tasks) {
    const task: ExecutionRecordTask = { n, title: byN.get(n)?.title ?? null, state: l.state }
    if (l.round !== undefined) task.round = l.round
    if (l.detail !== undefined) task.detail = l.detail
    byN.set(n, task)
  }
  const tasks = [...byN.values()].sort((a, b) => a.n - b.n)
  const docNumbers = doc ? new Set(doc.tasks.map((t) => t.n)) : null
  return {
    ledgerPath: input.ledgerPath,
    planPath: input.planPath,
    planTitle: doc?.title ?? null,
    tasks,
    // with a document, done counts only the tasks it names (a "Task 0:
    // baseline" line still lists, but is not progress against the plan)
    done: tasks.filter((t) => t.state === 'complete' && (docNumbers === null || docNumbers.has(t.n))).length,
    total: docNumbers ? docNumbers.size : null,
    updatedAt: input.ledgerMtime,
    gone: input.gone,
  }
}
