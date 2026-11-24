// automation-words.ts — an automation said in plain words: what it runs (a
// command's argv, a turn's first sentence) and when (its trigger). The ONE
// wording for both sides: the server's proposal sheet says a proposed automation
// with it (proposals-view.ts — Home, the digest, the doorbell) and the
// web's automation surfaces re-export the argv and gist helpers
// (web/src/lib/automations.ts), so a proposal reads the same as the
// automation it becomes. Pure: no node imports (the web bundles this file).
import type { Trigger } from './automations-types.js'
import { humanCron } from './cron-summary.js'
import { periodWords } from './period.js'

// one argument as the owner would type it: quoted only when it has to be
function quoteArg(arg: string): string {
  if (arg !== '' && !/[\s'"\\]/.test(arg)) return arg
  if (!arg.includes("'")) return `'${arg}'`
  return `"${arg.replace(/(["\\])/g, '\\$1')}"`
}

// the whole argv, literal — the editor's field and the page's full line
export function argvLine(argv: readonly string[]): string {
  return argv.map(quoteArg).join(' ')
}

// the belonging sentence's short form: paths by their last name
// ("/usr/bin/python3 /home/u/finance/stripe_sales_sync.py" → "python3
// stripe_sales_sync.py"), cut to a measure — the literal line is one click away
export function argvShort(argv: readonly string[], max = 64): string {
  const short = argv
    .map((x) => {
      const tail = x.includes('/') && !x.endsWith('/') ? x.slice(x.lastIndexOf('/') + 1) : x
      return quoteArg(tail)
    })
    .join(' ')
  return short.length > max ? `${short.slice(0, max - 1)}…` : short
}

// The inventory list (AutomationsList.tsx) shows each automation's gist
// under its name: the prompt's FIRST SENTENCE, literal, trimmed to a
// measure. Nothing clever — no rewriting, no stripping of role preambles:
// the owner reads what the automation reads. A sentence ends at ". " / "! "
// / "? " or a newline (a dot inside "glm-5.2" or "30-09" is not an end).
export function promptGist(prompt: string, max = 140): string {
  const clean = prompt.replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  const first = /^(.*?[.!?])(?:\s|$)/.exec(clean)?.[1] ?? clean
  if (first.length <= max) return first
  const cut = first.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}…`
}

// a path's last name ("/home/u/finance/" → "finance"); the path itself when it has none
export function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  return i >= 0 && i < trimmed.length - 1 ? trimmed.slice(i + 1) : path
}

function onceWords(at: string): string {
  const ms = Date.parse(at)
  if (Number.isNaN(ms)) return `once at ${at}`
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `once on ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}:${p(d.getMinutes())}`
}

const RUN_WHEN: Record<string, string> = {
  changed: 'when its output changes',
  nonzero: 'when it exits non-zero',
  zero: 'when it exits zero',
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

// WHEN an automation runs, as the tail of a sentence: «every 2h», «daily
// 09:00», «when its webhook is called», «checked every 5min with `curl …`,
// when its output changes». A cron reads through humanCron (cron-summary.ts),
// the same words the Automations page uses.
export function triggerWords(t: Trigger): string {
  switch (t.kind) {
    case 'cron':
      return `${humanCron(t.expr)}${t.tz ? ` (${t.tz})` : ''}`
    case 'period':
      return periodWords(t.period)
    case 'once':
      return onceWords(t.at)
    case 'webhook':
      return 'when its webhook is called'
    case 'files':
      return `when files matching ${t.glob} change in ${folderName(t.folder)}`
    case 'conversation':
      return t.when === 'finished' ? 'when a conversation finishes' : 'when a conversation needs you'
    case 'watch': {
      const check = t.check.type === 'command' ? `\`${cut(t.check.command, 60)}\`` : t.check.type === 'http' ? cut(t.check.url, 60) : cut(t.check.path, 60)
      const when = t.runWhen === 'matches' ? `when it matches /${t.pattern ?? ''}/` : (RUN_WHEN[t.runWhen] ?? `when ${t.runWhen}`)
      return `checked ${humanCron(t.every)} with ${check}, ${when}`
    }
    default:
      return ''
  }
}

// WHAT an automation runs, as the start of a clause: «runs `sync.py series`
// in finance» for a command, «a turn: “Check the disputes.”» for an agent turn.
// Takes the raw create body as well as a stored automation.
export function runWords(a: { prompt?: unknown; run?: unknown }): string {
  const run = a.run as { kind?: unknown; argv?: unknown; cwd?: unknown } | null | undefined
  if (run && run.kind === 'command' && Array.isArray(run.argv)) {
    const argv = run.argv.filter((x): x is string => typeof x === 'string')
    const cwd = typeof run.cwd === 'string' && run.cwd !== '' ? ` in ${folderName(run.cwd)}` : ''
    return `runs \`${argvShort(argv)}\`${cwd}`
  }
  const gist = typeof a.prompt === 'string' ? promptGist(a.prompt, 100) : ''
  return gist ? `a turn: “${gist}”` : 'a turn'
}

// the editor's one line → argv: split on whitespace, '…' and "…" keep their
// spaces, a backslash outside single quotes escapes the next character. No
// expansion of any kind: what you type is what runs.
export function parseArgvLine(line: string): { argv: string[] } | { error: string } {
  const out: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote === "'") {
      if (c === "'") quote = null
      else cur += c
      continue
    }
    if (c === '\\' && i + 1 < line.length) {
      cur += line[++i]!
      has = true
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      has = true
      continue
    }
    if (/\s/.test(c)) {
      if (has) {
        out.push(cur)
        cur = ''
        has = false
      }
      continue
    }
    cur += c
    has = true
  }
  if (quote) return { error: `a ${quote === '"' ? 'double' : 'single'} quote is never closed` }
  if (has) out.push(cur)
  if (out.length === 0) return { error: 'type the command to run' }
  if (out.some((x) => x === '')) return { error: 'an empty argument ("") can’t be run' }
  return { argv: out }
}
