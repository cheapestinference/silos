// processes.ts — a conversation's processes as the web says them (the
// System silo's kernel kind `process`, server silos/processes.ts). The
// column's Processes block and the delete confirmation read the same
// route (api.processes) and say each process the same way.
import type { ConversationProcess } from './types'

// the built-in silo that lists them, and its one kernel-verb (catalogs.md
// «Kernel-verbs»): the column's door and Stop name them, like PLANS_SILO
export const SYSTEM_SILO = 'system'
export const STOP_PROCESS = 'stop-process'

const INTERPRETERS = new Set([
  'node',
  'nodejs',
  'python',
  'python3',
  'bun',
  'deno',
  'tsx',
  'ts-node',
  'sh',
  'bash',
  'zsh',
  'ruby',
  'perl',
  'php',
  'java',
  'uv',
  'npx',
  'pnpx',
  'bunx',
  'exec',
  'env',
  'nohup',
  'setsid',
])
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'make', 'cargo', 'go', 'uv'])
const base = (t: string): string => t.slice(t.lastIndexOf('/') + 1)

// A process in two or three words, as the owner would name it: the program
// it really is (past the interpreter: `node …/vite --port 5193` → «vite»,
// `python3 -m http.server 4391` → «http.server»), a package script whole
// («npm run dev»). Never longer than the command.
export function processName(command: string): string {
  const toks = command
    .trim()
    .split(/\s+/)
    .filter((t) => t !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t))
  if (toks.length === 0) return command.trim()
  let i = 0
  while (i < toks.length && INTERPRETERS.has(base(toks[i]!))) {
    i++
    // the interpreter's own flags; `-m module` names the program
    while (i < toks.length && toks[i]!.startsWith('-')) {
      if (toks[i] === '-m' && i + 1 < toks.length) return toks[i + 1]!
      i++
    }
  }
  if (i >= toks.length) return base(toks[0]!)
  const prog = base(toks[i]!)
  // a runner's script: «npm run dev», «cargo watch», «make serve»
  if (RUNNERS.has(prog) && i + 1 < toks.length && !toks[i + 1]!.startsWith('-')) {
    const sub = toks[i + 1]!
    const third = (sub === 'run' || sub === 'exec') && i + 2 < toks.length && !toks[i + 2]!.startsWith('-') ? ` ${toks[i + 2]}` : ''
    return `${prog} ${sub}${third}`
  }
  return prog.replace(/\.(m?js|cjs|ts)$/, '')
}

// its ports, as they are said beside a name: «:5193», «:5193 :5194»
export function portsWords(ports: string | undefined): string {
  return (ports ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((p) => `:${p}`)
    .join(' ')
}

// «vite :5193» — the delete confirmation's list
export function processLabel(p: Pick<ConversationProcess, 'command' | 'ports'>): string {
  const ports = portsWords(p.ports)
  return ports ? `${processName(p.command)} ${ports}` : processName(p.command)
}

// A long line cut in the MIDDLE: the head may ellipsize, the tail stays —
// the end of a command is often the telling part (`--port 5180`). The tail
// is the last word(s), at most `max` characters; a short text, or one whose
// last word is longer than that, is not split (tail '').
export function splitTail(text: string, max = 24, min = 40): { head: string; tail: string } {
  if (text.length <= min) return { head: text, tail: '' }
  let cut = text.length
  for (let i = text.length - 1; i > 0; i--) {
    if (text[i] === ' ') {
      if (text.length - i - 1 > max) break
      cut = i
    }
  }
  if (cut >= text.length || cut <= 0) return { head: text, tail: '' }
  return { head: text.slice(0, cut), tail: text.slice(cut + 1) }
}

// one row's facts, in the column's mono voice: ports · CPU · memory (the
// tree's size rides the row's title — the column has no room for it)
export function processFacts(p: Pick<ConversationProcess, 'ports' | 'cpu' | 'memoryMb'>): string[] {
  const out: string[] = []
  const ports = portsWords(p.ports)
  if (ports) out.push(ports)
  if (typeof p.cpu === 'number') out.push(`${p.cpu < 10 ? p.cpu.toFixed(1) : Math.round(p.cpu)}% CPU`)
  if (typeof p.memoryMb === 'number') out.push(p.memoryMb >= 1024 ? `${(p.memoryMb / 1024).toFixed(1)} GB` : `${Math.round(p.memoryMb)} MB`)
  return out
}
