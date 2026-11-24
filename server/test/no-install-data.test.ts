// no-install-data.test.ts — Silos is a product for other operators, so its
// tests, its code, its plugin, its reference silos and its living docs speak
// generic data, with no trace of any one installation. This guard reads every
// tracked file in those places and
// fails on what only one installation would have: a real home path or a
// real email address, plus — when a maintainer keeps one — the patterns of
// internal/install-data.json (gitignored: its own names never ship). Examples
// use generic or invented names (finance, builder, writer, helpdesk, sam,
// kai, acme…).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../..')
const SELF = 'server/test/no-install-data.test.ts'

// Generic rules: what no installation-free file would carry.
// A home path under /home/<name>/ whose name is not an obvious placeholder.
const HOME_PLACEHOLDERS = new Set(['user', 'users', 'someone', 'other', 'silos', 'node', 'operator', 'owner', 'name', 'you', 'me', 'node_modules'])
// (and its projects-dir encoding, -home-<name>-)
const HOME_PATH = /(?<![\w.-])(?:\/home\/([a-z][a-z0-9_]{3,})\/|-home-([a-z][a-z0-9_]{3,})-)/g
// An email address on a domain that is not a placeholder: reserved TLDs and
// example domains (RFC 2606/6761), one- or two-letter labels (a@x.io) and
// test.dev are placeholders; Google's own signing identity is not a person.
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@((?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,})\b/g
const PLACEHOLDER_DOMAIN = /(^|\.)(example\.(com|org|net)|[^.]+\.(test|example|invalid|localhost)|test\.dev|[a-z0-9]{1,2}\.[a-z]{2,})$/i
const NOT_PEOPLE = new Set(['securetoken@system.gserviceaccount.com'])

type Rule = [string, (text: string) => string | null]
const firstMatch =
  (re: RegExp, keep: (m: RegExpExecArray) => boolean) =>
  (text: string): string | null => {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) if (keep(m)) return m[0]
    return null
  }
const GENERIC: Rule[] = [
  ['a real-looking home path', firstMatch(HOME_PATH, (m) => !HOME_PLACEHOLDERS.has((m[1] ?? m[2])!))],
  ['a real-looking email address', firstMatch(EMAIL, (m) => !PLACEHOLDER_DOMAIN.test(m[1]!) && !NOT_PEOPLE.has(m[0]))],
]

// One installation's own names (its agents, accounts, vendors…) are not
// shipped: a maintainer keeps them in the gitignored internal/install-data.json
// — { "patterns": [ "regex", … ] } or [{ "what", "pattern", "flags" }] —
// and this guard adds them when the file is there.
function installRules(): Rule[] {
  const file = join(ROOT, 'internal', 'install-data.json')
  if (!existsSync(file)) return []
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { patterns?: unknown }
  const list = Array.isArray(raw.patterns) ? raw.patterns : []
  return list.map((p): Rule => {
    const spec = typeof p === 'string' ? { what: 'installation data', pattern: p, flags: 'i' } : (p as { what?: string; pattern: string; flags?: string })
    const re = new RegExp(spec.pattern, spec.flags ?? 'i')
    return [spec.what ?? 'installation data', (text) => re.exec(text)?.[0] ?? null]
  })
}
const RULES: Rule[] = [...GENERIC, ...installRules()]

function tracked(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  return out.split('\0').filter((f) => f !== '' && f !== SELF)
}

const isTest = (f: string): boolean => /(^|\/)(test|e2e|fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(f)
// the product itself: its code, its plugins, its scripts, its reference
// silos, the living docs (top-level docs/*.md and the Silo Standard) and
// everything a visitor of the public repo reads first (root *.md, deploy
// guides, the image, .github)
const isProduct = (f: string): boolean =>
  /^(server\/src|web\/src|plugin|plugin-opencode|silos-id|scripts|docs\/standard\/reference|docs\/deploy|deploy|\.github)\//.test(f) ||
  /^[^/]+\.md$/.test(f) ||
  f === 'Dockerfile' ||
  /^docs\/[^/]+\.md$/.test(f) ||
  /^docs\/standard\/[^/]+\.(md|json)$/.test(f)

function textOf(file: string): string | null {
  const buf = readFileSync(join(ROOT, file))
  const raw = file.endsWith('.gz') ? gunzipSync(buf) : buf
  if (raw.includes(0)) return null // binary (a screenshot): nothing to read
  return raw.toString('utf8')
}

function hitsIn(files: string[]): string[] {
  const hits: string[] = []
  for (const f of files) {
    const text = textOf(f)
    if (text === null) continue
    for (const [what, find] of RULES) {
      const m = find(text)
      if (m !== null) hits.push(`${f}: ${what} («${m}»)`)
    }
  }
  return hits
}

describe('Silos carries no data from one installation', () => {
  it('no tracked test or fixture names a real home path, a real email or installation data', () => {
    const files = tracked().filter(isTest)
    expect(files.length).toBeGreaterThan(100) // the scan really ran over the suite
    expect(hitsIn(files)).toEqual([])
  })

  it('neither does the product: code, plugins, scripts, reference silos and the living docs', () => {
    const files = tracked().filter((f) => !isTest(f) && isProduct(f))
    expect(files.length).toBeGreaterThan(300)
    expect(hitsIn(files)).toEqual([])
  })
})
