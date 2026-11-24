// pack-npm.test.ts — the pack-npm smoke. scripts/pack-npm.mjs assembles the ONE publishable
// package — `silosplatform`, installed command `silos` (r5 #181) — from the
// repo's runtime layout. The smoke packs a copy of this tree's runtime
// parts with stand-in builds (never rebuilding the real web/dist, which is
// what the owner's server serves) and checks what an operator's
// `npx silosplatform` would receive: the name, the command, the Node floor,
// the server's dependencies and nothing private, every runtime path the
// server resolves from its own files, and a command that answers.
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO, 'scripts', 'pack-npm.mjs')

let pkgDir = ''
let tarball = ''
let listing: string[] = []

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'silos-pack-'))
  const root = join(base, 'tree')
  const out = join(base, 'out')
  mkdirSync(root)
  // the runtime parts as they are in the repo; builds are stand-ins
  for (const rel of [
    'package.json',
    'server/package.json',
    'plugin',
    'plugin-opencode/silos.ts',
    'plugin-opencode/package.json',
    'plugin-opencode/README.md',
    'docs/standard',
    'LICENSE',
    'README.md',
  ]) {
    cpSync(join(REPO, rel), join(root, rel), { recursive: true })
  }
  mkdirSync(join(root, 'server', 'dist'), { recursive: true })
  writeFileSync(join(root, 'server', 'dist', 'index.js'), "console.log('stand-in server', JSON.stringify(process.argv.slice(2)))\n")
  mkdirSync(join(root, 'server', 'dist', 'cli'), { recursive: true })
  writeFileSync(
    join(root, 'server', 'dist', 'cli', 'main.js'),
    "export async function main(argv) { console.log('stand-in cli', JSON.stringify(argv)); return 3 }\n",
  )
  mkdirSync(join(root, 'web', 'dist'), { recursive: true })
  writeFileSync(join(root, 'web', 'dist', 'index.html'), '<!doctype html><title>Silos</title>\n')
  // npm pack under a throwaway HOME/cache: no user config, no network
  const home = join(base, 'home')
  mkdirSync(home)
  const env = { ...process.env, HOME: home, npm_config_cache: join(home, '.npm'), npm_config_userconfig: join(home, '.npmrc'), npm_config_offline: 'true' }
  execFileSync(process.execPath, [SCRIPT, '--no-build', '--root', root, '--out', out], { env, stdio: 'pipe' })
  const tgz = readdirSync(out).filter((f) => f.endsWith('.tgz'))
  expect(tgz).toHaveLength(1)
  tarball = join(out, tgz[0]!)
  const x = join(base, 'x')
  mkdirSync(x)
  execFileSync('tar', ['-xzf', tarball, '-C', x])
  pkgDir = join(x, 'package')
  // a stand-in terminal module, as an install with a working toolchain has it
  mkdirSync(join(pkgDir, 'node_modules', 'node-pty'), { recursive: true })
  writeFileSync(join(pkgDir, 'node_modules', 'node-pty', 'package.json'), '{"name":"node-pty","main":"index.js"}\n')
  writeFileSync(join(pkgDir, 'node_modules', 'node-pty', 'index.js'), 'module.exports = {}\n')
  listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((l) => l.replace(/^package\//, ''))
}, 120_000)

describe('pack-npm smoke', () => {
  it('is silosplatform with the command silos, Node ≥ 22.13, the server’s dependencies and nothing private', () => {
    expect(tarball).toMatch(/silosplatform-\d+\.\d+\.\d+\.tgz$/)
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Record<string, unknown>
    const serverPkg = JSON.parse(readFileSync(join(REPO, 'server', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(pkg.name).toBe('silosplatform')
    expect(pkg.bin).toEqual({ silos: 'bin/silos.mjs' })
    expect(pkg.engines).toEqual({ node: '>=22.13' })
    // node-pty rides as optional (a failed native build must not abort the install); together they are the server's
    const { 'node-pty': pty, ...rest } = serverPkg.dependencies
    expect(pkg.dependencies).toEqual(rest)
    expect(pkg.optionalDependencies).toEqual({ 'node-pty': pty })
    expect(pkg.private).toBeUndefined()
    expect(pkg.devDependencies).toBeUndefined()
    expect(pkg.scripts).toBeUndefined()
  })

  it('carries every runtime path the server resolves from its own files, and no source or tests', () => {
    for (const need of ['bin/silos.mjs', 'server/dist/index.js', 'web/dist/index.html', 'plugin-opencode/silos.ts', 'LICENSE', 'README.md'])
      expect(listing).toContain(need)
    for (const dir of ['plugin/', 'docs/standard/']) expect(listing.some((p) => p.startsWith(dir))).toBe(true)
    expect(listing.some((p) => p.startsWith('server/src/') || p.startsWith('web/src/') || p.includes('/test/') || p.startsWith('node_modules/'))).toBe(false)
  })

  it('the command answers: help names --no-open, version is the package’s, start asks the server to open the browser', () => {
    const bin = join(pkgDir, 'bin', 'silos.mjs')
    expect(existsSync(bin)).toBe(true)
    const help = execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' })
    expect(help).toContain('--no-open')
    const version = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim()
    expect(version).toBe((JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string }).version)
    // the stand-in server prints the argv it got
    expect(execFileSync(process.execPath, [bin], { encoding: 'utf8' })).toContain('["--open"]')
    expect(execFileSync(process.execPath, [bin, '--no-open'], { encoding: 'utf8' })).toContain('["--no-open"]')
  })

  it('a subcommand goes to the cli with its arguments and exits with its code; an unknown word never starts the server', () => {
    const bin = join(pkgDir, 'bin', 'silos.mjs')
    for (const args of [['doctor'], ['service', 'install'], ['update', '--check'], ['uninstall']]) {
      const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })
      expect(r.stdout).toContain(`stand-in cli ${JSON.stringify(args)}`)
      expect(r.stdout).not.toContain('stand-in server')
      expect(r.status).toBe(3)
    }
    // without the terminal module the server never starts, and the message names the fix
    rmSync(join(pkgDir, 'node_modules', 'node-pty'), { recursive: true })
    const noPty = spawnSync(process.execPath, [bin], { encoding: 'utf8' })
    expect(noPty.status).toBe(1)
    expect(noPty.stdout).not.toContain('stand-in server')
    expect(noPty.stderr).toContain('build-essential')
    const typo = spawnSync(process.execPath, [bin, 'docter'], { encoding: 'utf8' })
    expect(typo.status).toBe(1)
    expect(typo.stdout).not.toContain('stand-in server')
    expect(typo.stderr).toContain('docter')
  })
})
