// What the plugin's hooks and skills run, the places that install or
// promise it must name (once the image lacked python3 and jq, so the
// briefing printed nothing and the cron gate allowed everything there, and
// the README's prerequisites omitted python3 and curl). The tools are read
// from the plugin itself, so a hook that starts using one more fails here
// until the image and the docs say it too.
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const TOOLS = ['python3', 'curl', 'jq'] as const

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) out.push(...filesUnder(p))
    else if (/\.(sh|py|md)$/.test(n)) out.push(p)
  }
  return out
}

const used = (): string[] => {
  const text = [...filesUnder(join(ROOT, 'plugin', 'hooks')), ...filesUnder(join(ROOT, 'plugin', 'skills')), ...filesUnder(join(ROOT, 'plugin', 'context'))]
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')
  return TOOLS.filter((t) => new RegExp(`(^|[\\s"'(|$])${t}\\b`, 'm').test(text))
}

describe("the plugin's tools are installed and documented", () => {
  it('the plugin really uses each of them (the list is not stale)', () => {
    expect(used()).toEqual([...TOOLS])
  })
  it('the runtime image installs every one', () => {
    const docker = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
    const runtime = docker.slice(docker.lastIndexOf('\nFROM '))
    for (const t of used()) expect(runtime, t).toMatch(new RegExp(`apt-get install[^\\n]*\\n?[^\\n]*\\b${t}\\b`))
  })
  it('the README lists every one', () => {
    for (const doc of ['README.md']) {
      const text = readFileSync(join(ROOT, doc), 'utf8')
      for (const t of used()) expect(text, `${doc}: ${t}`).toMatch(new RegExp(`\\b${t}\\b`))
    }
  })
})

// Whatever is missing, a hook never blocks the session: it says which tool
// in ONE stderr line and exits 0 (pre-cron.sh's half: pre-cron-hook.test.ts).
describe('session-start.sh — a tool it needs is missing: one line on stderr, exit 0', () => {
  const HOOK = join(ROOT, 'plugin', 'hooks', 'session-start.sh')
  // a PATH holding only the named tools, linked from this machine's PATH
  function pathWith(tools: string[]): string {
    const bin = mkdtempSync(join(tmpdir(), 'deck-bin-'))
    for (const t of tools) {
      const dir = (process.env.PATH ?? '').split(':').find((d) => d !== '' && existsSync(join(d, t)))
      if (dir !== undefined) symlinkSync(join(dir, t), join(bin, t))
    }
    return bin
  }
  const run = (tools: string[]) => {
    const home = mkdtempSync(join(tmpdir(), 'deck-home-'))
    const r = spawnSync('/bin/sh', [HOOK], {
      // nothing listens on :9 — Silos «not running»; an empty HOME (no agents.json)
      env: { PATH: pathWith(tools), HOME: home, SILOS_API: 'http://127.0.0.1:9', CLAUDE_PROJECT_DIR: home },
      input: JSON.stringify({ source: 'startup', session_id: 's-1' }),
      encoding: 'utf8',
      timeout: 20_000,
    })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  }
  const BASE = ['dirname', 'basename', 'sed', 'cat']
  it('without python3: nothing on stdout (never malformed JSON), the line names python3', () => {
    const r = run([...BASE, 'curl'])
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr.trim().split('\n')).toHaveLength(1)
    expect(r.stderr).toMatch(/python3 is not installed/)
  })
  // the hook asks the server in Python (silos_http.py): curl is the
  // recipes' tool, never the hook's
  it('without curl: the briefing still arrives and nothing is missing', () => {
    const r = run([...BASE, 'python3'])
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(out.hookSpecificOutput.additionalContext.length).toBeGreaterThan(0)
    expect(r.stderr).toBe('')
  })
  it('with every tool: nothing on stderr', () => {
    const r = run([...BASE, 'python3', 'curl'])
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })
})
