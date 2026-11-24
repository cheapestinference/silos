import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry } from '../src/agent-registry.js'
import { ExecService } from '../src/exec-service.js'

let registry: AgentRegistry, exec: ExecService, folder: string
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'deck-'))
  folder = mkdtempSync(join(tmpdir(), 'deck-folder-'))
  registry = new AgentRegistry(join(base, 'agents.json'))
  registry.load()
  registry.create({ id: 'writer', name: 'Writer', folder })
  exec = new ExecService(registry)
})

describe('ExecService.run', () => {
  it("runs in the agent's folder and captures stdout", async () => {
    const r = await exec.run('writer', 'pwd && echo done')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(folder)
    expect(r.stdout).toContain('done')
    expect(r.truncated).toBe(false)
  })
  it('stderr and a nonzero exit code', async () => {
    const r = await exec.run('writer', 'echo bad >&2; exit 3')
    expect(r.code).toBe(3)
    expect(r.stderr.trim()).toBe('bad')
  })
  it('the child does not inherit CLAUDE* vars', async () => {
    process.env.CLAUDECODE_TEST_CANARY = '1' // not a real CLAUDE* var, but matches the filter's pattern
    const r = await exec.run('writer', 'env | grep -c "^CLAUDE" || true')
    expect(r.stdout.trim()).toBe('0')
  })
  it('the output cap sets truncated', async () => {
    const r = await exec.run('writer', 'yes x | head -c 300000')
    expect(r.truncated).toBe(true)
    expect(r.stdout.length).toBe(200_000)
  })
  it('guards: master, nonexistent, empty', async () => {
    await expect(exec.run('master', 'ls')).rejects.toThrow('master')
    await expect(exec.run('nobody', 'ls')).rejects.toThrow('not found')
    await expect(exec.run('writer', '   ')).rejects.toThrow('empty command')
  })
  it('closed stdin: cat exits instantly on EOF', async () => {
    const r = await exec.run('writer', 'cat; echo fin')
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('fin') // an open stdin would hang cat until the timeout killed it (code null, no «fin»)
  })
  it('a timeout kills the process', async () => {
    const fast = new ExecService(registry, 200)
    const r = await fast.run('writer', 'sleep 5; echo never')
    expect(r.code).toBeNull()
    expect(r.stdout).not.toContain('never')
  }, 10_000)
  it('a background child holding the stdout pipe open does not hang the response', async () => {
    const fast = new ExecService(registry, 300)
    const r = await fast.run('writer', 'sleep 30 & echo launched')
    // the shell's own exit answered (code 0), not the timeout's kill (code null),
    // and the 30 s child holding the pipe was not waited for (test timeout 10 s)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('launched')
  }, 10_000)
})
