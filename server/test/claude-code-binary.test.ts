// claude-code-binary.test.ts — ONE Claude Code: the SDK runs
// the `claude` on PATH, the consoles' own — never the SDK's bundled
// binaries — and the SDK package names the release it is paired with.
import { describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { CLAUDE_MISSING, claudeOnPath, sdkPairing, withClaudeExecutable } from '../src/harnesses/claude-code/binary.js'

function bin(dir: string, name: string, exec = true): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, '#!/bin/sh\n')
  chmodSync(p, exec ? 0o755 : 0o644)
  return p
}

describe('claudeOnPath', () => {
  it('the first executable `claude` on PATH, as the PATH entry (a symlink is kept, never its realpath)', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-bin-'))
    bin(join(root, 'a'), 'claude', false) // not executable: skipped
    const real = bin(join(root, 'versions'), '2.1.319')
    mkdirSync(join(root, 'b'))
    symlinkSync(real, join(root, 'b', 'claude'))
    bin(join(root, 'c'), 'claude')
    const PATH = [join(root, 'missing'), join(root, 'a'), join(root, 'b'), join(root, 'c')].join(delimiter)
    expect(claudeOnPath(PATH)).toBe(join(root, 'b', 'claude'))
  })

  it('none on PATH → null; an explicit path is taken as is when executable', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-bin-'))
    expect(claudeOnPath(join(root, 'nothing'))).toBeNull()
    expect(claudeOnPath('', bin(root, 'claude'))).toBe(join(root, 'claude'))
    expect(claudeOnPath(undefined, join(root, 'nope'))).toBeNull()
  })
})

describe('withClaudeExecutable', () => {
  it('hands the SDK the PATH claude, or refuses in one line — never the bundled binary', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-bin-'))
    const saved = process.env.PATH
    try {
      process.env.PATH = join(root, 'empty')
      expect(() => withClaudeExecutable({ cwd: '/x' })).toThrow(CLAUDE_MISSING)
      bin(join(root, 'bin'), 'claude')
      process.env.PATH = join(root, 'bin')
      expect(withClaudeExecutable({ cwd: '/x' })).toEqual({ cwd: '/x', pathToClaudeCodeExecutable: join(root, 'bin', 'claude') })
    } finally {
      process.env.PATH = saved
    }
  })
})

describe('sdkPairing', () => {
  it('reads the installed SDK library version and the Claude Code release it is paired with (0.3.N ↔ 2.1.N)', () => {
    const p = sdkPairing()
    expect(p).not.toBeNull()
    expect(p!.library).toMatch(/^0\.3\.\d+$/)
    expect(p!.pairedWith).toMatch(/^2\.1\.\d+$/)
    expect(p!.library.split('.')[2]).toBe(p!.pairedWith.split('.')[2])
    expect(sdkPairing()).toBe(p) // read once
  })
})
