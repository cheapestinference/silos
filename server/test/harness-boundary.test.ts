// harness-boundary.test.ts — the shape the Claude adapter relocation left
// behind, kept from regressing. An engine is one folder under
// server/src/harnesses/<id>/; the index that merges them names none; the
// Claude Agent SDK is imported only inside the Claude adapter; no adapter
// imports another (every ordered pair of folders under harnesses/); the
// registry (harnesses/registry.ts) is a leaf; only the composition root
// imports the registration list (harnesses/index.ts) and only an adapter's
// own folder imports its index.ts; no moved module comes back at the top
// level as a shim; and the engine ids spelled as literals outside harnesses/
// only shrink (the ratchet). Scope: server/src (and web/src for the
// ratchet) — tests may import whatever they need. Imports and literals are
// read from a real TypeScript parse (helpers/module-specifiers.ts), never a regex.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codeWords, moduleSpecifiers, runtimeImports, stringLiterals } from './helpers/module-specifiers.js'
import { fallbackHarness, harnessIds } from '../src/harnesses/index.js'

const SRC = new URL('../src/', import.meta.url).pathname
const HARNESSES = join(SRC, 'harnesses')
const WEB_SRC = new URL('../../web/src/', import.meta.url).pathname

// every engine folder under harnesses/ (read from disk, never a list)
const ADAPTERS = readdirSync(HARNESSES)
  .filter((n) => statSync(join(HARNESSES, n)).isDirectory())
  .sort()
const ORDERED_PAIRS = ADAPTERS.flatMap((from) => ADAPTERS.filter((to) => to !== from).map((to) => [from, to] as [string, string]))

// every module specifier a file names, read from a real parse (oxc via rolldown)
const specifiersOf = (file: string): string[] => moduleSpecifiers(readFileSync(file, 'utf8'), file)

function tsFilesUnder(dir: string, isSource: (name: string) => boolean = (n) => n.endsWith('.ts')): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...tsFilesUnder(p, isSource))
    else if (isSource(name)) out.push(p)
  }
  return out
}

// relative specifiers of `file` resolved to absolute paths
function resolvedImports(file: string): string[] {
  return specifiersOf(file)
    .filter((s) => s.startsWith('.'))
    .map((s) => resolve(dirname(file), s))
}

// The runtime module graph of server/src: an edge per relative import a
// module evaluates (runtimeImports), `.js` specifiers resolved to their `.ts`
// source. Every cycle is returned as its path, first module repeated last.
function runtimeCycles(): string[][] {
  const files = tsFilesUnder(SRC)
  const known = new Set(files)
  const edges = new Map<string, string[]>()
  for (const f of files) {
    const to = runtimeImports(readFileSync(f, 'utf8'), f)
      .filter((s) => s.startsWith('.'))
      .map((s) => resolve(dirname(f), s).replace(/\.js$/, '.ts'))
      .filter((t) => known.has(t))
    edges.set(f, to)
  }
  const cycles: string[][] = []
  const state = new Map<string, 'open' | 'done'>()
  const stack: string[] = []
  const visit = (f: string): void => {
    state.set(f, 'open')
    stack.push(f)
    for (const t of edges.get(f) ?? []) {
      if (state.get(t) === 'open') cycles.push([...stack.slice(stack.indexOf(t)), t].map((x) => x.slice(SRC.length)))
      else if (!state.has(t)) visit(t)
    }
    stack.pop()
    state.set(f, 'done')
  }
  for (const f of files) if (!state.has(f)) visit(f)
  return cycles
}

describe('harness boundary', () => {
  it('session-index.ts names no engine: no claude, anthropic or .jsonl', () => {
    const src = readFileSync(join(SRC, 'session-index.ts'), 'utf8')
    expect(src).not.toMatch(/claude|anthropic|\.jsonl/i)
  })

  it('no server/src file outside harnesses/claude-code/ imports @anthropic-ai/claude-agent-sdk', () => {
    const adapter = join(HARNESSES, 'claude-code') + sep
    const offenders = tsFilesUnder(SRC)
      .filter((f) => !f.startsWith(adapter))
      .filter((f) => specifiersOf(f).some((s) => s === '@anthropic-ai/claude-agent-sdk' || s.startsWith('@anthropic-ai/claude-agent-sdk/')))
      .map((f) => f.slice(SRC.length))
    expect(offenders).toEqual([])
  })

  it('every engine folder under harnesses/ is read from disk', () => {
    expect(ADAPTERS).toEqual(expect.arrayContaining(['claude-code', 'opencode']))
    expect(ORDERED_PAIRS).toHaveLength(ADAPTERS.length * (ADAPTERS.length - 1))
  })

  it.each(ORDERED_PAIRS)('nothing under harnesses/%s/ imports from harnesses/%s/', (from, to) => {
    const forbidden = join(HARNESSES, to) + sep
    const offenders: string[] = []
    for (const f of tsFilesUnder(join(HARNESSES, from))) {
      for (const target of resolvedImports(f)) {
        if (target.startsWith(forbidden)) offenders.push(`${f.slice(SRC.length)} → ${target.slice(SRC.length)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  // the 14 modules that moved wholesale into harnesses/claude-code/ (plan
  // inventory "C: moves wholesale"), under their OLD top-level names
  const MOVED = [
    'parser.ts',
    'context.ts',
    'model-prices.ts',
    'media.ts',
    'search.ts',
    'watcher.ts',
    'claude-binary.ts',
    'claude-settings.ts',
    'account.ts',
    'accounts.ts',
    'account-load.ts',
    'session-holders.ts',
    'peer-registry.ts',
    'sdk.ts',
  ]
  it('none of the 14 moved modules exists again at the server/src top level (no shims)', () => {
    expect(MOVED).toHaveLength(14)
    expect(MOVED.filter((n) => existsSync(join(SRC, n)))).toEqual([])
  })

  it('server/src has no runtime import cycle (type-only imports excluded)', () => {
    expect(runtimeCycles()).toEqual([])
  })

  it('runtimeImports keeps what is evaluated and drops what is erased', () => {
    const code = [
      "import type { A } from './a.js'",
      "import { type B } from './b.js'",
      "import { type C, D } from './c.js'",
      "export type { E } from './e.js'",
      "export { F } from './f.js'",
      "export * from './g.js'",
      "import './h.js'",
      "const lazy = () => import('./i.js')",
      'export { lazy }',
    ].join('\n')
    expect(runtimeImports(code)).toEqual(['./c.js', './f.js', './g.js', './h.js'])
  })

  it('harnesses/registry.ts is a leaf: it imports nothing at runtime (types only)', () => {
    const file = join(HARNESSES, 'registry.ts')
    expect(runtimeImports(readFileSync(file, 'utf8'), file)).toEqual([])
  })

  // the two programs this tree builds: the server, and the packaged
  // command's subcommands (`silos doctor` reads the engines' verdicts)
  it('only the program entries (index.ts, cli/main.ts) import the registration list harnesses/index.ts', () => {
    const list = join(HARNESSES, 'index.js')
    const entries = [join(SRC, 'index.ts'), join(SRC, 'cli', 'main.ts')]
    const offenders = tsFilesUnder(SRC)
      .filter((f) => !entries.includes(f))
      .filter((f) => resolvedImports(f).includes(list))
      .map((f) => f.slice(SRC.length))
    expect(offenders).toEqual([])
    expect(resolvedImports(join(SRC, 'index.ts'))).toContain(list)
  })

  // the registration list (harnesses/index.ts) is the one module that names
  // every adapter's index.ts — that is its job
  it.each(ADAPTERS)('only modules under harnesses/%s/ (and the registration list) import its index.ts', (id) => {
    const own = join(HARNESSES, id) + sep
    const target = join(HARNESSES, id, 'index.js')
    const offenders = tsFilesUnder(SRC)
      .filter((f) => !f.startsWith(own) && f !== join(HARNESSES, 'index.ts'))
      .filter((f) => resolvedImports(f).includes(target))
      .map((f) => f.slice(SRC.length))
    expect(offenders).toEqual([])
  })

  // The literal ratchet: a built-in engine id spelled as a string literal
  // outside harnesses/ is a seam not yet behind the registry. The offender
  // FILE set must equal ALLOW exactly — a new offender fails, and so does a
  // file that stopped offending but is still listed. (The harness-seam plan
  // emptied its PENDING list file by file; Task 14 removed the last two and
  // the constant with them.)
  // (empty since the Map's Wiring graph retired, 21-11: its Claude-named
  // sources were the last offenders)
  const ALLOW = new Set<string>([])
  it('engine ids spelled as literals outside harnesses/ are exactly ALLOW (the ratchet)', () => {
    const ids = new Set(harnessIds())
    expect([...ids]).toEqual(expect.arrayContaining(['claude-code', 'opencode']))
    const spells = (f: string): boolean => stringLiterals(readFileSync(f, 'utf8'), f).some((v) => ids.has(v))
    const server = tsFilesUnder(SRC)
      .filter((f) => !f.startsWith(HARNESSES + sep))
      .filter(spells)
      .map((f) => `server:${f.slice(SRC.length)}`)
    const web = tsFilesUnder(WEB_SRC, (n) => /\.tsx?$/.test(n) && !/\.test\./.test(n))
      .filter(spells)
      .map((f) => `web:${f.slice(WEB_SRC.length)}`)
    expect([...server, ...web].sort()).toEqual([...ALLOW].sort())
  })

  // The web's one copy of the engine ids is its seed (lib/harnesses.seed.json,
  // the server's /api/harnesses answer for the built-in engines). It is read
  // as JSON (JSON.parse, every string value), never scanned as text; the TS
  // and TSX sources go through the parser above. Any other kind of file under
  // web/src fails here until someone decides how it is read.
  it('the seed is the only web/src file outside tests that names a built-in id', () => {
    const ids = new Set(harnessIds())
    const NOT_CODE = new Set(['.css']) // stylesheets: no engine facts
    const stringsOf = (v: unknown): string[] =>
      typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(stringsOf) : v !== null && typeof v === 'object' ? Object.values(v).flatMap(stringsOf) : []
    const all = tsFilesUnder(WEB_SRC, () => true).filter((f) => !/\.test\./.test(f))
    const ext = (f: string): string => f.slice(f.lastIndexOf('.'))
    expect(all.map(ext).filter((e) => !['.ts', '.tsx', '.json'].includes(e) && !NOT_CODE.has(e))).toEqual([])
    const offenders = all
      .filter((f) => !NOT_CODE.has(ext(f)))
      .filter((f) => (ext(f) === '.json' ? stringsOf(JSON.parse(readFileSync(f, 'utf8'))) : stringLiterals(readFileSync(f, 'utf8'), f)).some((v) => ids.has(v)))
      .map((f) => f.slice(WEB_SRC.length))
    expect(offenders).toEqual(['lib/harnesses.seed.json'])
    // and it names the built-in engines, as ids
    const seed = JSON.parse(readFileSync(join(WEB_SRC, 'lib', 'harnesses.seed.json'), 'utf8')) as { harnesses: Array<{ id: string }> }
    // — at least those: a third engine need not be in the seed, the live list brings it
    expect(seed.harnesses.map((h) => h.id)).toEqual(expect.arrayContaining(['claude-code', 'opencode']))
  })

  // The engine-NAME ratchet (stricter than the id one above): outside its own
  // folder, no code word — identifier, string, template chunk, JSX text;
  // comments are free — names a non-fallback engine (its folder id, any
  // case, dashes optional: `opencode`, `OpenCode`, `opencodeModelId`). What
  // such code knows belongs in the engine's folder or behind a Harness member
  // / descriptor fact. The fallback is exempt: Claude-named features
  // (accounts, titler, settings) are features built on Claude Code
  // (docs/harnesses.md "Still outside the folders").
  const NAME_ALLOW = new Set([
    // the registration list imports and registers every engine — its job
    'server:harnesses/index.ts',
  ])
  it('no code outside an engine folder names a non-fallback engine (the name ratchet)', () => {
    const fallback = fallbackHarness().id
    const engines = ADAPTERS.filter((id) => id !== fallback)
    expect(engines).toContain('opencode')
    const offenders: string[] = []
    for (const id of engines) {
      const re = new RegExp(id.split('-').join('-?'), 'i')
      const own = join(HARNESSES, id) + sep
      const names = (f: string): boolean => codeWords(readFileSync(f, 'utf8'), f).some((w) => re.test(w))
      for (const f of tsFilesUnder(SRC)
        .filter((x) => !x.startsWith(own))
        .filter(names))
        offenders.push(`server:${f.slice(SRC.length)}`)
      for (const f of tsFilesUnder(WEB_SRC, (n) => /\.tsx?$/.test(n) && !/\.test\./.test(n)).filter(names)) offenders.push(`web:${f.slice(WEB_SRC.length)}`)
    }
    expect([...new Set(offenders)].sort()).toEqual([...NAME_ALLOW].sort())
  })

  it('codeWords reads identifiers, strings, template chunks and JSX text, never comments (guards the name ratchet)', () => {
    const ts = [
      '// opencode in a comment',
      '/* OpenCode in a block comment */',
      'const opencodeModelId = 1',
      'const t = `x${1}OpenCode`',
      "const u = 'open code'",
    ].join('\n')
    expect(codeWords(ts, 'a.ts').filter((w) => /opencode/i.test(w))).toEqual(['opencodeModelId', 'OpenCode'])
    const tsx = 'export const C = () => <p>{n} OpenCode conversations</p>'
    expect(codeWords(tsx, 'c.tsx').filter((w) => /opencode/i.test(w))).toEqual([' OpenCode conversations'])
  })

  it('stringLiterals sees literal types and JSX attributes, never comments or JSX text (guards the ratchet)', () => {
    const ts = [
      '// opencode in a comment',
      "/* 'opencode' in a block comment */",
      "type F = 'claude-code' | 'opencode'",
      'const t = `opencode`',
      'const u = `x${1}opencode`',
    ].join('\n')
    expect(stringLiterals(ts, 'a.ts')).toEqual(['claude-code', 'opencode', 'opencode'])
    const tsx = ['// opencode', 'export const C = () => <Chip framework="opencode">opencode runs here</Chip>'].join('\n')
    expect(stringLiterals(tsx, 'c.tsx')).toEqual(['opencode'])
  })

  it('the parser sees real imports (guards the test itself)', () => {
    expect(specifiersOf(join(SRC, 'session-index.ts'))).toContain('./harnesses/contract.js')
    expect(specifiersOf(join(HARNESSES, 'claude-code', 'sdk.ts'))).toContain('@anthropic-ai/claude-agent-sdk')
    expect(resolvedImports(join(HARNESSES, 'claude-code', 'reader.ts'))).toContain(join(HARNESSES, 'registry.js'))
    // both sit behind a `/*` inside a `//` comment — the comment-stripping scan missed them
    expect(specifiersOf(join(SRC, 'plans-floor.ts'))).toContain('node:fs')
    expect(resolvedImports(join(HARNESSES, 'opencode', 'fence.ts'))).toContain(join(SRC, 'territory.js'))
  })

  it('the parser is not fooled by comments, strings, templates or regex literals', () => {
    const code = [
      '// plans/*.plan.json',
      "import { a } from './a.js'",
      "const u = 'http://x' ; import b from './b.js'",
      "const t = `x ${ {k: 1}.k } y ${ `n ${1}` } import c from './fake.js'`",
      "const r = /'\\/*import x from 'z'/g",
      "import type { T } from './t.js'",
      "export * from './star.js'",
      "export { q } from './q.js'",
      "export type { Q } from './qt.js'",
      'export const z = 1',
      "type M = typeof import('./typed.js')",
      "const m = await import('./dyn.js')",
      "import './side.js'",
      'const p = import.meta.url',
      "/* import nope from './nope.js' */",
      "const d = a / b / c; import e from './e.js'",
      // a local export (no from, no semicolon) must not swallow what follows
      'export { a }',
      "const s1 = await import('@sdk-after-export')",
      'export type { A }',
      "const g = () => import('@sdk-after-export-type')",
      // a statement-start regex after a block holds a backtick: no fake template
      'function f() {}',
      "/`/.test('x'); const w = import('./w.js')",
      "import x2 = require('./req.js')",
      // a backtick specifier with no ${} is a static specifier too
      'const t2 = await import(`@tpl`)',
      'const t3 = import(`./dyn-${name}.js`)',
    ].join('\n')
    expect(moduleSpecifiers(code)).toEqual([
      './a.js',
      './b.js',
      './t.js',
      './star.js',
      './q.js',
      './qt.js',
      './typed.js',
      './dyn.js',
      './side.js',
      './e.js',
      '@sdk-after-export',
      '@sdk-after-export-type',
      './w.js',
      './req.js',
      '@tpl',
    ])
  })

  it('a file that does not parse fails the check, never reads as "no imports"', () => {
    expect(() => moduleSpecifiers("import { a from './a.js'", 'broken.ts')).toThrow(/broken\.ts does not parse/)
  })
})
