// spawn-errors.test.ts — every child process the server starts listens for
// 'error'. An unhandled 'error' event (the binary is missing: ENOENT) is an
// uncaughtException, and the server's handler exits: one `spawn('opencode')`
// on a machine without OpenCode took the whole server down (24-11, caught by
// the public CI, which has no OpenCode installed). node-pty's spawn is not
// an EventEmitter of that kind and is not covered here.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..', 'src')
// how far after the spawn line the handler may be wired
const WINDOW = 120

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []
  })
}

describe('child processes', () => {
  it("every spawn( in server/src handles 'error' — a missing binary never crashes the server", () => {
    const missing: string[] = []
    for (const f of files(ROOT)) {
      const lines = readFileSync(f, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/(^|[^.\w])spawn\(/.test(line)) return
        if (/^\s*(\/\/|\*)/.test(line)) return
        const window = lines.slice(i, i + WINDOW).join('\n')
        if (!/\.(on|once)\(\s*['"]error['"]/.test(window)) missing.push(`${relative(ROOT, f)}:${i + 1}`)
      })
    }
    expect(missing).toEqual([])
  })
})
