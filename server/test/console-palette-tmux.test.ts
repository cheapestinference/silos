// console-palette-tmux.test.ts — end to end on a real tmux: a console born
// with a Silos skin gets its pane colours and passthrough in the creating
// call, and a TUI that asks for its palette the way OpenCode does inside
// tmux < 3.6 (OSC 4 wrapped in DCS passthrough) gets Silos' answer — with
// no browser attached at all.
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { TerminalService } from '../src/terminal-service.js'
import { CONSOLE_PALETTE, consoleSkinFor } from '../src/harnesses/opencode/console-theme.js'

// asks slots 5 and 6 after a TUI-like boot pause, writes what came back
const ASKER = `
import os, sys, select, termios, time, tty
out = sys.argv[1]
fd = sys.stdin.fileno(); tty.setraw(fd)
time.sleep(1.0)
q = b'\\x1b]4;5;?\\x07\\x1b]4;6;?\\x07'
os.write(1, b'\\x1bPtmux;' + q.replace(b'\\x1b', b'\\x1b\\x1b') + b'\\x1b\\\\')
got = b''; t = time.time()
while time.time() - t < 6 and got.count(b'rgb:') < 2:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r: got += os.read(fd, 4096)
open(out, 'wb').write(got)
time.sleep(30)
`

describe("a skinned console answers its TUI's palette question", () => {
  const socket = `silos-palette-${process.pid}`
  let terminals: TerminalService | undefined

  afterEach(async () => {
    terminals?.killAll()
    terminals?.stopReaper()
    try {
      execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' })
    } catch {
      /* no server */
    }
    try {
      rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, socket), { force: true })
    } catch {
      /* best effort */
    }
  })

  it("pane styled + passthrough on, and the DCS-wrapped OSC 4 question gets Silos' palette with its index", async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-pal-'))
    const folder = mkdtempSync(join(tmpdir(), 'deck-pal-folder-'))
    const index = claudeSessionIndex(join(base, 'projects'), join(base, 'cache.json'))
    const registry = new AgentRegistry(join(base, 'agents.json'))
    registry.load()
    registry.create({ id: 'oc', name: 'OC', folder })
    terminals = new TerminalService(registry, index, undefined, undefined, {
      tmuxSocket: socket,
      appendDir: join(base, 'append'),
      envDir: join(base, 'env'),
      sessionsDir: join(base, 'claude-sessions'),
    })
    const script = join(base, 'asker.py')
    const out = join(base, 'answer.bin')
    writeFileSync(script, ASKER)
    await terminals.ensureConsole({ cwd: folder, key: 'pal1', command: ['python3', '-I', script, out], skin: consoleSkinFor('light') })

    const name = 'silos-pal1'
    const opt = (args: string[]): string =>
      execFileSync('tmux', ['-L', socket, ...args])
        .toString()
        .trim()
    expect(opt(['show-options', '-w', '-v', '-t', name, 'window-style'])).toBe('bg=#faf9f5,fg=#141413')
    expect(opt(['show-options', '-p', '-v', '-t', name, 'allow-passthrough'])).toBe('on')

    const deadline = Date.now() + 10_000
    while (!existsSync(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    const got = readFileSync(out, 'utf8')
    const hex = (c: string): string =>
      c
        .slice(1)
        .replace(/../g, (h) => `${h}${h}`)
        .replace(/^(.{4})(.{4})(.{4})$/, '$1/$2/$3')
    expect(got).toContain(`\x1b]4;5;rgb:${hex(CONSOLE_PALETTE.light[5]!)}`)
    expect(got).toContain(`\x1b]4;6;rgb:${hex(CONSOLE_PALETTE.light[6]!)}`)
  }, 20_000)
})
